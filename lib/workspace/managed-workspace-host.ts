/**
 * 受管 WorkspaceHost 的生产解析（R01 §1「Workspace执行资源（BOUND时必需）」）。
 *
 * 服务端只有在**确实能拿到受管 Host** 时才声明 Workspace 执行资源可用：
 * - `SNOWHARNESS_WORKSPACE_HOST_URL`：连接到常驻 `workspace-host` 服务进程（RPC）。
 * - `SNOWHARNESS_WORKSPACE_HOST_ROOT`：同进程内直接构造 Broker（单机/测试部署）。
 * 两者都没有 → `WorkspaceNotReadyError`，由调用方保留可恢复失败事实，
 * **绝不**降级成 NO_PLATFORM_WORKSPACE。
 */
import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import { FileSnapshotStorage } from "@/lib/workspace/snapshot-storage";
import type { WorkspaceHost } from "@/lib/workspace/workspace-host";
import {
  createRemoteWorkspaceHost,
  createWorkspaceHostBroker,
} from "@/lib/workspace/workspace-host-server";

export class WorkspaceNotReadyError extends Error {
  readonly stableCode = "WorkspaceNotReady";
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceNotReady";
  }
}

export class WorkspaceHostUnavailableError extends Error {
  readonly stableCode = "WorkspaceHostUnavailable";
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceHostUnavailable";
  }
}

export interface ManagedWorkspaceHostOverrides {
  root?: string;
  snapshotStorageRoot?: string;
  hostIdentity?: string;
  endpointUrl?: string;
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * 解析 binding 对应的受管 WorkspaceHost。
 *
 * 身份必须与 Binding 冻结的 `hostIdentity` / `storageScopeDigest` 一致，
 * 否则拒绝（跨 Host 恢复是冻结契约禁止的）。
 */
export async function resolveManagedWorkspaceHost(
  binding: WorkspaceBinding,
  overrides: ManagedWorkspaceHostOverrides = {},
): Promise<WorkspaceHost> {
  if (binding.backendKind !== "managed_host") {
    throw new WorkspaceHostUnavailableError(`不受支持的 Workspace backend：${binding.backendKind}`);
  }
  const endpointUrl = overrides.endpointUrl ?? envValue("SNOWHARNESS_WORKSPACE_HOST_URL");
  const host: WorkspaceHost = endpointUrl
    ? createRemoteWorkspaceHost(endpointUrl)
    : createLocalManagedWorkspaceHost(binding, overrides);
  const identity = await (
    host as WorkspaceHost & {
      probeIdentity(): Promise<{ hostIdentity: string; scopeDigest: string }>;
    }
  ).probeIdentity();
  if (binding.hostIdentity && identity.hostIdentity !== binding.hostIdentity) {
    throw new WorkspaceHostUnavailableError("WorkspaceHost 身份与 Binding 冻结事实不一致");
  }
  if (binding.storageScopeDigest && identity.scopeDigest !== binding.storageScopeDigest) {
    throw new WorkspaceHostUnavailableError("WorkspaceHost 物理 scope 与 Binding 冻结事实不一致");
  }
  return host;
}

function createLocalManagedWorkspaceHost(
  binding: WorkspaceBinding,
  overrides: ManagedWorkspaceHostOverrides,
): WorkspaceHost {
  const root = overrides.root ?? envValue("SNOWHARNESS_WORKSPACE_HOST_ROOT");
  if (!root) {
    throw new WorkspaceNotReadyError(
      `Workspace ${binding.id} 需要受管 WorkspaceHost，但未配置 SNOWHARNESS_WORKSPACE_HOST_URL / SNOWHARNESS_WORKSPACE_HOST_ROOT`,
    );
  }
  const hostIdentity = overrides.hostIdentity ?? envValue("SNOWHARNESS_WORKSPACE_HOST_IDENTITY");
  const snapshotRoot =
    overrides.snapshotStorageRoot ?? envValue("SNOWHARNESS_SNAPSHOT_STORAGE_ROOT");
  return createWorkspaceHostBroker({
    root,
    ...(hostIdentity ? { hostIdentity } : {}),
    ...(snapshotRoot ? { snapshotStorage: new FileSnapshotStorage(snapshotRoot) } : {}),
  });
}

/**
 * 该 Binding 是否需要服务端持有的 Workspace Writer。
 *
 * - `NO_PLATFORM_WORKSPACE`：用户/领域显式冻结的 NO_PLATFORM 合同，不需要。
 * - `HOST_AFFINE`（桌面个人目录）：写由 Desktop 本机执行（Gateway → Desktop Bridge），
 *   服务端**不是**该目录的 Writer；这是被冻结的领域事实，不是降级。
 * - `SHARED_DURABLE` / `CHECKPOINT_RESTORABLE`：服务端受管 Writer，必须解析出 Host。
 */
export function requiresManagedWorkspaceWriter(binding: WorkspaceBinding): boolean {
  return (
    binding.continuityMode === "SHARED_DURABLE" ||
    binding.continuityMode === "CHECKPOINT_RESTORABLE"
  );
}

/** 受管 Workspace 的真实执行资源（R01 §1「Workspace执行资源（BOUND时必需）」）。 */
export interface ManagedWorkspaceResources {
  host: WorkspaceHost;
  /** Writer 激活使用的物理根（与 Host 身份同源，不是调用方提交的字符串）。 */
  root: string;
  /** CHECKPOINT_RESTORABLE 的内容寻址存储根；未配置时为空。 */
  snapshotStorageRoot?: string;
}

/**
 * 解析受管 Workspace 的真实执行资源：Host + 物理根 + Snapshot 存储根。
 *
 * 与 `resolveManagedWorkspaceHost` 同源解析，但额外给出 `root`/`snapshotStorageRoot`，
 * 使组合层不必各自重复读环境配置（"一个修复、两个版本"）。
 * 远端 Host（`SNOWHARNESS_WORKSPACE_HOST_URL`）没有本地根概念，使用 Binding 的
 * `locationRef` 作为该 Host 上的目录引用。
 */
export async function resolveManagedWorkspaceResources(
  binding: WorkspaceBinding,
  overrides: ManagedWorkspaceHostOverrides = {},
): Promise<ManagedWorkspaceResources> {
  const host = await resolveManagedWorkspaceHost(binding, overrides);
  const endpointUrl = overrides.endpointUrl ?? envValue("SNOWHARNESS_WORKSPACE_HOST_URL");
  const localRoot = overrides.root ?? envValue("SNOWHARNESS_WORKSPACE_HOST_ROOT");
  const root = endpointUrl ? binding.locationRef : (localRoot ?? binding.locationRef);
  if (!root) {
    throw new WorkspaceNotReadyError(
      `Workspace ${binding.id} 缺少物理根引用（locationRef / 部署配置）`,
    );
  }
  const snapshotStorageRoot =
    overrides.snapshotStorageRoot ?? envValue("SNOWHARNESS_SNAPSHOT_STORAGE_ROOT");
  return {
    host,
    root,
    ...(snapshotStorageRoot ? { snapshotStorageRoot } : {}),
  };
}
