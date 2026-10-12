/**
 * 可恢复暂停的安全点（R09 §8「首次/暂停/Crash 三种路径都必须可达」）。
 *
 * 「需要可恢复暂停时，Runner 必须先触发本安全点流程拿到 Checkpoint 再发 suspended，
 * 不得仅由测试直接调用 producer」。本模块就是那条生产入口：
 *
 * 1. 只有 CHECKPOINT_RESTORABLE 的 Workspace 才需要（也必须）走这条路径；其它模式
 *    显式返回跳过原因，不做"看起来跑了"的空动作。
 * 2. 请求安全点（登记持久 intent、进入 quiescing）→ 派发持久 checkpoint 命令到 Runtime。
 * 3. 派发是**必需**的：不派发就只留下一个被持有的 Gate（等于把执行卡死），
 *    因此结果里显式区分 `requested` 与 `dispatched`。
 */
import { db } from "@/lib/db/client";
import { getActiveExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { executionBindingTable } from "@/lib/persistence/schema/executions";
import { dispatchCheckpointCommandToRuntime } from "@/lib/runtime/command-dispatch-gateway";
import { requestFilesystemCheckpoint } from "@/lib/workspace/checkpoint-producer";
import type { RecoveryAnchorDeclarations } from "@/lib/workspace/recovery-anchor";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { and, eq } from "drizzle-orm";

export interface RecoverablePauseCheckpointOutcome {
  /** 是否真的请求了安全点。 */
  requested: boolean;
  /** 未请求时的稳定原因（可观测，不是静默跳过）。 */
  reason?: string;
  checkpointIntentId?: string;
  commandId?: string;
  /** 持久命令是否已被派发到 Runtime。 */
  dispatched?: boolean;
  dispatchReason?: string;
}

export async function takeRecoverablePauseCheckpoint(input: {
  tenantId: string;
  invocationId: string;
  requestedById: string;
  requestedByType?: "user" | "service" | "system";
  declarations?: RecoveryAnchorDeclarations;
  dispatchCommand?: (params: {
    tenantId: string;
    commandId: string;
  }) => Promise<{ dispatched: boolean; reason?: string }>;
  checkpointIntentId?: string;
}): Promise<RecoverablePauseCheckpointOutcome> {
  const [binding] = await db
    .select()
    .from(executionBindingTable)
    .where(
      and(
        eq(executionBindingTable.tenantId, input.tenantId),
        eq(executionBindingTable.invocationId, input.invocationId),
      ),
    )
    .limit(1);
  if (!binding) return { requested: false, reason: "binding_missing" };
  const workspace = await getWorkspaceBindingById(input.tenantId, binding.workspaceBindingId);
  if (!workspace) return { requested: false, reason: "workspace_binding_missing" };
  if (workspace.continuityMode !== "CHECKPOINT_RESTORABLE")
    return { requested: false, reason: "not_checkpoint_restorable" };
  const owner = await getActiveExecutionOwnership({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
  });
  if (!owner) return { requested: false, reason: "no_current_executor" };

  const requested = await requestFilesystemCheckpoint({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    ownershipId: owner.id,
    ...(input.declarations ? { declarations: input.declarations } : {}),
    requestedByType: input.requestedByType ?? "system",
    requestedById: input.requestedById,
    ...(input.checkpointIntentId ? { checkpointIntentId: input.checkpointIntentId } : {}),
  });
  const dispatch = input.dispatchCommand ?? dispatchCheckpointCommandToRuntime;
  // 两条实现（注入的测试替身 / 真实 Gateway）返回的都是可判别联合；调用点只关心
  // 「有没有派发出去」与「没派发出去的稳定原因」，因此在此收敛为同一形状。
  const dispatched: { dispatched: boolean; reason?: string } = await dispatch({
    tenantId: input.tenantId,
    commandId: requested.commandId,
  });
  return {
    requested: true,
    checkpointIntentId: requested.checkpointIntentId,
    commandId: requested.commandId,
    dispatched: dispatched.dispatched,
    ...(dispatched.reason ? { dispatchReason: dispatched.reason } : {}),
  };
}
