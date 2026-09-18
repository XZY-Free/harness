/**
 * Workspace Writer 围栏的唯一判定（R08 §1/§3）。
 *
 * 平台执行必须被**当前代际的真实 Writer**围栏住：`SHARED_DURABLE` /
 * `CHECKPOINT_RESTORABLE` 的写入由一个受管 W 行授权，只有持有该行、且
 * `writerGeneration` 与 Owner 冻结值一致的代际才允许提交 Runtime 事实。
 *
 * `HOST_AFFINE`（桌面个人目录）的写由绑定设备本机执行，服务端**不是**该目录的
 * Writer：它的 `workspaceWriterGeneration` 正确地恒为 null。把围栏条件写成
 * 「非 NO_PLATFORM_WORKSPACE」会让这类 Workspace 的每一个事件都被判成未围栏，
 * 使"真实 Workspace 的默认入口"整体不可用。因此判据与
 * `requiresManagedWorkspaceWriter` 同源，调用点只负责把 `false` 映射成自己的稳定错误。
 *
 * 两个调用点（Ingress 接纳与 Current Authority 守卫）共用本函数——不允许各自保留一份。
 */
import type { DbOrTx } from "@/lib/db/client";
import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import { requiresManagedWorkspaceWriter } from "@/lib/workspace/managed-workspace-host";
import { getActiveLocksByInvocation } from "@/lib/workspace/workspace-write-lock-queries";

export interface WorkspaceWriterFenceHolder {
  attemptId: string;
  ownershipId: string;
  /** Owner 冻结的 Writer generation；未持有服务端 Writer 时为 null。 */
  writerGeneration: number | null;
}

/**
 * 该 Binding 上的写入是否已被当前 Holder 真实围栏。
 *
 * 返回 `true` = 允许提交；`false` = 调用点必须 fail closed（各自映射稳定错误码）。
 * 不适用围栏的连续性模式（`NO_PLATFORM_WORKSPACE` / `HOST_AFFINE`）恒为 `true`。
 */
export async function isWorkspaceWriterFenced(input: {
  tenantId: string;
  invocationId: string;
  workspaceBinding: WorkspaceBinding;
  holder: WorkspaceWriterFenceHolder;
  executor: DbOrTx;
}): Promise<boolean> {
  if (!requiresManagedWorkspaceWriter(input.workspaceBinding)) return true;
  const generation = input.holder.writerGeneration;
  if (generation === null || generation === undefined) return false;
  const scopeDigest = input.workspaceBinding.storageScopeDigest;
  if (!scopeDigest) return false;
  const locks = await getActiveLocksByInvocation(
    input.tenantId,
    input.invocationId,
    input.executor,
  );
  return locks.some(
    (lock) =>
      lock.storageScopeDigest === scopeDigest &&
      lock.workspaceBindingId === input.workspaceBinding.id &&
      lock.holderAttemptId === input.holder.attemptId &&
      lock.holderOwnershipId === input.holder.ownershipId &&
      lock.writerGeneration === generation,
  );
}
