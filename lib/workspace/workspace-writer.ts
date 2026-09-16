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
  activateWorkspaceWriter,
  getActiveLocksByInvocation,
  releaseWorkspaceWriteLock,
  reserveWorkspaceWriter,
} from "@/lib/workspace/workspace-write-lock-queries";

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

export async function activatePreparedWorkspaceWriter(input: {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  ownership: ExecutionOwnership;
  authority: AuthorityIdentity;
  candidate: PreparedWorkspaceCandidate;
}): Promise<ActivatedWorkspaceWriter> {
  const contract = bindingContract(input.candidate.binding);
  const leaseExpiresAt = input.ownership.leaseExpiresAt;
  const existing = (await getActiveLocksByInvocation(input.tenantId, input.invocationId)).find(
    (lock) =>
      lock.storageScopeDigest === contract.storageScopeDigest &&
      lock.holderAttemptId === input.attemptId &&
      lock.holderOwnershipId === input.ownership.id &&
      lock.workspaceBindingId === input.candidate.binding.id,
  );
  const reserved = existing
    ? { lock: existing, writerGeneration: existing.writerGeneration }
    : await reserveWorkspaceWriter({
        tenantId: input.tenantId,
        storageScopeDigest: contract.storageScopeDigest as string,
        invocationId: input.invocationId,
        attemptId: input.attemptId,
        ownershipId: input.ownership.id,
        workspaceBindingId: input.candidate.binding.id,
        leaseExpiresAt,
        backendGrantRef: null,
        backendEvidence: { phase: "reserved", resourceId: input.candidate.preparation.resourceId },
      });
  try {
    if (reserved.lock.lockState === "active") {
      const grant = await input.candidate.backend.host.getWriter(
        contract.storageScopeDigest as string,
        reserved.writerGeneration,
      );
      if (!grant) throw new Error("WorkspaceWriterNotFenced");
      await input.candidate.backend.host.assertWriter(grant);
      return { grant, lockId: reserved.lock.id, writerGeneration: reserved.writerGeneration };
    }
    const grant = await input.candidate.backend.host.activateWriter({
      scopeDigest: contract.storageScopeDigest as string,
      writerGeneration: reserved.writerGeneration,
      authority: input.authority,
      expectedStorageIdentity: contract.storageIdentity as string,
      operationId: input.candidate.operationId,
      root: input.candidate.root,
    });
    const active = await activateWorkspaceWriter({
      tenantId: input.tenantId,
      lockId: reserved.lock.id,
      ownershipId: input.ownership.id,
      writerGeneration: reserved.writerGeneration,
      backendGrantRef: grant.grantRef,
      backendEvidence: grant.backendEvidence,
    });
    return { grant, lockId: active.id, writerGeneration: active.writerGeneration };
  } catch (error) {
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

export async function releaseWorkspaceWriter(input: {
  tenantId: string;
  lockId: string;
  ownershipId: string;
  reasonCode: string;
}): Promise<void> {
  await releaseWorkspaceWriteLock(input);
}

function bindingContract(binding: WorkspaceBinding): WorkspaceContinuityContract {
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
