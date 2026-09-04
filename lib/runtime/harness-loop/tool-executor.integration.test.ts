import { describe, expect, it, vi } from "vitest";
import { buildCapabilityCatalogSnapshot } from "./capability-catalog";
import { createToolActionExecutor } from "./tool-action-executor";

const catalog = buildCapabilityCatalogSnapshot({
  invocationId: "inv-tool",
  preferredAgentId: null,
  agentCandidate: null,
  tools: [
    {
      toolId: "tool-mail",
      operationId: "send-email",
      schemaRevisionId: "schema-7",
      schemaHash: `sha256:${"7".repeat(64)}`,
      displayName: "发送邮件",
      description: "发送邮件",
      inputSchema: {
        type: "object",
        required: ["recipient"],
        properties: { recipient: { type: "string" } },
      },
      sideEffect: "write",
      confirmation: "none",
      idempotent: true,
    },
  ],
  knowledgeSources: [],
  sourceRefs: [],
  now: new Date("2026-09-04T04:20:00.000Z"),
}).snapshot;

const action = {
  actionId: "action-9",
  stepNo: 1,
  actionType: "tool.call" as const,
  purposeCode: "notify",
  shortPurpose: "发送通知",
  payload: {
    toolId: "tool-mail",
    operationId: "send-email",
    arguments: { recipient: "employee@example.com" },
  },
};

const executionSubject = {
  tenantId: "tenant-1",
  subjectType: "user" as const,
  subjectId: "employee-42",
};

describe("production tool.call executor", () => {
  it("使用稳定逻辑幂等键调用 ToolCall 应用服务，并把 pending 交回 Harness", async () => {
    const executeToolCall = vi.fn(async () => ({
      toolCallId: "call-1",
      state: "running" as const,
      resultSummary: null,
      errorCode: null,
      errorSummary: null,
    }));
    const executor = createToolActionExecutor({
      tenantId: "tenant-1",
      executionSubject,
      capabilityCatalog: catalog,
      executeToolCall,
    });

    await expect(
      executor(action, {
        tenantId: "tenant-1",
        invocationId: "inv-tool",
        threadId: "thread-1",
        turnId: "turn-1",
        actionDigest: "digest",
      }),
    ).resolves.toEqual({
      authorityRef: "tool-call:call-1",
      pending: { kind: "tool_call", callId: "call-1", state: "running" },
    });
    expect(executeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        executionSubject,
        operationId: "inv-tool:action-9:tool-mail:send-email",
        toolSchemaRevisionId: "schema-7",
        schemaHash: `sha256:${"7".repeat(64)}`,
      }),
    );
  });

  it("把成功和失败结果转换为结构化 Observation，不结束父 Invocation", async () => {
    const success = createToolActionExecutor({
      tenantId: "tenant-1",
      executionSubject,
      capabilityCatalog: catalog,
      executeToolCall: async () => ({
        toolCallId: "call-success",
        state: "succeeded",
        resultSummary: { messageId: "m-1" },
        errorCode: null,
        errorSummary: null,
      }),
    });
    const failure = createToolActionExecutor({
      tenantId: "tenant-1",
      executionSubject,
      capabilityCatalog: catalog,
      executeToolCall: async () => ({
        toolCallId: "call-failed",
        state: "failed",
        resultSummary: null,
        errorCode: "PROVIDER_FAILED",
        errorSummary: "发送失败",
      }),
    });
    const context = {
      tenantId: "tenant-1",
      executionSubject,
      invocationId: "inv-tool",
      threadId: "thread-1",
      turnId: "turn-1",
      actionDigest: "digest",
    };

    await expect(success(action, context)).resolves.toMatchObject({
      authorityRef: "tool-call:call-success",
      observation: { observationType: "tool", data: { state: "succeeded" } },
    });
    await expect(failure(action, context)).resolves.toMatchObject({
      authorityRef: "tool-call:call-failed",
      observation: { observationType: "tool", data: { state: "failed" } },
    });
  });

  it("需要确认时不创建 ToolCall，进入正式 user_action 请求", async () => {
    const executeToolCall = vi.fn();
    const requiringConfirmation = structuredClone(catalog);
    requiringConfirmation.tools[0]!.confirmation = "required";
    const executor = createToolActionExecutor({
      tenantId: "tenant-1",
      executionSubject,
      capabilityCatalog: requiringConfirmation,
      executeToolCall,
    });
    const result = await executor(action, {
      tenantId: "tenant-1",
      invocationId: "inv-tool",
      threadId: "thread-1",
      turnId: "turn-1",
      actionDigest: "digest",
    });
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      observation: { observationType: "tool" },
      waitingForUser: { requestType: "input", purpose: "tool_confirmation" },
    });
  });
});
