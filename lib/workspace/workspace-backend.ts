import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import type { SnapshotStorageRef } from "@/lib/workspace/snapshot-storage";
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
  /**
   * Independent content-addressed Snapshot Storage reference for CHECKPOINT_RESTORABLE.
   *
   * A06：**始终存在**。部署配置了物理根就是 `file`，否则由 Broker 用它自己持有的默认
   * 存储（`broker_default`）—— 组合层不许把"没配路径"表达成"没有存储能力"，那会让默认
   * Checkpoint 路径在装配层就恒 `WorkspaceNotReady`。
   */
  snapshotStorage: SnapshotStorageRef;
}

export function createWorkspaceBackend(host: WorkspaceHost): WorkspaceBackend {
  return { kind: "managed_host", host };
}
