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
    if (!context.authority) throw new Error("NotCurrentExecutor");
    if (!context.threadId || !context.turnId) {
      // R06 §1：ToolCall 的归属与执行目标都建立在 Thread 事实之上。无 Thread 的 Job
      // 主体下必须**显式**返回"该能力不支持"，既不能补一个假 Thread，也不能静默丢弃。
      return {
        observation: {
          observationType: "tool",
          summary: "tool.call 需要 Thread 归属，当前执行主体没有 Thread",
          sourceRefs: [],
          data: {
            actionId: action.actionId,
            toolId: action.payload.toolId,
            unsupported: "THREAD_REQUIRED",
          },
        },
      };
    }
    const result = await executeToolCall({
      tenantId: params.tenantId,
      executionSubject: params.executionSubject,
      invocationId: context.invocationId,
      authority: context.authority,
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
