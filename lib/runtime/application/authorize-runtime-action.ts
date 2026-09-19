import {
  type ExecutionOperationKind,
  type OwnershipTx,
  requireCurrentExecutionAuthority,
} from "@/lib/executions/application/require-current-execution-authority";
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";

/** Parent Invocation authorization gate for ToolCall/AgentCall/other platform actions. */
export async function authorizeRuntimeAction(input: {
  tenantId: string;
  authority: AuthorityIdentity;
  /** A01-03：真实事务类型 —— 围栏必须与调用方的写入同事务。 */
  executor: OwnershipTx;
  requiredPhase?: "activating" | "dispatching" | "executing" | "suspending";
  /** 平台行动接纳默认是新行动（受 Checkpoint Gate 约束）。 */
  operationKind?: ExecutionOperationKind;
}): Promise<void> {
  await requireCurrentExecutionAuthority({
    tenantId: input.tenantId,
    authority: input.authority,
    executor: input.executor,
    requiredPhase: input.requiredPhase ?? "executing",
    operationKind: input.operationKind ?? "new_action",
  });
}
