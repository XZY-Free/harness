import type { WorkspaceHost, WorkspacePreparation } from "@/lib/workspace/workspace-host";

/** Cleanup is driven by the persisted candidate resource identity, not stack unwinding. */
export async function cleanupWorkspaceCandidate(
  host: WorkspaceHost,
  preparation: WorkspacePreparation,
): Promise<void> {
  await host.cleanup(preparation);
}
