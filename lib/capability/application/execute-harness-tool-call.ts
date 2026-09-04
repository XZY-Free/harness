import { redactArguments } from "@/lib/capability/redact-arguments";
import {
  createToolCall,
  updateToolCallState,
} from "@/lib/capability/tool-call-queries";
import {
  getToolById,
  getToolSchemaRevisionById,
} from "@/lib/capability/tool-queries";

export interface ExecuteHarnessToolCallInput {
  tenantId: string;
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
  state: "proposed" | "paused" | "running" | "succeeded" | "failed" | "cancelled" | "unknown_effect";
  resultSummary: unknown;
  errorCode: string | null;
  errorSummary: string | null;
}

/**
 * Harness tool.call 到既有 ToolCall 领域的唯一应用入口。
 *
 * 能力选择和 Schema 来自 Invocation 冻结目录；这里仅复核同租户 Tool 仍启用、
 * exact SchemaRevision/digest 未损坏，然后复用正式 ToolCall 创建与状态服务。
 * Provider 执行仍由既有 ToolCall worker/adapter 负责，本服务不直连 Provider。
 */
export async function executeHarnessToolCall(
  input: ExecuteHarnessToolCallInput,
): Promise<HarnessToolCallResult> {
  const tool = await getToolById({ tenantId: input.tenantId, toolId: input.toolId });
  if (!tool || tool.lifecycleState !== "enabled") {
    throw new Error("TOOL_CAPABILITY_REVOKED");
  }
  const revision = await getToolSchemaRevisionById({
    tenantId: input.tenantId,
    schemaRevisionId: input.toolSchemaRevisionId,
  });
  if (
    !revision ||
    revision.toolId !== tool.id ||
    revision.schemaHash !== input.schemaHash ||
    revision.revisionState !== "published"
  ) {
    throw new Error("TOOL_FROZEN_SCHEMA_UNAVAILABLE");
  }
  let call = await createToolCall({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    threadId: input.threadId || null,
    turnId: input.turnId || null,
    toolId: input.toolId,
    toolSchemaRevisionId: input.toolSchemaRevisionId,
    schemaHash: input.schemaHash,
    operationId: input.operationId,
    argumentsRedactedJson: redactArguments(input.arguments),
  });
  if (call.callState === "proposed") {
    call = await updateToolCallState({
      tenantId: input.tenantId,
      toolCallId: call.id,
      toState: "running",
    });
  }
  return {
    toolCallId: call.id,
    state: call.callState as HarnessToolCallResult["state"],
    resultSummary: call.resultSummaryJson,
    errorCode: call.errorCode,
    errorSummary: call.errorSummary,
  };
}
