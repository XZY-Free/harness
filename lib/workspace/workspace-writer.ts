import { db } from "@/lib/db/client";
import { executionOwnershipTable } from "@/lib/persistence/schema/executions";
import type { ExecutionOwnership } from "@/lib/persistence/schema/executions";
import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";
import type { WorkspaceBackend } from "@/lib/workspace/workspace-backend";
import {
  type WorkspaceContinuityContract,
  validateWorkspaceContract,
} from "@/lib/workspace/workspace-contract";
import type { WorkspaceHost, WorkspaceWriterGrant } from "@/lib/workspace/workspace-host";
import {
  activateWorkspaceWriter,
  getActiveLocksByInvocation,
  releaseWorkspaceWriteLock,
  reserveWorkspaceWriter,
} from "@/lib/workspace/workspace-write-lock-queries";
import { and, eq } from "drizzle-orm";

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
  const operationId = `writer-activate:${input.candidate.binding.id}:${scopeDigest}:${input.attemptId}`;

  const existing = (await getActiveLocksByInvocation(input.tenantId, input.invocationId)).find(
    (lock) =>
      lock.storageScopeDigest === scopeDigest &&
      lock.holderAttemptId === input.attemptId &&
      lock.holderOwnershipId === input.ownership.id &&
      lock.workspaceBindingId === input.candidate.binding.id,
  );
  const reserved = existing
    ? { lock: existing, writerGeneration: existing.writerGeneration }
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
  try {
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
    const active = await db.transaction(async (tx) => {
      // 复核 Current Ownership：调用方先前读到的 row 不能绕过复核。
      const [current] = await tx
        .select()
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, input.tenantId),
            eq(executionOwnershipTable.id, input.ownership.id),
            eq(executionOwnershipTable.invocationId, input.invocationId),
            eq(executionOwnershipTable.ownershipState, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!current || current.leaseEpoch !== input.ownership.leaseEpoch) {
        throw new Error("NotCurrentExecutor");
      }
      if (current.leaseExpiresAt <= new Date()) throw new Error("NotCurrentExecutor");
      return activateWorkspaceWriter(
        {
          tenantId: input.tenantId,
          lockId: reserved.lock.id,
          ownershipId: input.ownership.id,
          writerGeneration: reserved.writerGeneration,
          backendGrantRef: grant.grantRef,
          backendEvidence: grant.backendEvidence,
          backendOperationId: operationId,
          backendReceipt: grant.backendEvidence,
        },
        tx,
      );
    });
    return { grant, lockId: active.id, writerGeneration: active.writerGeneration };
  } catch (error) {
    // 先让 Backend 真实撤销该 generation 的 Writer，再写控制面状态：
    // 不允许"先写 released 再吞掉 Backend 错误"。
    await input.candidate.backend.host
      .revokeWriterGeneration(scopeDigest, reserved.writerGeneration)
      .catch(() => undefined);
    await releaseWorkspaceWriteLock({
      tenantId: input.tenantId,
      lockId: reserved.lock.id,
      ownershipId: input.ownership.id,
      reasonCode: "writer_activation_failed",
    }).catch(() => undefined);
    await input.candidate.backend.host.cleanup(input.candidate.preparation).catch(() => undefined);
    throw error;
  }
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

/** 释放 Writer：先让 Backend 真实撤销，再落控制面 released。 */
export async function releaseWorkspaceWriter(input: {
  tenantId: string;
  lockId: string;
  ownershipId: string;
  reasonCode: string;
  backend?: WorkspaceHost | null;
  scopeDigest?: string | null;
  writerGeneration?: number | null;
}): Promise<void> {
  if (
    input.backend &&
    input.scopeDigest &&
    input.writerGeneration !== undefined &&
    input.writerGeneration !== null
  ) {
    await input.backend
      .revokeWriterGeneration(input.scopeDigest, input.writerGeneration)
      .catch(() => undefined);
  }
  await releaseWorkspaceWriteLock({
    tenantId: input.tenantId,
    lockId: input.lockId,
    ownershipId: input.ownershipId,
    reasonCode: input.reasonCode,
  });
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
