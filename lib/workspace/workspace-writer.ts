import { db } from "@/lib/db/client";
import type { ExecutionOwnership } from "@/lib/persistence/schema/executions";
import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";
import type { WorkspaceBackend } from "@/lib/workspace/workspace-backend";
import {
  type WorkspaceContinuityContract,
  validateWorkspaceContract,
} from "@/lib/workspace/workspace-contract";
import type { WorkspaceWriterGrant } from "@/lib/workspace/workspace-host";
import {
  type ReserveWorkspaceWriterOutcome,
  type WorkspaceReleasePending,
  activateWorkspaceWriter,
  getActiveLocksByInvocation,
  reserveWorkspaceWriter,
} from "@/lib/workspace/workspace-write-lock-queries";

/**
 * 旧代际的物理 Writer 尚未确认停止时的**可重试**失败（A07 决策四）。
 *
 * 它不是配置错误、也不是权限错误：释放 lane 会继续把旧代际停下来，等它写出 `released`
 * 之后同一次激活路径会自然成功。因此调用方应当把它当作"本轮不做、稍后重试"，
 * 绝不能降级成"直接抢下一代"。
 */
export class WorkspaceWriterReleasePendingError extends Error {
  readonly reason: WorkspaceReleasePending["reason"];
  readonly lockId: string;
  constructor(message: string, lock: { id: string }, reason: WorkspaceReleasePending["reason"]) {
    super(message);
    this.name = "WorkspaceWriterReleasePending";
    this.lockId = lock.id;
    this.reason = reason;
  }
}

export interface ActivatedWorkspaceWriter {
  grant: WorkspaceWriterGrant;
  lockId: string;
  writerGeneration: number;
}

export interface PreparedWorkspaceCandidate {
  preparation: Awaited<ReturnType<WorkspaceBackend["host"]["prepare"]>>;
  binding: WorkspaceBinding;
  backend: WorkspaceBackend;
  root: string;
  operationId: string;
}

export async function prepareWorkspaceCandidate(input: {
  attemptId: string;
  binding: WorkspaceBinding;
  backend: WorkspaceBackend;
  root: string;
  operationId: string;
  runtimeRevisionId: string;
}): Promise<PreparedWorkspaceCandidate | null> {
  const contract = bindingContract(input.binding);
  if (contract.continuityMode === "NO_PLATFORM_WORKSPACE") throw new Error("WorkspaceNotReady");
  const prepared = await input.backend.host.prepare({
    candidateAttemptId: input.attemptId,
    revisionId: input.runtimeRevisionId,
    workspaceBindingId: input.binding.id,
    operationId: input.operationId,
  });
  return {
    preparation: prepared,
    binding: input.binding,
    backend: input.backend,
    root: input.root,
    operationId: input.operationId,
  };
}

/**
 * 真正的 Writer 激活协议（R08 §3）。
 *
 * 三段式：
 * 1. **W→I 事务**：预留单调 generation，记录完整 holder tuple 与稳定 Backend operationId。
 * 2. **事务外**：Broker 验证旧 generation、停止旧执行组并排空、返回可核验回执。
 *    事务外做，避免把进程终止这种不可回滚操作放进 DB 事务。
 * 3. **W→I 事务**：复核 Current Ownership 未变化、未过期，Lease/Prepared 一致，
 *    才提交 Write-Activated。Backend 成功但 DB 确认失败时，靠同一 operation 的回执恢复，
 *    不再杀一次、也不新建 generation。
 */
export async function activatePreparedWorkspaceWriter(input: {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  ownership: ExecutionOwnership;
  authority: AuthorityIdentity;
  candidate: PreparedWorkspaceCandidate;
}): Promise<ActivatedWorkspaceWriter> {
  const contract = bindingContract(input.candidate.binding);
  if (contract.continuityMode === "NO_PLATFORM_WORKSPACE") throw new Error("WorkspaceNotReady");
  const scopeDigest = contract.storageScopeDigest as string;
  const storageIdentity = contract.storageIdentity as string;
  const leaseExpiresAt = input.ownership.leaseExpiresAt;
  const operationId = workspaceWriterActivationOperationId({
    workspaceBindingId: input.candidate.binding.id,
    storageScopeDigest: scopeDigest,
    attemptId: input.attemptId,
    ownershipId: input.ownership.id,
    leaseEpoch: input.ownership.leaseEpoch,
  });

  const existing = (await getActiveLocksByInvocation(input.tenantId, input.invocationId)).find(
    (lock) =>
      lock.storageScopeDigest === scopeDigest &&
      lock.holderAttemptId === input.attemptId &&
      lock.holderOwnershipId === input.ownership.id &&
      lock.workspaceBindingId === input.candidate.binding.id,
  );
  const reservedOutcome: ReserveWorkspaceWriterOutcome = existing
    ? { outcome: "reserved", lock: existing, writerGeneration: existing.writerGeneration }
    : await reserveWorkspaceWriter({
        tenantId: input.tenantId,
        storageScopeDigest: scopeDigest,
        invocationId: input.invocationId,
        attemptId: input.attemptId,
        ownershipId: input.ownership.id,
        workspaceBindingId: input.candidate.binding.id,
        leaseExpiresAt,
        backendGrantRef: null,
        backendEvidence: { phase: "reserved", resourceId: input.candidate.preparation.resourceId },
        backendOperationId: operationId,
      });
  if (reservedOutcome.outcome === "release_pending") {
    // A07 决策四：本行仍背着一个未确认停止的物理 Writer。绝不覆盖它、也绝不抢下一代，
    // 只把"稍后重试"如实报给调用方；释放 lane 会把该行推到 `released`。
    throw new WorkspaceWriterReleasePendingError(
      `Workspace writer 释放未完成（${reservedOutcome.reason}），本轮不分配下一代`,
      reservedOutcome.lock,
      reservedOutcome.reason,
    );
  }
  const reserved = reservedOutcome;
  if (reserved.lock.lockState === "active") {
    // 已激活：只读真实 Backend 回执，绝不重复开 Writer。
    const grant = await input.candidate.backend.host.getWriter(
      scopeDigest,
      reserved.writerGeneration,
    );
    if (!grant) throw new Error("WorkspaceWriterNotFenced");
    await input.candidate.backend.host.assertWriter(grant);
    return { grant, lockId: reserved.lock.id, writerGeneration: reserved.writerGeneration };
  }
  const grant = await input.candidate.backend.host.activateWriter({
    tenantId: input.tenantId,
    scopeDigest,
    writerGeneration: reserved.writerGeneration,
    authority: input.authority,
    expectedStorageIdentity: storageIdentity,
    operationId,
    root: input.candidate.root,
  });
  const active = await db.transaction((tx) =>
    // W→I 顺序（R04 §2/§4）：先锁 WorkspaceWriteLock，再按 Invocation → Attempt →
    // Ownership 复核 Current Ownership 与代际；不能用"先读到的 ownership row"绕过复核，
    // 也不能先锁 Ownership 再锁 W。
    activateWorkspaceWriter(
      {
        tenantId: input.tenantId,
        storageScopeDigest: scopeDigest,
        invocationId: input.invocationId,
        attemptId: input.attemptId,
        lockId: reserved.lock.id,
        writerGeneration: reserved.writerGeneration,
        ownershipId: input.ownership.id,
        leaseEpoch: input.ownership.leaseEpoch,
        backendGrantRef: grant.grantRef,
        backendEvidence: grant.backendEvidence,
        backendOperationId: operationId,
        backendReceipt: grant.backendEvidence,
      },
      tx,
    ),
  );
  return { grant, lockId: active.id, writerGeneration: active.writerGeneration };
}

export async function prepareWorkspaceWriter(input: {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  ownership: ExecutionOwnership;
  authority: AuthorityIdentity;
  binding: WorkspaceBinding;
  backend: WorkspaceBackend;
  root: string;
  operationId: string;
  runtimeRevisionId: string;
}): Promise<ActivatedWorkspaceWriter> {
  const candidate = await prepareWorkspaceCandidate(input);
  if (!candidate) throw new Error("WorkspaceNotReady");
  return activatePreparedWorkspaceWriter({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    ownership: input.ownership,
    authority: input.authority,
    candidate,
  });
}

/**
 * Writer 激活的 Backend 幂等键（A07 7.2）。
 *
 * 它是"同一次逻辑激活"的唯一身份，因此必须覆盖**真实操作代际**：
 * Binding + 物理 scope + Attempt 只描述"哪个工作目录"，不描述"哪一代执行权"。
 * 同 Attempt 的第二次正式 Resume 会有新 Owner 与新 leaseEpoch —— 若键里没有它们，
 * 第二次激活会命中第一次的回执，拿到属于旧 Owner 的物理授权。
 *
 * 抽成导出函数是为了让这条约束本身可被断言，而不是只能靠端到端间接覆盖。
 */
export function workspaceWriterActivationOperationId(input: {
  workspaceBindingId: string;
  storageScopeDigest: string;
  attemptId: string;
  ownershipId: string;
  leaseEpoch: number | string | bigint;
}): string {
  return [
    "writer-activate",
    input.workspaceBindingId,
    input.storageScopeDigest,
    input.attemptId,
    input.ownershipId,
    `epoch:${input.leaseEpoch}`,
  ].join(":");
}

export function bindingContract(binding: WorkspaceBinding): WorkspaceContinuityContract {
  return validateWorkspaceContract({
    bindingId: binding.id,
    continuityMode: binding.continuityMode,
    contractDigest: binding.contractDigest,
    storageScopeDigest: binding.storageScopeDigest,
    hostIdentity: binding.hostIdentity,
    storageIdentity: binding.storageIdentity,
    backendKind: binding.backendKind,
    filesystemSemantics:
      binding.filesystemSemantics as WorkspaceContinuityContract["filesystemSemantics"],
    checkpointPolicy: binding.checkpointPolicy as Record<string, unknown> | null,
  });
}
