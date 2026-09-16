/** Managed WorkspaceHost process entrypoint. */
import { FileSnapshotStorage } from "@/lib/workspace/snapshot-storage";
import { ManagedWorkspaceHost } from "@/lib/workspace/workspace-host";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`[workspace-host] 缺少必需配置 ${name}`);
  return value;
}

export function createWorkspaceHostFromEnvironment(): ManagedWorkspaceHost {
  const root = required("SNOWHARNESS_WORKSPACE_HOST_ROOT");
  const snapshotRoot = required("SNOWHARNESS_SNAPSHOT_STORAGE_ROOT");
  const hostIdentity = required("SNOWHARNESS_WORKSPACE_HOST_IDENTITY");
  return new ManagedWorkspaceHost({
    root,
    hostIdentity,
    snapshotStorage: new FileSnapshotStorage(snapshotRoot),
  });
}

export function runWorkspaceHostProcess(): Promise<void> {
  createWorkspaceHostFromEnvironment();
  return new Promise((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}

if (process.argv[1]?.endsWith("workspace-host.ts")) {
  runWorkspaceHostProcess().catch((error) => {
    console.error("[workspace-host] 启动失败", error);
    process.exitCode = 1;
  });
}
