import { assertScopeLockProviderAvailable } from "@/lib/workspace/scope-lock";
/**
 * 受管 WorkspaceHost 服务进程入口。
 *
 * 这是一个真实常驻服务（不是只在测试里 new 的对象）：Runtime/Worker 通过 RPC 使用它，
 * 由它持有真实 Writer 进程组句柄并负责终止与排空。
 */
import { FileSnapshotStorage } from "@/lib/workspace/snapshot-storage";
import { WorkspaceHostBroker, listenWorkspaceHostRpc } from "@/lib/workspace/workspace-host-server";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`[workspace-host] 缺少必需配置 ${name}`);
  return value;
}

export function createWorkspaceHostFromEnvironment(): WorkspaceHostBroker {
  assertScopeLockProviderAvailable();
  const root = required("SNOWHARNESS_WORKSPACE_HOST_ROOT");
  const snapshotRoot = required("SNOWHARNESS_SNAPSHOT_STORAGE_ROOT");
  const hostIdentity = process.env.SNOWHARNESS_WORKSPACE_HOST_IDENTITY?.trim();
  return new WorkspaceHostBroker({
    root,
    // 未显式注入时使用持久化的确定性派生身份：进程重启不换身份。
    ...(hostIdentity ? { hostIdentity } : {}),
    snapshotStorage: new FileSnapshotStorage(snapshotRoot),
  });
}

export async function runWorkspaceHostProcess(): Promise<void> {
  const broker = createWorkspaceHostFromEnvironment();
  const port = Number.parseInt(process.env.SNOWHARNESS_WORKSPACE_HOST_PORT ?? "0", 10);
  const hostname = process.env.SNOWHARNESS_WORKSPACE_HOST_BIND?.trim() || "127.0.0.1";
  const serving = await listenWorkspaceHostRpc({ broker, port, hostname });
  process.stdout.write(`[workspace-host] listening ${serving.url}\n`);
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", () => resolve());
    process.once("SIGINT", () => resolve());
  });
  await serving.close();
}

if (process.argv[1]?.endsWith("workspace-host.ts")) {
  runWorkspaceHostProcess().catch((error) => {
    console.error("[workspace-host] 启动失败", error);
    process.exitCode = 1;
  });
}
