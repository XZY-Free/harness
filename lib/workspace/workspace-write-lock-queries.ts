/**
 * 物理 scope 的 Workspace Writer 协调槽（R04 §2/§3/§4）。
 *
 * 两个方向严格分开：
 *
 * - **W→I 路径**（`reserveWorkspaceWriter` → `activateWorkspaceWriter`）：先锁
 *   WorkspaceWriteLock（scope），再按 Invocation → Attempt → Ownership 复核 Current
 *   Ownership。父 Owner 是否仍然健康必须在 W 路径中真实查行，**不能**用 slot 上写入的
 *   `leaseExpiresAt` 推断。
 * - **I→W 禁止**：任何已持有 I 根锁的事务都不得触碰本表。I 侧只失效 Authority / 关闭
 *   Session，物理撤销由持久释放 lane（`workspace-writer-release.ts`）按 W→I 顺序完成。
 *
 * 释放工作的可见性来自持久状态本身，不依赖任何内存定时器：进程在写
 * `releaseNextAttemptAt` 之前 Crash，该行下一轮仍会被扫到。
 */
import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import {
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import {
  type WorkspaceWriteLock,
  type WorkspaceWriteLockState,
  workspaceWriteLock,
} from "@/lib/persistence/schema/workspace-lock";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";

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

function holderStates() {
  return inArray(workspaceWriteLock.lockState, ["reserved", "active"] as WorkspaceWriteLockState[]);
}

/**
 * 父 Owner 是否仍然健康（R04 §4）。
 *
 * 必须在 W 路径中调用：调用方已持有该 scope 的 WorkspaceWriteLock 行，之后按
 * Invocation → Attempt → Ownership 的固定顺序取锁（真实行存在 + `ownershipState='active'`
 * + 用数据库时间判定的 Lease 未过期）。
 */
export async function isHolderOwnershipHealthy(
  input: {
    tenantId: string;
    holderInvocationId: string | null;
    holderAttemptId: string | null;
    holderOwnershipId: string | null;
    now: Date;
  },
  executor: DbOrTx = db,
): Promise<boolean> {
  if (!input.holderInvocationId || !input.holderAttemptId || !input.holderOwnershipId) return false;
  const [invocation] = await executor
    .select({ id: invocationTable.id })
    .from(invocationTable)
    .where(
      and(
        eq(invocationTable.tenantId, input.tenantId),
        eq(invocationTable.id, input.holderInvocationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!invocation) return false;
  const [attempt] = await executor
    .select({ id: invocationAttemptTable.id })
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, input.tenantId),
        eq(invocationAttemptTable.id, input.holderAttemptId),
        eq(invocationAttemptTable.invocationId, input.holderInvocationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!attempt) return false;
  const [owner] = await executor
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.id, input.holderOwnershipId),
        eq(executionOwnershipTable.invocationId, input.holderInvocationId),
      ),
    )
    .for("update")
    .limit(1);
  return Boolean(owner && owner.ownershipState === "active" && owner.leaseExpiresAt > input.now);
}

/** 预留（或重放同一 holder tuple 的预留），返回单调 writer generation。 */
export async function reserveWorkspaceWriter(
  input: AcquireWorkspaceWriteLockParams,
  executor: DbOrTx = db,
): Promise<AcquireWorkspaceWriteLockResult> {
  const now = new Date();
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
    // 同一 holder tuple 的重复预留是幂等重放：返回同一 lock 与同一 generation，
    // 既不允许第二个 Writer，也不因为一次响应丢失就切走 generation。
    const sameHolder =
      current.holderInvocationId === input.invocationId &&
      current.holderAttemptId === input.attemptId &&
      current.holderOwnershipId === input.ownershipId &&
      current.workspaceBindingId === input.workspaceBindingId;
    if (sameHolder) return { lock: current, writerGeneration: current.writerGeneration };
    // R04 §4：接管条件是"父 Owner 已经失权"，不是"slot 上写的 leaseExpiresAt 到期"。
    const healthy = await isHolderOwnershipHealthy(
      {
        tenantId: input.tenantId,
        holderInvocationId: current.holderInvocationId,
        holderAttemptId: current.holderAttemptId,
        holderOwnershipId: current.holderOwnershipId,
        now,
      },
      executor,
    );
    if (healthy) {
      throw new WorkspaceWriterConflictError(
        "Workspace writer 的父 Owner 仍然健康，不得抢占该 generation",
      );
    }
  }
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
        releaseNextAttemptAt: null,
        releaseLeaseOwner: null,
        releaseLeaseExpiresAt: null,
        releaseErrorCode: null,
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
      releaseAttemptCount: 0,
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

/**
 * W→I 顺序的 Writer 激活（R04 §2/§4）。
 *
 * 先锁 WorkspaceWriteLock（scope），再按 Invocation → Attempt → Ownership 复核
 * Current Ownership 与 generation/leaseEpoch，最后才提交 Write-Activated。
 * 事务内不执行任何外部副作用。
 */
export async function activateWorkspaceWriter(
  input: {
    tenantId: string;
    invocationId: string;
    attemptId: string;
    lockId: string;
    writerGeneration: number;
    ownershipId: string;
    leaseEpoch: number;
    backendGrantRef: string;
    backendEvidence?: unknown;
    backendOperationId?: string | null;
    backendReceipt?: unknown;
    now?: Date;
  },
  executor: DbOrTx = db,
): Promise<WorkspaceWriteLock> {
  const now = input.now ?? new Date();
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
    lock.writerGeneration !== input.writerGeneration ||
    lock.holderInvocationId !== input.invocationId ||
    lock.holderAttemptId !== input.attemptId ||
    lock.holderOwnershipId !== input.ownershipId
  ) {
    throw new WorkspaceWriterConflictError("Workspace writer 预留不匹配");
  }
  const healthy = await isHolderOwnershipHealthy(
    {
      tenantId: input.tenantId,
      holderInvocationId: input.invocationId,
      holderAttemptId: input.attemptId,
      holderOwnershipId: input.ownershipId,
      now,
    },
    executor,
  );
  if (!healthy) throw new WorkspaceWriterConflictError("Workspace writer 的父 Owner 已失权");
  const [owner] = await executor
    .select({ leaseEpoch: executionOwnershipTable.leaseEpoch })
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.id, input.ownershipId),
      ),
    )
    .for("update")
    .limit(1);
  if (!owner || owner.leaseEpoch !== input.leaseEpoch) {
    throw new WorkspaceWriterConflictError("Workspace writer 的 Owner 代际已变化");
  }
  await executor
    .update(workspaceWriteLock)
    .set({
      lockState: "active",
      backendGrantRef: input.backendGrantRef,
      backendEvidence: input.backendEvidence ?? lock.backendEvidence,
      backendOperationId: input.backendOperationId ?? lock.backendOperationId,
      backendReceipt: input.backendReceipt ?? lock.backendReceipt,
      releaseReasonCode: null,
      releaseNextAttemptAt: null,
      releaseLeaseOwner: null,
      releaseLeaseExpiresAt: null,
      releaseErrorCode: null,
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

/**
 * 写一条**持久**的物理释放请求（R04 §3「写持久资源清理请求」）。
 *
 * 只改控制面状态，不触碰 Backend，也不清空 Backend 定位字段（§7：不能先清空回执定位
 * 再失去清理能力）。物理 stop/drain 由释放 lane 完成。幂等：重复请求保留首个 reasonCode。
 */
export async function requestWorkspaceWriterRelease(input: {
  tenantId: string;
  lockId: string;
  reasonCode: string;
  /** 限定 holder：只有当前 holder 就是该 Ownership 时才写请求（防止误标他人槽位）。 */
  ownershipId?: string;
  now?: Date;
}): Promise<WorkspaceWriteLock | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [lock] = await tx
      .select()
      .from(workspaceWriteLock)
      .where(
        and(
          eq(workspaceWriteLock.tenantId, input.tenantId),
          eq(workspaceWriteLock.id, input.lockId),
        ),
      )
      .for("update")
      .limit(1);
    if (!lock) return null;
    if (input.ownershipId && lock.holderOwnershipId !== input.ownershipId) return lock;
    if (lock.lockState === "released" || lock.lockState === "releasing") return lock;
    await tx
      .update(workspaceWriteLock)
      .set({
        lockState: "releasing",
        releaseReasonCode: input.reasonCode,
        // 可见性来自 lockState；立即到期让正式 Worker 下一轮就处理，不再等退避。
        releaseNextAttemptAt: null,
        releaseErrorCode: null,
        versionNo: lock.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(workspaceWriteLock.id, lock.id));
    const [requested] = await tx
      .select()
      .from(workspaceWriteLock)
      .where(eq(workspaceWriteLock.id, lock.id))
      .limit(1);
    return requested ?? null;
  });
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
        holderStates(),
      ),
    );
}

// ── 物理释放 lane 的持久状态（R04 §3）───────────────────────────────────────

/** 释放重试退避（与 Environment Lease 清理同构）。 */
export const WORKSPACE_RELEASE_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;
/** 领取权时长：过期 Worker 不能覆盖新 claim 的结果。 */
export const WORKSPACE_RELEASE_LEASE_MS = 60_000;

export function workspaceReleaseBackoffMs(attemptCount: number): number {
  const index = Math.max(0, attemptCount - 1);
  return WORKSPACE_RELEASE_BACKOFF_MS[index] ?? 300_000;
}

export interface WorkspaceWriteLockReleaseCandidate {
  tenantId: string;
  lockId: string;
  lockState: WorkspaceWriteLockState;
}

/**
 * 扫描需要物理释放的 Writer（R04 §3/§5：**只取候选 ID**）。
 *
 * 候选包含两类：显式释放请求（`releasing`）与"仍被持有但父 Owner 已失权"的槽位。
 * 后者在这一步**不做**健康判断——健康复核在领取事务里按对象自身状态重做，
 * 因此"扫描后、领取前"发生的新 Owner 接管不会被误释放。
 */
export async function scanWorkspaceWriteLocksNeedingRelease(input: {
  now: Date;
  limit: number;
  tenantId?: string;
}): Promise<WorkspaceWriteLockReleaseCandidate[]> {
  const dueNow = or(
    isNull(workspaceWriteLock.releaseNextAttemptAt),
    lte(workspaceWriteLock.releaseNextAttemptAt, input.now),
  );
  const leaseFree = or(
    isNull(workspaceWriteLock.releaseLeaseExpiresAt),
    lte(workspaceWriteLock.releaseLeaseExpiresAt, input.now),
  );
  return db
    .select({
      tenantId: workspaceWriteLock.tenantId,
      lockId: workspaceWriteLock.id,
      lockState: workspaceWriteLock.lockState,
    })
    .from(workspaceWriteLock)
    .where(
      and(
        ...(input.tenantId ? [eq(workspaceWriteLock.tenantId, input.tenantId)] : []),
        inArray(workspaceWriteLock.lockState, [
          "reserved",
          "active",
          "releasing",
        ] as WorkspaceWriteLockState[]),
        dueNow,
        leaseFree,
      ),
    )
    .orderBy(asc(workspaceWriteLock.releaseNextAttemptAt), asc(workspaceWriteLock.updatedAt))
    .limit(input.limit);
}

/**
 * 领取一条释放工作（W→I 顺序）。
 *
 * 候选 ID 来自扫描，但这里必须重新读对象自身状态并复验"父 Owner 已失权"，
 * 因此扫描与领取之间发生的新 Owner 接管不会被误释放。
 */
export async function claimWorkspaceWriterRelease(input: {
  tenantId: string;
  lockId: string;
  leaseOwner: string;
  now: Date;
  leaseDurationMs?: number;
}): Promise<
  | { outcome: "claimed"; lock: WorkspaceWriteLock; releaseAttemptCount: number }
  | {
      outcome: "skipped";
      reason: "not_found" | "already_released" | "healthy_owner" | "claimed_elsewhere";
    }
> {
  return db.transaction(async (tx) => {
    const [lock] = await tx
      .select()
      .from(workspaceWriteLock)
      .where(
        and(
          eq(workspaceWriteLock.tenantId, input.tenantId),
          eq(workspaceWriteLock.id, input.lockId),
        ),
      )
      .for("update")
      .limit(1);
    if (!lock) return { outcome: "skipped" as const, reason: "not_found" as const };
    if (lock.lockState === "released")
      return { outcome: "skipped" as const, reason: "already_released" as const };
    if (
      lock.releaseLeaseExpiresAt &&
      lock.releaseLeaseExpiresAt > input.now &&
      lock.releaseLeaseOwner !== input.leaseOwner
    ) {
      return { outcome: "skipped" as const, reason: "claimed_elsewhere" as const };
    }
    if (lock.lockState === "reserved" || lock.lockState === "active") {
      const healthy = await isHolderOwnershipHealthy(
        {
          tenantId: input.tenantId,
          holderInvocationId: lock.holderInvocationId,
          holderAttemptId: lock.holderAttemptId,
          holderOwnershipId: lock.holderOwnershipId,
          now: input.now,
        },
        tx,
      );
      if (healthy) return { outcome: "skipped" as const, reason: "healthy_owner" as const };
    }
    const releaseAttemptCount = lock.releaseAttemptCount + 1;
    const leaseExpiresAt = new Date(
      input.now.getTime() + (input.leaseDurationMs ?? WORKSPACE_RELEASE_LEASE_MS),
    );
    await tx
      .update(workspaceWriteLock)
      .set({
        lockState: "releasing",
        releaseReasonCode: lock.releaseReasonCode ?? "writer_owner_no_longer_current",
        releaseAttemptCount,
        releaseNextAttemptAt: null,
        releaseLeaseOwner: input.leaseOwner,
        releaseLeaseExpiresAt: leaseExpiresAt,
        releaseErrorCode: null,
        versionNo: lock.versionNo + 1,
        updatedAt: input.now,
      })
      .where(eq(workspaceWriteLock.id, lock.id));
    const [claimed] = await tx
      .select()
      .from(workspaceWriteLock)
      .where(eq(workspaceWriteLock.id, lock.id))
      .limit(1);
    if (!claimed) return { outcome: "skipped" as const, reason: "not_found" as const };
    return { outcome: "claimed" as const, lock: claimed, releaseAttemptCount };
  });
}

/**
 * 完成一条释放工作。
 *
 * - 该 generation 仍是本行 holder → 写 `released` 并保留真实 stop/drain 回执；
 * - 期间已被新 generation 接管 → Backend 的接管流程本身已停止旧 Writer，
 *   因此**不再改本行**（否则会杀掉新 Writer），只回报 `superseded`。
 */
export async function completeWorkspaceWriterRelease(input: {
  tenantId: string;
  lockId: string;
  leaseOwner: string;
  releaseReceipt: unknown;
  reasonCode: string;
  now: Date;
}): Promise<{ outcome: "released" | "superseded" | "not_owner" }> {
  return db.transaction(async (tx) => {
    const [lock] = await tx
      .select()
      .from(workspaceWriteLock)
      .where(
        and(
          eq(workspaceWriteLock.tenantId, input.tenantId),
          eq(workspaceWriteLock.id, input.lockId),
        ),
      )
      .for("update")
      .limit(1);
    if (!lock) return { outcome: "not_owner" as const };
    if (lock.lockState === "released") return { outcome: "released" as const };
    if (lock.releaseLeaseOwner && lock.releaseLeaseOwner !== input.leaseOwner)
      return { outcome: "not_owner" as const };
    // 已被新 generation 接管：Backend 的接管流程本身已停止旧 Writer，因此**完全不改本行**
    // ——连回执也不写，否则会把上一个 generation 的停止证据挂到新 Writer 的槽位上。
    if (lock.lockState === "reserved" || lock.lockState === "active") {
      return { outcome: "superseded" as const };
    }
    await tx
      .update(workspaceWriteLock)
      .set({
        lockState: "released",
        holderInvocationId: null,
        holderAttemptId: null,
        holderOwnershipId: null,
        workspaceBindingId: null,
        backendGrantRef: null,
        backendEvidence: null,
        backendOperationId: null,
        backendReceipt: null,
        leaseExpiresAt: null,
        releaseReasonCode: input.reasonCode,
        releaseReceipt: input.releaseReceipt,
        releaseNextAttemptAt: null,
        releaseLeaseOwner: null,
        releaseLeaseExpiresAt: null,
        releaseErrorCode: null,
        versionNo: lock.versionNo + 1,
        updatedAt: input.now,
      })
      .where(eq(workspaceWriteLock.id, lock.id));
    return { outcome: "released" as const };
  });
}

/** 释放失败：保持 `releasing` + 退避重试，释放领取权让其他 Worker 可接管。 */
export async function recordWorkspaceWriterReleaseFailure(input: {
  tenantId: string;
  lockId: string;
  leaseOwner: string;
  errorCode: string;
  now: Date;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [lock] = await tx
      .select()
      .from(workspaceWriteLock)
      .where(
        and(
          eq(workspaceWriteLock.tenantId, input.tenantId),
          eq(workspaceWriteLock.id, input.lockId),
        ),
      )
      .for("update")
      .limit(1);
    if (!lock || lock.lockState === "released") return;
    if (lock.releaseLeaseOwner && lock.releaseLeaseOwner !== input.leaseOwner) return;
    // 可见性由 lockState 保证；`releaseNextAttemptAt` 只推迟下一次尝试。
    await tx
      .update(workspaceWriteLock)
      .set({
        lockState: "releasing",
        releaseErrorCode: input.errorCode,
        releaseNextAttemptAt: new Date(
          input.now.getTime() + workspaceReleaseBackoffMs(lock.releaseAttemptCount),
        ),
        releaseLeaseOwner: null,
        releaseLeaseExpiresAt: null,
        versionNo: lock.versionNo + 1,
        updatedAt: input.now,
      })
      .where(eq(workspaceWriteLock.id, lock.id));
  });
}

/**
 * 回收扫描周期（R04 §5）。
 *
 * "父 Owner 仍然健康"的行每轮都会被重新核验一次（释放工作的可见性不能依赖任何人主动
 * 写请求），但这个核验本身有成本：跳过之后把它推到下一次复检，避免每轮都重复抢占扫描
 * 配额。失败退避由 `recordWorkspaceWriterReleaseFailure` 独立控制，不与之混用。
 */
export const WORKSPACE_RELEASE_RECHECK_MS = 30_000;

/**
 * 归还领取权。
 *
 * `nextAttemptAt` 语义：给出时写入"下次尝试时间"；`undefined` 表示**不改动**该字段
 * （失败退避已由 `recordWorkspaceWriterReleaseFailure` 写好，不能被这里抹掉）。
 */
export async function releaseWorkspaceWriterClaim(input: {
  tenantId: string;
  lockId: string;
  leaseOwner: string;
  now: Date;
  nextAttemptAt?: Date | null;
}): Promise<void> {
  await db
    .update(workspaceWriteLock)
    .set({
      releaseLeaseOwner: null,
      releaseLeaseExpiresAt: null,
      ...(input.nextAttemptAt !== undefined ? { releaseNextAttemptAt: input.nextAttemptAt } : {}),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(workspaceWriteLock.tenantId, input.tenantId),
        eq(workspaceWriteLock.id, input.lockId),
        // 只在本 Worker 仍持有领取权、或本行根本没有领取者时更新：
        // 绝不覆盖其他 Worker 的有效 claim。
        or(
          isNull(workspaceWriteLock.releaseLeaseOwner),
          eq(workspaceWriteLock.releaseLeaseOwner, input.leaseOwner),
        ),
      ),
    );
}
