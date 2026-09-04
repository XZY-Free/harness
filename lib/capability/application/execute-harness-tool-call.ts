import { applyToolCall } from "@/lib/capability/application/apply-tool-call";
import { getEffectRecordByToolCall } from "@/lib/capability/effect-queries";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";

export interface ExecuteHarnessToolCallInput {
  tenantId: string;
  executionSubject: ExecutionSubject;
  invocationId: string;
  threadId: string;
  turnId: string;
  toolId: string;
  toolSchemaRevisionId: string;
  schemaHash: string;
  operationId: string;
  arguments: Record<string, unknown>;
}

export interface HarnessToolCallResult {
  toolCallId: string;
  state:
    | "proposed"
    | "paused"
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "unknown_effect";
  resultSummary: unknown;
  errorCode: string | null;
  errorSummary: string | null;
  effectState: string | null;
}

/**
 * Harness tool.call 到既有 ToolCall 领域的唯一应用入口。
 *
 * Hosted Harness 与 External Gateway 共用 applyToolCall；这里不再拥有权限或状态机语义。
 */
export async function executeHarnessToolCall(
  input: ExecuteHarnessToolCallInput,
): Promise<HarnessToolCallResult> {
  const result = await applyToolCall({
    tenantId: input.tenantId,
    executionSubject: input.executionSubject,
    invocationId: input.invocationId,
    toolId: input.toolId,
    toolSchemaRevisionId: input.toolSchemaRevisionId,
    schemaHash: input.schemaHash,
    operationId: input.operationId,
    arguments: input.arguments,
  });
  const call = result.toolCall;
  const effect = await getEffectRecordByToolCall(input.tenantId, call.id);
  return {
    toolCallId: call.id,
    state: call.callState as HarnessToolCallResult["state"],
    resultSummary: call.resultSummaryJson,
    errorCode: call.errorCode,
    errorSummary: call.errorSummary,
    effectState: effect?.effectState ?? null,
  };
}
