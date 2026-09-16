import { getActiveExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { validateWorkspaceContract } from "@/lib/workspace/workspace-contract";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";

export async function requireWorkspaceReadiness(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  workspaceBindingId: string;
  expectedWriterGeneration?: number | null;
}): Promise<{ bindingId: string; continuityMode: string; writerGeneration: number | null }> {
  const binding = await getWorkspaceBindingById(input.tenantId, input.workspaceBindingId);
  if (!binding) throw new Error("WorkspaceNotReady");
  validateWorkspaceContract({
    bindingId: binding.id,
    continuityMode: binding.continuityMode,
    contractDigest: binding.contractDigest,
    storageScopeDigest: binding.storageScopeDigest,
    hostIdentity: binding.hostIdentity,
    storageIdentity: binding.storageIdentity,
    backendKind: binding.backendKind,
    filesystemSemantics: binding.filesystemSemantics as never,
    checkpointPolicy: binding.checkpointPolicy as Record<string, unknown> | null,
  });
  const owner = await getActiveExecutionOwnership({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
  });
  if (!owner || owner.id !== input.ownershipId || owner.leaseExpiresAt <= new Date())
    throw new Error("NotCurrentExecutor");
  if (
    input.expectedWriterGeneration !== undefined &&
    owner.workspaceWriterGeneration !== input.expectedWriterGeneration
  )
    throw new Error("WorkspaceWriterNotFenced");
  return {
    bindingId: binding.id,
    continuityMode: binding.continuityMode,
    writerGeneration: owner.workspaceWriterGeneration,
  };
}
