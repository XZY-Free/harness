import { createHash } from "node:crypto";
import {
  executeHarnessToolCall,
  type ExecuteHarnessToolCallInput,
  type HarnessToolCallResult,
} from "@/lib/capability/application/execute-harness-tool-call";
import type { HarnessActionExecutors } from "./loop";
import {
  type CapabilityCatalogSnapshot,
  validateHarnessActionAgainstCatalog,
} from "./capability-catalog";

export function createToolActionExecutor(params: {
  tenantId: string;
  capabilityCatalog: CapabilityCatalogSnapshot;
  executeToolCall?: (input: ExecuteHarnessToolCallInput) => Promise<HarnessToolCallResult>;
}): NonNullable<HarnessActionExecutors["tool.call"]> {
  const executeToolCall = params.executeToolCall ?? executeHarnessToolCall;
  return async (action, context) => {
    if (context.tenantId !== params.tenantId) {
      throw new Error("TOOL_ACTION_TENANT_MISMATCH");
    }
    const { tool } = validateHarnessActionAgainstCatalog(action, params.capabilityCatalog);
    if (!tool) throw new Error("TOOL_ACTION_NOT_ALLOWED");
    if (tool.confirmation === "required") {
      return {
        authorityRef: `capability-catalog:${context.invocationId}:${action.actionId}`,
        observation: {
          observationType: "tool",
          summary: `${tool.displayName} 需要用户确认后执行`,
          sourceRefs: [`tool:${tool.toolId}:schema:${tool.schemaRevisionId}`],
          data: {
            state: "waiting_user",
            toolId: tool.toolId,
            operationId: tool.operationId,
          },
        },
        waitingForUser: {
          requestType: "input",
          purpose: "tool_confirmation",
          prompt: `确认执行“${tool.displayName}”吗？`,
          inputSchema: {
            type: "object",
            required: ["approved"],
            properties: { approved: { type: "boolean" } },
            additionalProperties: false,
          },
        },
      };
    }
    const result = await executeToolCall({
      tenantId: params.tenantId,
      invocationId: context.invocationId,
      threadId: context.threadId,
      turnId: context.turnId,
      toolId: tool.toolId,
      toolSchemaRevisionId: tool.schemaRevisionId,
      schemaHash: tool.schemaHash,
      operationId: logicalOperationId(context.invocationId, action.actionId, tool.toolId, tool.operationId),
      arguments: action.payload.arguments,
    });
    const authorityRef = `tool-call:${result.toolCallId}`;
    if (result.state === "proposed" || result.state === "running" || result.state === "paused") {
      return {
        authorityRef,
        pending: {
          kind: "tool_call",
          callId: result.toolCallId,
          state:
            result.state === "paused"
              ? "waiting_user"
              : result.state === "proposed"
                ? "queued"
                : "running",
        },
      };
    }
    return {
      authorityRef,
      observation: {
        observationType: "tool",
        summary:
          result.state === "succeeded"
            ? `${tool.displayName} 执行完成`
            : result.errorSummary ?? `${tool.displayName} 执行未成功`,
        sourceRefs: [authorityRef],
        data: {
          state: result.state,
          result: result.resultSummary,
          errorCode: result.errorCode,
        },
      },
    };
  };
}

export function logicalOperationId(
  invocationId: string,
  actionId: string,
  toolId: string,
  operationId: string,
): string {
  const plain = `${invocationId}:${actionId}:${toolId}:${operationId}`;
  if (plain.length <= 128) return plain;
  return `harness:${createHash("sha256").update(plain).digest("hex")}`;
}
