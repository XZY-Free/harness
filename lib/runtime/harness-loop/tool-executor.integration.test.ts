import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { DEFAULT_TENANT_ID } from "@/lib/identity/tenant-bootstrap";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildCapabilityCatalogSnapshot } from "./capability-catalog";
import { createToolActionExecutor } from "./tool-action-executor";

const executionSubject = {
  tenantId: DEFAULT_TENANT_ID,
  subjectType: "user" as const,
  subjectId: "test-user",
};

let invocationId: string;
let authority: AuthorityIdentity;
let catalog: ReturnType<typeof buildCapabilityCatalogSnapshot>["snapshot"];

beforeAll(async () => {
  await ensureDefaultTenant();
  const seeded = await seedPreparedRuntimeAttempt({ tenantId: DEFAULT_TENANT_ID });
  const acquired = await acquireTestRuntimeAuthority({
    tenantId: DEFAULT_TENANT_ID,
    invocationId: seeded.invocation.id,
    attemptId: seeded.attempt.id,
    runtimeRevisionId: seeded.binding.runtimeRevisionId,
  });
  invocationId = seeded.invocation.id;
  authority = acquired.authority;
  catalog = buildCapabilityCatalogSnapshot({
    invocationId,
    preferredAgentId: null,
    agentCandidate: null,
    tools: [
      {
        toolId: "tool-mail",
        operationId: "send-email",
        schemaRevisionId: "schema-7",
        schemaHash: `sha256:${"7".repeat(64)}`,
        executionContractDigest: `sha256:${"8".repeat(64)}`,
        displayName: "发送邮件",
        description: "发送邮件",
        inputSchema: {
          type: "object",
          required: ["recipient"],
          properties: { recipient: { type: "string" } },
        },
        sideEffect: "write",
        idempotent: true,
      },
    ],
    knowledgeSources: [],
    sourceRefs: [],
    now: new Date("2026-09-04T04:20:00.000Z"),
  }).snapshot;
});

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

describe("production tool.call executor", () => {
  it("使用稳定逻辑幂等键调用 ToolCall 应用服务，并把 pending 交回 Harness", async () => {
    const executeToolCall = vi.fn(async () => ({
      toolCallId: "call-1",
      state: "queued" as const,
      resultSummary: null,
      effectState: null,
      errorCode: null,
      errorSummary: null,
    }));
    const executor = createToolActionExecutor({
      tenantId: DEFAULT_TENANT_ID,
      executionSubject,
      capabilityCatalog: catalog,
      executeToolCall,
    });

    await expect(
      executor(action, {
        tenantId: DEFAULT_TENANT_ID,
        invocationId,
        threadId: "thread-1",
        turnId: "turn-1",
        actionDigest: "digest",
        authority,
      }),
    ).resolves.toEqual({
      authorityRef: "tool-call:call-1",
      pending: { kind: "tool_call", callId: "call-1", state: "queued" },
    });
    expect(executeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        executionSubject,
        authority,
        operationId: `${invocationId}:action-9:tool-mail:send-email`,
        toolSchemaRevisionId: "schema-7",
        schemaHash: `sha256:${"7".repeat(64)}`,
      }),
    );
  });

  it("把成功和失败结果转换为结构化 Observation，不结束父 Invocation", async () => {
    const success = createToolActionExecutor({
      tenantId: DEFAULT_TENANT_ID,
      executionSubject,
      capabilityCatalog: catalog,
      executeToolCall: async () => ({
        toolCallId: "call-success",
        state: "succeeded",
        resultSummary: { messageId: "m-1" },
        effectState: null,
        errorCode: null,
        errorSummary: null,
      }),
    });
    const failure = createToolActionExecutor({
      tenantId: DEFAULT_TENANT_ID,
      executionSubject,
      capabilityCatalog: catalog,
      executeToolCall: async () => ({
        toolCallId: "call-failed",
        state: "failed",
        resultSummary: null,
        effectState: null,
        errorCode: "PROVIDER_FAILED",
        errorSummary: "发送失败",
      }),
    });
    const context = {
      tenantId: DEFAULT_TENANT_ID,
      executionSubject,
      invocationId,
      threadId: "thread-1",
      turnId: "turn-1",
      actionDigest: "digest",
      authority,
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

  it("Catalog confirmation 不再有授权语义，仍由 canonical service 创建同一 ToolCall", async () => {
    const executeToolCall = vi.fn(async () => ({
      toolCallId: "call-paused",
      state: "paused" as const,
      resultSummary: null,
      effectState: null,
      errorCode: null,
      errorSummary: null,
    }));
    const executor = createToolActionExecutor({
      tenantId: DEFAULT_TENANT_ID,
      executionSubject,
      capabilityCatalog: catalog,
      executeToolCall,
    });
    const result = await executor(action, {
      tenantId: DEFAULT_TENANT_ID,
      invocationId,
      threadId: "thread-1",
      turnId: "turn-1",
      actionDigest: "digest",
      authority,
    });
    expect(executeToolCall).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      authorityRef: "tool-call:call-paused",
      pending: { kind: "tool_call", callId: "call-paused", state: "waiting_user" },
    });
  });
});
