import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import type { WorkspaceHost } from "@/lib/workspace/workspace-host";

/** Backend port used by preparation, writer fencing, safe-points and snapshots. */
export interface WorkspaceBackend {
  readonly kind: "managed_host";
  readonly host: WorkspaceHost;
}

/** Explicit managed dependencies required to prepare and activate a Workspace candidate. */
export interface WorkspaceExecutionResources {
  binding: WorkspaceBinding;
  backend: WorkspaceBackend;
  root: string;
  /** Independent content-addressed Snapshot Storage root for CHECKPOINT_RESTORABLE. */
  snapshotStorageRoot?: string;
}

export function createWorkspaceBackend(host: WorkspaceHost): WorkspaceBackend {
  return { kind: "managed_host", host };
}
