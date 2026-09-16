import type { DbOrTx } from "@/lib/db/client";
import { requireCurrentExecutionAuthority } from "@/lib/executions/application/require-current-execution-authority";
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";

/** Parent Invocation authorization gate for ToolCall/AgentCall/other platform actions. */
export async function authorizeRuntimeAction(input: {
  tenantId: string;
  authority: AuthorityIdentity;
  executor: DbOrTx;
  requiredPhase?: "activating" | "dispatching" | "executing" | "suspending";
}): Promise<void> {
  await requireCurrentExecutionAuthority({
    tenantId: input.tenantId,
    authority: input.authority,
    executor: input.executor,
    requiredPhase: input.requiredPhase ?? "executing",
  });
}
