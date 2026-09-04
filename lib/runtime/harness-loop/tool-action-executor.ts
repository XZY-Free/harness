import { createHash } from "node:crypto";
import {
  type ExecuteHarnessToolCallInput,
  type HarnessToolCallResult,
  executeHarnessToolCall,
} from "@/lib/capability/application/execute-harness-tool-call";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import {
  type CapabilityCatalogSnapshot,
  validateHarnessActionAgainstCatalog,
} from "./capability-catalog";
import type { HarnessActionExecutors } from "./loop";

export function createToolActionExecutor(params: {
  tenantId: string;
  executionSubject: ExecutionSubject;
  capabilityCatalog: CapabilityCatalogSnapshot;
  executeToolCall?: (input: ExecuteHarnessToolCallInput) => Promise<HarnessToolCallResult>;
}): NonNullable<HarnessActionExecutors["tool.call"]> {
  const executeToolCall = params.executeToolCall ?? executeHarnessToolCall;
  return async (action, context) => {
    if (context.tenantId !== params.tenantId) {
      throw new Error("TOOL_ACTION_TENANT_MISMATCH");
    }
    if (
      params.executionSubject.tenantId !== params.tenantId ||
      !params.executionSubject.subjectId
    ) {
      throw new Error("TOOL_ACTION_SUBJECT_INVALID");
    }
    const { tool } = validateHarnessActionAgainstCatalog(action, params.capabilityCatalog);
    if (!tool) throw new Error("TOOL_ACTION_NOT_ALLOWED");
    const result = await executeToolCall({
      tenantId: params.tenantId,
      executionSubject: params.executionSubject,
      invocationId: context.invocationId,
      threadId: context.threadId,
      turnId: context.turnId,
      toolId: tool.toolId,
      toolSchemaRevisionId: tool.schemaRevisionId,
      schemaHash: tool.schemaHash,
      operationId: logicalOperationId(
        context.invocationId,
        action.actionId,
        tool.toolId,
        tool.operationId,
      ),
      arguments: action.payload.arguments,
    });
    const authorityRef = `tool-call:${result.toolCallId}`;
    if (
      result.state === "proposed" ||
      result.state === "queued" ||
      result.state === "running" ||
      result.state === "paused"
    ) {
      return {
        authorityRef,
        pending: {
          kind: "tool_call",
          callId: result.toolCallId,
          state:
            result.state === "paused"
              ? "waiting_user"
              : result.state === "proposed" || result.state === "queued"
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
            : (result.errorSummary ?? `${tool.displayName} 执行未成功`),
        sourceRefs: [authorityRef],
        data: {
          state: result.state,
          result: result.resultSummary,
          effectState: result.effectState,
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
