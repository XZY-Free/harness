/** Serialized ExecutionOwnership operations. Every operation locks Invocation first. */
import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import { assertLeasePreparedEvidence } from "@/lib/environment/environment-prepared-evidence";
import {
  ExecutionAuthorityError,
  OWNERSHIP_DISPATCH_DEADLINE_MS,
  OWNERSHIP_LEASE_MS,
  authorityIdentity,
} from "@/lib/executions/domain/execution-authority";
import { environmentLeaseTable } from "@/lib/persistence/schema/environment";
import { environmentDefinitionRevisionTable } from "@/lib/persistence/schema/environment-definition-revision";
import {
  type ExecutionOwnership,
  executionBindingTable,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { revokeWorkspaceWriteLocksForInvocation } from "@/lib/workspace/workspace-write-lock-queries";
import { and, eq, isNull, sql } from "drizzle-orm";

export type OwnershipTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function getAuthorityDatabaseTime(executor: DbOrTx): Promise<Date> {
  const [row] = await executor
    .select({ epochMilliseconds: sql<number>`FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(6)) * 1000)` })
    .from(invocationTable)
    .limit(1);
  const epochMilliseconds = Number(row?.epochMilliseconds);
  if (!Number.isFinite(epochMilliseconds)) {
    throw new ExecutionAuthorityError("NotCurrentExecutor", "无法读取数据库 Authority 时间");
  }
  return new Date(epochMilliseconds);
}

export interface AcquireExecutionOwnershipInput {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  runtimeRevisionId: string;
  environmentLeaseId?: string | null;
  acquiredByType: "system" | "service";
  acquiredById: string;
  workspaceWriterGeneration?: number | null;
  activationEvidence?: unknown;
  activationDigest?: string | null;
}

export interface OwnershipResult {
  ownership: ExecutionOwnership;
  authority: null;
  takeover: boolean;
}

async function lockInvocation(executor: OwnershipTx, tenantId: string, invocationId: string) {
  const [invocation] = await executor
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .for("update")
    .limit(1);
  if (!invocation)
    throw new ExecutionAuthorityError("NotCurrentExecutor", "Invocation 不存在或不可见");
  return invocation;
}

async function prepareChecks(executor: OwnershipTx, input: AcquireExecutionOwnershipInput) {
  const [attempt] = await executor
    .select()
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, input.tenantId),
        eq(invocationAttemptTable.id, input.attemptId),
        eq(invocationAttemptTable.invocationId, input.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!attempt || attempt.preparationState !== "prepared") {
    throw new ExecutionAuthorityError("AttemptMismatch", "Attempt 不存在或尚未 Prepared");
  }
  if (input.environmentLeaseId) {
    const [lease] = await executor
      .select()
      .from(environmentLeaseTable)
      .where(
        and(
          eq(environmentLeaseTable.tenantId, input.tenantId),
          eq(environmentLeaseTable.id, input.environmentLeaseId),
          eq(environmentLeaseTable.invocationId, input.invocationId),
          eq(environmentLeaseTable.attemptId, input.attemptId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !lease ||
      !["prepared", "ready"].includes(lease.readinessState) ||
      !["allocated", "active"].includes(lease.leaseState)
    ) {
      throw new ExecutionAuthorityError("WorkspaceNotReady", "EnvironmentLease 尚未达到 ready");
    }
    // R07 §4：Acquire 也必须复验准备证据本身，而不是只信 Lease 的状态字段。
    // 换 Revision / 换 WorkspaceBinding / 恢复水位变化 / 已过 Prepared 有效期
    // 都必须在这里被拒绝，否则旧准备证据会随状态字段一起"漂"进执行。
    const [binding] = await executor
      .select({
        workspaceBindingId: executionBindingTable.workspaceBindingId,
        environmentDefinitionRevisionId: executionBindingTable.environmentDefinitionRevisionId,
      })
      .from(executionBindingTable)
      .where(
        and(
          eq(executionBindingTable.tenantId, input.tenantId),
          eq(executionBindingTable.invocationId, input.invocationId),
        ),
      )
      .limit(1);
    if (!binding?.environmentDefinitionRevisionId) {
      throw new Error("EnvironmentRevisionMismatch");
    }
    if (binding.environmentDefinitionRevisionId !== lease.environmentDefinitionRevisionId) {
      throw new Error("EnvironmentRevisionMismatch");
    }
    const [revision] = await executor
      .select({
        semanticDigest: environmentDefinitionRevisionTable.semanticDigest,
      })
      .from(environmentDefinitionRevisionTable)
      .where(
        and(
          eq(environmentDefinitionRevisionTable.tenantId, input.tenantId),
          eq(environmentDefinitionRevisionTable.id, binding.environmentDefinitionRevisionId),
        ),
      )
      .limit(1);
    if (!revision) throw new Error("EnvironmentRevisionMismatch");
    assertLeasePreparedEvidence({
      preparedEvidence: lease.preparedEvidence,
      preparedDigest: lease.preparedDigest,
      revisionId: binding.environmentDefinitionRevisionId,
      semanticDigest: revision.semanticDigest,
      attemptId: input.attemptId,
      workspaceBindingId: binding.workspaceBindingId,
      recoveryAnchorDigest: null,
      // Acquire 在事务内，用 DB Authority 时间判定有效期（不受调用方时钟影响）。
      now: await getAuthorityDatabaseTime(executor),
    });
  }
}

export async function acquireExecutionOwnership(
  input: AcquireExecutionOwnershipInput,
): Promise<OwnershipResult> {
  return db.transaction(async (tx) => acquireExecutionOwnershipInTransaction(tx, input));
}

export async function acquireExecutionOwnershipInTransaction(
  tx: OwnershipTx,
  input: AcquireExecutionOwnershipInput,
): Promise<OwnershipResult> {
  const invocation = await lockInvocation(tx, input.tenantId, input.invocationId);
  await prepareChecks(tx, input);
  const now = await getAuthorityDatabaseTime(tx);
  const [active] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.invocationId, input.invocationId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    )
    .for("update")
    .limit(1);
  if (active && active.leaseExpiresAt > now) {
    throw new ExecutionAuthorityError(
      "HealthyOwnerExists",
      "Invocation 已存在未过期 Current Owner",
    );
  }
  let takeover = false;
  if (active) {
    takeover = true;
    await tx
      .update(executionOwnershipTable)
      .set({
        ownershipState: "lost",
        releasedAt: now,
        reasonCode: "OwnershipExpired",
        versionNo: active.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(executionOwnershipTable.id, active.id));
    await tx
      .update(runtimeSessionBindingTable)
      .set({
        bindingState: "lost",
        closedAt: now,
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        versionNo: sql`${runtimeSessionBindingTable.versionNo} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(runtimeSessionBindingTable.tenantId, input.tenantId),
          eq(runtimeSessionBindingTable.ownershipId, active.id),
        ),
      );
    const [staleAttempt] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.tenantId, input.tenantId),
          eq(invocationAttemptTable.id, active.attemptId),
          eq(invocationAttemptTable.invocationId, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (staleAttempt && ["queued", "running", "suspended"].includes(staleAttempt.attemptState)) {
      await tx
        .update(invocationAttemptTable)
        .set({
          attemptState: "lost",
          finishedAt: now,
          errorCode: "OwnershipExpired",
          errorSummary: "ExecutionOwnership lease expired before takeover",
          versionNo: staleAttempt.versionNo + 1,
          updatedAt: now,
        })
        .where(eq(invocationAttemptTable.id, staleAttempt.id));
    }
    if (active.environmentLeaseId) {
      await tx
        .update(environmentLeaseTable)
        .set({
          leaseState: "lost",
          readinessState: "blocked",
          activationOwnershipId: null,
          releasedAt: now,
          lastErrorCode: "OwnershipExpired",
          versionNo: sql`${environmentLeaseTable.versionNo} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(environmentLeaseTable.tenantId, input.tenantId),
            eq(environmentLeaseTable.id, active.environmentLeaseId),
            eq(environmentLeaseTable.activationOwnershipId, active.id),
          ),
        );
    }
    await revokeWorkspaceWriteLocksForInvocation(
      {
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        reasonCode: "OwnershipExpired",
      },
      tx,
    );
  }
  const leaseEpoch = invocation.lastOwnershipEpoch + 1;
  const ownershipId = randomUUID();
  const expiredCheckpointGate = active && invocation.checkpointOwnerId === active.id;
  await tx
    .update(invocationTable)
    .set({
      lastOwnershipEpoch: leaseEpoch,
      ...(expiredCheckpointGate
        ? {
            checkpointGate: "open",
            checkpointIntentId: null,
            checkpointOwnerId: null,
            checkpointDeadline: null,
            checkpointPreparedEvidence: { failureCode: "OwnershipExpired" },
          }
        : {}),
      versionNo: invocation.versionNo + 1,
      updatedAt: now,
    })
    .where(eq(invocationTable.id, input.invocationId));
  await tx.insert(executionOwnershipTable).values({
    id: ownershipId,
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    environmentLeaseId: input.environmentLeaseId ?? null,
    leaseEpoch,
    ownershipState: "active",
    executionPhase: "activating",
    acquiredAt: now,
    lastHeartbeatAt: now,
    leaseExpiresAt: new Date(now.getTime() + OWNERSHIP_LEASE_MS),
    dispatchDeadline: new Date(now.getTime() + OWNERSHIP_DISPATCH_DEADLINE_MS),
    releasedAt: null,
    reasonCode: null,
    reasonDetail: null,
    acquiredByType: input.acquiredByType,
    acquiredById: input.acquiredById,
    closedByType: null,
    closedById: null,
    workspaceWriterGeneration: input.workspaceWriterGeneration ?? null,
    activationEvidence: input.activationEvidence ?? null,
    activationDigest: input.activationDigest ?? null,
    activatedAt: null,
    versionNo: 1,
  });
  const [ownership] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(eq(executionOwnershipTable.id, ownershipId))
    .limit(1);
  if (!ownership) throw new ExecutionAuthorityError("NotCurrentExecutor", "Owner 创建后回查失败");
  return {
    ownership,
    authority: null,
    takeover,
  };
}

export async function renewExecutionOwnership(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  attemptId: string;
  leaseEpoch: number;
}): Promise<ExecutionOwnership> {
  return db.transaction(async (tx) => renewExecutionOwnershipInTransaction(tx, input));
}

export async function getActiveExecutionOwnership(input: {
  tenantId: string;
  invocationId: string;
  executor?: DbOrTx;
}): Promise<ExecutionOwnership | null> {
  const executor = input.executor ?? db;
  const [row] = await executor
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.invocationId, input.invocationId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    )
    .orderBy(sql`${executionOwnershipTable.leaseEpoch} DESC`)
    .limit(1);
  return row ?? null;
}

export async function renewExecutionOwnershipInTransaction(
  tx: OwnershipTx,
  input: {
    tenantId: string;
    invocationId: string;
    ownershipId: string;
    attemptId: string;
    leaseEpoch: number;
  },
): Promise<ExecutionOwnership> {
  const invocation = await lockInvocation(tx, input.tenantId, input.invocationId);
  const [owner] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.id, input.ownershipId),
        eq(executionOwnershipTable.invocationId, input.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  const now = await getAuthorityDatabaseTime(tx);
  if (!owner || owner.attemptId !== input.attemptId || owner.leaseEpoch !== input.leaseEpoch)
    throw new ExecutionAuthorityError("NotCurrentExecutor", "Owner tuple 不匹配");
  if (owner.ownershipState !== "active")
    throw new ExecutionAuthorityError("NotCurrentExecutor", "Owner 已关闭");
  if (owner.leaseExpiresAt <= now)
    throw new ExecutionAuthorityError("OwnershipExpired", "Owner lease 已过期");
  // 未 Start（Invocation 尚未 running）的 Owner 续租受 dispatchDeadline 封顶：
  // 平台无法通过反复续租把 Start 阶段无限占用；一旦 deadline 已过且未 Start，续租失败。
  const executionStarted = invocation.executionState === "running";
  if (!executionStarted && owner.dispatchDeadline <= now) {
    throw new ExecutionAuthorityError("OwnershipExpired", "Dispatch deadline 已过且执行尚未启动");
  }
  const desiredLeaseExpiresAt = new Date(now.getTime() + OWNERSHIP_LEASE_MS);
  const leaseExpiresAt =
    !executionStarted && desiredLeaseExpiresAt > owner.dispatchDeadline
      ? owner.dispatchDeadline
      : desiredLeaseExpiresAt;
  await tx
    .update(executionOwnershipTable)
    .set({ lastHeartbeatAt: now, leaseExpiresAt, versionNo: owner.versionNo + 1, updatedAt: now })
    .where(eq(executionOwnershipTable.id, owner.id));
  const [updated] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(eq(executionOwnershipTable.id, owner.id))
    .limit(1);
  if (!updated) throw new ExecutionAuthorityError("NotCurrentExecutor", "Owner 续租后回查失败");
  return updated;
}

export async function requireCurrentExecutionOwnership(input: {
  tenantId: string;
  authority: { invocationId: string; attemptId: string; ownershipId: string; leaseEpoch: number };
  executor?: DbOrTx;
  requiredPhase?: "activating" | "dispatching" | "executing" | "suspending";
}): Promise<ExecutionOwnership> {
  const executor = input.executor ?? db;
  const [owner] = await executor
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.id, input.authority.ownershipId),
        eq(executionOwnershipTable.invocationId, input.authority.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  const now = await getAuthorityDatabaseTime(executor);
  if (
    !owner ||
    owner.attemptId !== input.authority.attemptId ||
    owner.leaseEpoch !== input.authority.leaseEpoch ||
    owner.ownershipState !== "active"
  )
    throw new ExecutionAuthorityError("NotCurrentExecutor", "不是 Current ExecutionOwnership");
  if (input.requiredPhase && owner.executionPhase !== input.requiredPhase)
    throw new ExecutionAuthorityError(
      "NotCurrentExecutor",
      "Current ExecutionOwnership 阶段不允许该操作",
    );
  if (owner.leaseExpiresAt <= now)
    throw new ExecutionAuthorityError("OwnershipExpired", "Current ExecutionOwnership 已过期");
  return owner;
}

export async function closeExecutionOwnership(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  state: "released" | "lost" | "revoked";
  reasonCode: string;
}): Promise<ExecutionOwnership> {
  return db.transaction(async (tx) => {
    await lockInvocation(tx, input.tenantId, input.invocationId);
    const [owner] = await tx
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.id, input.ownershipId),
        ),
      )
      .for("update")
      .limit(1);
    if (!owner) throw new ExecutionAuthorityError("NotCurrentExecutor", "Owner 不存在");
    if (owner.ownershipState !== "active") return owner;
    const now = await getAuthorityDatabaseTime(tx);
    await tx
      .update(executionOwnershipTable)
      .set({
        ownershipState: input.state,
        releasedAt: now,
        reasonCode: input.reasonCode,
        versionNo: owner.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(executionOwnershipTable.id, owner.id));
    const [updated] = await tx
      .select()
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.id, owner.id))
      .limit(1);
    if (!updated) throw new ExecutionAuthorityError("NotCurrentExecutor", "Owner 关闭后回查失败");
    return updated;
  });
}
