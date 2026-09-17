/** Physical-scope Workspace writer fencing. */
import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import {
  type WorkspaceWriteLock,
  type WorkspaceWriteLockState,
  workspaceWriteLock,
} from "@/lib/persistence/schema/workspace-lock";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

export class WorkspaceWriterConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceWriterNotFenced";
  }
}

export interface AcquireWorkspaceWriteLockParams {
  tenantId: string;
  storageScopeDigest: string;
  invocationId: string;
  attemptId: string;
  ownershipId: string;
  workspaceBindingId: string;
  leaseExpiresAt: Date;
  backendGrantRef?: string | null;
  backendEvidence?: unknown;
  /**
   * 稳定 Backend operationId：同一次逻辑激活的所有重试共用它。
   * 事务外 Backend 已成功但 DB 确认失败时，靠它查回既有回执而不是重复开 Writer。
   */
  backendOperationId?: string | null;
  /** Backend 实际回执（真实旧 Writer 停止/排空证据）。 */
  backendReceipt?: unknown;
}

export interface AcquireWorkspaceWriteLockResult {
  lock: WorkspaceWriteLock;
  writerGeneration: number;
}

function activeStates() {
  return inArray(workspaceWriteLock.lockState, ["reserved", "active"] as WorkspaceWriteLockState[]);
}

export async function reserveWorkspaceWriter(
  input: AcquireWorkspaceWriteLockParams,
  executor: DbOrTx = db,
): Promise<AcquireWorkspaceWriteLockResult> {
  const [current] = await executor
    .select()
    .from(workspaceWriteLock)
    .where(
      and(
        eq(workspaceWriteLock.tenantId, input.tenantId),
        eq(workspaceWriteLock.storageScopeDigest, input.storageScopeDigest),
      ),
    )
    .for("update")
    .limit(1);
  if (current && (current.lockState === "reserved" || current.lockState === "active")) {
    const notExpired = !current.leaseExpiresAt || current.leaseExpiresAt > new Date();
    if (notExpired) {
      // 同一 holder tuple 的重复预留是幂等重放：返回同一 lock 与同一 generation，
      // 既不允许第二个 Writer，也不因为一次响应丢失就切走 generation。
      const sameHolder =
        current.holderInvocationId === input.invocationId &&
        current.holderAttemptId === input.attemptId &&
        current.holderOwnershipId === input.ownershipId &&
        current.workspaceBindingId === input.workspaceBindingId;
      if (sameHolder) return { lock: current, writerGeneration: current.writerGeneration };
      throw new WorkspaceWriterConflictError("Workspace writer 已被其他 Invocation 占用");
    }
  }
  const now = new Date();
  const writerGeneration = (current?.writerGeneration ?? 0) + 1;
  const id = current?.id ?? randomUUID();
  if (current) {
    await executor
      .update(workspaceWriteLock)
      .set({
        writerGeneration,
        lockState: "reserved",
        holderInvocationId: input.invocationId,
        holderAttemptId: input.attemptId,
        holderOwnershipId: input.ownershipId,
        workspaceBindingId: input.workspaceBindingId,
        backendGrantRef: input.backendGrantRef ?? null,
        backendEvidence: input.backendEvidence ?? null,
        backendOperationId: input.backendOperationId ?? null,
        backendReceipt: input.backendReceipt ?? null,
        leaseExpiresAt: input.leaseExpiresAt,
        releaseReasonCode: null,
        versionNo: current.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(workspaceWriteLock.id, current.id));
  } else {
    await executor.insert(workspaceWriteLock).values({
      id,
      tenantId: input.tenantId,
      storageScopeDigest: input.storageScopeDigest,
      writerGeneration,
      lockState: "reserved",
      holderInvocationId: input.invocationId,
      holderAttemptId: input.attemptId,
      holderOwnershipId: input.ownershipId,
      workspaceBindingId: input.workspaceBindingId,
      backendGrantRef: input.backendGrantRef ?? null,
      backendEvidence: input.backendEvidence ?? null,
      backendOperationId: input.backendOperationId ?? null,
      backendReceipt: input.backendReceipt ?? null,
      leaseExpiresAt: input.leaseExpiresAt,
      releaseReasonCode: null,
      versionNo: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  const [lock] = await executor
    .select()
    .from(workspaceWriteLock)
    .where(eq(workspaceWriteLock.id, id))
    .limit(1);
  if (!lock) throw new WorkspaceWriterConflictError("Workspace writer 预留后回查失败");
  return { lock, writerGeneration };
}

export async function activateWorkspaceWriter(
  input: {
    tenantId: string;
    lockId: string;
    ownershipId: string;
    writerGeneration: number;
    backendGrantRef: string;
    backendEvidence?: unknown;
    /** 与预留阶段一致的稳定 Backend operationId。 */
    backendOperationId?: string | null;
    /** Backend 实际回执。 */
    backendReceipt?: unknown;
  },
  executor: DbOrTx = db,
): Promise<WorkspaceWriteLock> {
  const [lock] = await executor
    .select()
    .from(workspaceWriteLock)
    .where(
      and(eq(workspaceWriteLock.tenantId, input.tenantId), eq(workspaceWriteLock.id, input.lockId)),
    )
    .for("update")
    .limit(1);
  if (
    !lock ||
    lock.lockState !== "reserved" ||
    lock.holderOwnershipId !== input.ownershipId ||
    lock.writerGeneration !== input.writerGeneration
  ) {
    throw new WorkspaceWriterConflictError("Workspace writer 预留不匹配");
  }
  const now = new Date();
  await executor
    .update(workspaceWriteLock)
    .set({
      lockState: "active",
      backendGrantRef: input.backendGrantRef,
      backendEvidence: input.backendEvidence ?? lock.backendEvidence,
      backendOperationId: input.backendOperationId ?? lock.backendOperationId,
      backendReceipt: input.backendReceipt ?? lock.backendReceipt,
      updatedAt: now,
      versionNo: lock.versionNo + 1,
    })
    .where(eq(workspaceWriteLock.id, lock.id));
  const [active] = await executor
    .select()
    .from(workspaceWriteLock)
    .where(eq(workspaceWriteLock.id, lock.id))
    .limit(1);
  if (!active) throw new WorkspaceWriterConflictError("Workspace writer 激活后回查失败");
  return active;
}

export async function releaseWorkspaceWriteLock(
  input: {
    tenantId: string;
    lockId: string;
    ownershipId?: string;
    reasonCode: string;
  },
  executor: DbOrTx = db,
): Promise<WorkspaceWriteLock | null> {
  const [lock] = await executor
    .select()
    .from(workspaceWriteLock)
    .where(
      and(eq(workspaceWriteLock.tenantId, input.tenantId), eq(workspaceWriteLock.id, input.lockId)),
    )
    .for("update")
    .limit(1);
  if (!lock) return null;
  if (input.ownershipId && lock.holderOwnershipId !== input.ownershipId)
    throw new WorkspaceWriterConflictError("Workspace writer ownership 不匹配");
  if (lock.lockState === "released") return lock;
  const now = new Date();
  await executor
    .update(workspaceWriteLock)
    .set({
      lockState: "released",
      releaseReasonCode: input.reasonCode,
      holderInvocationId: null,
      holderAttemptId: null,
      holderOwnershipId: null,
      workspaceBindingId: null,
      backendGrantRef: null,
      backendEvidence: null,
      backendOperationId: null,
      backendReceipt: null,
      leaseExpiresAt: null,
      updatedAt: now,
      versionNo: lock.versionNo + 1,
    })
    .where(eq(workspaceWriteLock.id, lock.id));
  const [released] = await executor
    .select()
    .from(workspaceWriteLock)
    .where(eq(workspaceWriteLock.id, lock.id))
    .limit(1);
  return released ?? null;
}

export async function revokeWorkspaceWriteLocksForInvocation(
  input: {
    tenantId: string;
    invocationId: string;
    reasonCode: string;
  },
  executor: DbOrTx = db,
): Promise<string[]> {
  const locks = await executor
    .select({ id: workspaceWriteLock.id })
    .from(workspaceWriteLock)
    .where(
      and(
        eq(workspaceWriteLock.tenantId, input.tenantId),
        eq(workspaceWriteLock.holderInvocationId, input.invocationId),
        activeStates(),
      ),
    )
    .for("update");
  for (const lock of locks)
    await executor
      .update(workspaceWriteLock)
      .set({
        lockState: "quarantined",
        releaseReasonCode: input.reasonCode,
        leaseExpiresAt: null,
        versionNo: sql`${workspaceWriteLock.versionNo} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(workspaceWriteLock.id, lock.id));
  return locks.map((lock) => lock.id);
}

export async function reapExpiredWorkspaceWriteLocks(
  tenantId: string,
  now = new Date(),
  executor: DbOrTx = db,
): Promise<number> {
  const result = await executor
    .update(workspaceWriteLock)
    .set({
      lockState: "quarantined",
      releaseReasonCode: "writer_expired",
      versionNo: sql`${workspaceWriteLock.versionNo} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(workspaceWriteLock.tenantId, tenantId),
        activeStates(),
        lt(workspaceWriteLock.leaseExpiresAt, now),
      ),
    );
  return result[0].affectedRows;
}

export async function getWorkspaceWriteLock(
  tenantId: string,
  lockId: string,
  executor: DbOrTx = db,
): Promise<WorkspaceWriteLock | null> {
  const [row] = await executor
    .select()
    .from(workspaceWriteLock)
    .where(and(eq(workspaceWriteLock.tenantId, tenantId), eq(workspaceWriteLock.id, lockId)))
    .limit(1);
  return row ?? null;
}

export async function getActiveLocksByInvocation(
  tenantId: string,
  invocationId: string,
  executor: DbOrTx = db,
): Promise<WorkspaceWriteLock[]> {
  return executor
    .select()
    .from(workspaceWriteLock)
    .where(
      and(
        eq(workspaceWriteLock.tenantId, tenantId),
        eq(workspaceWriteLock.holderInvocationId, invocationId),
        activeStates(),
      ),
    );
}

export async function getActiveLocksByBinding(
  tenantId: string,
  workspaceBindingId: string,
  executor: DbOrTx = db,
): Promise<WorkspaceWriteLock[]> {
  return executor
    .select()
    .from(workspaceWriteLock)
    .where(
      and(
        eq(workspaceWriteLock.tenantId, tenantId),
        eq(workspaceWriteLock.workspaceBindingId, workspaceBindingId),
        activeStates(),
      ),
    );
}

export const acquireWorkspaceWriteLock = reserveWorkspaceWriter;
