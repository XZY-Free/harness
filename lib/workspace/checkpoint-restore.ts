import { mkdir } from "node:fs/promises";
import { getFilesystemCheckpoint } from "@/lib/workspace/checkpoint-store";
import { FileSnapshotStorage } from "@/lib/workspace/snapshot-storage";
import type { WorkspaceBackend } from "@/lib/workspace/workspace-backend";
import { validateWorkspaceContract } from "@/lib/workspace/workspace-contract";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";

export async function restoreFilesystemCheckpoint(input: {
  tenantId: string;
  checkpointId: string;
  destination: string;
  storageRoot: string;
  backend?: WorkspaceBackend;
  expected: {
    invocationId: string;
    workspaceBindingId: string;
    environmentDefinitionRevisionId: string;
    recoveryAnchorDigest: string;
    recoveryVersion: number;
  };
}): Promise<{ checkpointId: string; destination: string; manifestDigest: string }> {
  const checkpoint = await getFilesystemCheckpoint(input.tenantId, input.checkpointId);
  if (!checkpoint) throw new Error("CheckpointStale");
  if (
    checkpoint.invocationId !== input.expected.invocationId ||
    checkpoint.workspaceBindingId !== input.expected.workspaceBindingId ||
    checkpoint.environmentDefinitionRevisionId !== input.expected.environmentDefinitionRevisionId ||
    checkpoint.recoveryAnchorDigest !== input.expected.recoveryAnchorDigest ||
    checkpoint.recoveryVersion !== input.expected.recoveryVersion
  ) {
    throw new Error("CheckpointStale");
  }
  const binding = await getWorkspaceBindingById(input.tenantId, checkpoint.workspaceBindingId);
  if (!binding) throw new Error("CheckpointStale");
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
  await mkdir(input.destination, { recursive: true });
  const storage = new FileSnapshotStorage(input.storageRoot);
  if (input.backend)
    await input.backend.host.restore({
      manifestRef: checkpoint.manifestRef,
      manifestDigest: checkpoint.manifestDigest,
      destination: input.destination,
      storage,
    });
  else
    await storage.restoreSnapshot(
      await storage.readManifest(checkpoint.manifestRef, checkpoint.manifestDigest),
      input.destination,
    );
  return {
    checkpointId: checkpoint.id,
    destination: input.destination,
    manifestDigest: checkpoint.manifestDigest,
  };
}
