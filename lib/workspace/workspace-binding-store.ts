import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import { computeWorkspaceContractDigest } from "@/lib/workspace/workspace-contract";
import { createWorkspaceBinding, getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";

export { getWorkspaceBindingById };

/** Creates the explicit no-platform continuity contract used by cloud executions. */
export async function createNoPlatformWorkspaceBinding(
  tenantId: string,
  createdBy: string,
): Promise<WorkspaceBinding> {
  const semantics = {
    kind: "none",
    caseSensitive: true,
    symlinks: false,
    permissions: false,
    hardlinks: false,
    specialFiles: false,
    xattrsAcl: false,
    mtime: "not_applicable",
  };
  const contract = {
    bindingId: "pending",
    continuityMode: "NO_PLATFORM_WORKSPACE" as const,
    storageScopeDigest: null,
    hostIdentity: null,
    storageIdentity: null,
    backendKind: null,
    filesystemSemantics: semantics,
    checkpointPolicy: null,
  };
  return createWorkspaceBinding({
    tenantId,
    workspaceId: null,
    continuityMode: contract.continuityMode,
    bindingType: null,
    filesystemSemantics: semantics,
    contractDigest: computeWorkspaceContractDigest(contract),
    createdBy,
  });
}
