import type { StartInvocationRequestBody } from "@/lib/runtime/runtime-client";
import {
  type A2ATestProvider,
  A2A_TEST_PROVIDER_CAPABILITY_MANIFEST,
  A2A_TEST_PROVIDER_CONTEXT_CONTRACT,
  startA2ATestProvider,
} from "@/lib/runtime/test-support/a2a-test-provider";
/**
 * 仓内 A2A Provider 黑盒 E2E 测试（07 §2/§5/§9，Batch 9 Gate — Platform PASS 子集；
 * HR 公开合同 wire 冻结版）。
 *
 * 黑盒原则：Transport 只通过 Agent Card + 真实 HTTP/SSE wire 与 Provider 交互
 * （真实 fetch，无 fetchImpl 注入）。断言全部基于 wire 事实（captured 请求 +
 * 归一化事件），不读 Provider 内部状态形成合同。
 *
 * HR 官方顺序（Provider fixture 冻结）：status working → artifact-update
 * （TextPart 追问 + DataPart 公共结构化结果）→ input-required 无
 * status.message；message/send（resume）同步返回完整 Task
 * （kind:"task"，id/contextId/status/artifacts）。
 */
import type { A2AEventBatchSink } from "@/lib/runtime/transport/a2a-transport";
import { createA2ATransport } from "@/lib/runtime/transport/a2a-transport";
import { RuntimeTransportError } from "@/lib/runtime/transport/runtime-transport";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** 测试共享 Provider（真实 HTTP server）；事件 batch 每用例独立收集，避免跨用例干扰。 */
let provider: A2ATestProvider;

beforeAll(async () => {
  provider = await startA2ATestProvider("completed");
});

afterAll(async () => {
  await provider.close();
});

/** 每用例独立的 transport + 事件收集器。 */
function freshTransport(
  extra?: Partial<Parameters<typeof createA2ATransport>[0]> & Record<string, unknown>,
) {
  const batches: Array<Parameters<A2AEventBatchSink>[0]> = [];
  const transport = createA2ATransport({
    // 05 §6：默认冻结 profile（cancel/resume 可用；steer 不在 A2A 冻结范围）。
    capabilities: { cancel: true, resume: true, steer: false },
    eventBatchSink: async (batch) => {
      batches.push(batch);
    },
    streamTimeoutMs: 5_000,
    ...extra,
  } as Parameters<typeof createA2ATransport>[0]);
  return { transport, batches };
}

/** 等待后台流消费 flush。 */
async function waitForEvents(
  batches: Array<Parameters<A2AEventBatchSink>[0]>,
  count: number,
): Promise<void> {
  for (let i = 0; i < 200 && batches.length < count; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function requestBody(
  overrides: Partial<StartInvocationRequestBody> = {},
): StartInvocationRequestBody {
  return {
    protocol_version: "2",
    invocation_id: "inv-1",
    turn_context: { thread_id: "thread-1", turn_id: "turn-1", trigger_item_id: null },
    job_context: null,
    agent: null,
    input_items: [
      { type: "platform_rule", content: "rule" },
      { type: "user_message", item_id: "item-1", content: { text: "帮我提交申请" } },
    ],
    context_handle: "ctx-handle-1",
    governance_config: { revision_id: "gov-1", config_digest: "sha256:0", config: {} },
    gateway_access: { access_token: "token", expires_at: "2026-08-25T09:00:00.000Z" },
    gateway_endpoints: {
      events: "http://gw/events",
      cancel: "http://gw/cancel",
      resume: "http://gw/resume",
      steer: "http://gw/steer",
      tools: "http://gw/tools",
      tool_calls: "http://gw/tool-calls",
      user_action_requests: "http://gw/user-action-requests",
    },
    workspace: null,
    execution_limits: { max_invocation_seconds: 600, max_event_bytes: 1048576 },
    trace_context: { trace_id: "trace-1", span_id: "span-1" },
    attempt: { attempt_no: 1 },
    // 05 §5：execution_subject 只经 invocation_context 单一 Authority 进入 wire。
    invocation_context: [
      {
        context_kind: "execution_subject",
        value: { subject_id: "user-1", subject_kind: "platform_user" },
      },
    ],
    ...overrides,
  };
}

describe("04 §11：Invocation Context Enrichment → A2A message.metadata", () => {
  it("允许的公共 Context 以合同 key 直接进入 metadata；Provider 看不到任何内部字段", async () => {
    const { transport } = freshTransport();
    const resp = await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      auth: { mode: "none" },
      idempotencyKey: "idem-ctx-1",
      requestBody: requestBody({
        invocation_context: [
          {
            context_kind: "execution_subject",
            value: { subject_id: "user-1", subject_kind: "platform_user" },
          },
          { context_kind: "current_datetime", value: "2026-08-26T09:30:00.000Z" },
          { context_kind: "timezone", value: "Asia/Shanghai" },
        ],
      }),
    });
    expect(resp.accepted).toBe(true);
    const captured = provider.captured[provider.captured.length - 1];
    expect(captured?.messageMetadata).toMatchObject({
      execution_subject: { subject_id: "user-1", subject_kind: "platform_user" },
      current_datetime: "2026-08-26T09:30:00.000Z",
      timezone: "Asia/Shanghai",
    });
    // 04 §12：Provider 看不到 tenant/thread/invocation/turn/trace/context_handle/token/email。
    const wire = JSON.stringify(captured?.messageMetadata);
    for (const forbidden of [
      "tenant-1",
      "thread-1",
      "inv-1",
      "trace-1",
      "ctx-handle-1",
      "tenant_id",
      "email",
      "gateway",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });
});

describe("仓内 A2A Provider 黑盒 E2E（07，HR 公开合同 wire）", () => {
  it("Agent Card：标准路径唯一（agent-card.json，不请求废弃 agent.json），公开 Capability Manifest 与 Invocation Context Contract", async () => {
    const { transport } = freshTransport();
    const caps = await transport.probeCapabilities(provider.endpoint, {
      mode: "bearer",
      token: "token",
    });
    expect(caps.features.event_stream).toBe(true);
    // Agent Card 通用扩展合同（07 §7）：明确版本、非函数列表、三种 necessity。
    expect(A2A_TEST_PROVIDER_CAPABILITY_MANIFEST.capabilities.length).toBeGreaterThanOrEqual(3);
    const kinds = A2A_TEST_PROVIDER_CONTEXT_CONTRACT;
    expect(kinds.required.map((r) => r.context_kind)).toContain("execution_subject");
    expect(kinds.preferred.length).toBeGreaterThanOrEqual(4);
    expect(kinds.accepted.length).toBeGreaterThanOrEqual(2);
    // 标准路径唯一：本次 probe 只命中 agent-card.json，绝不请求废弃 agent.json。
    const cardRequests = provider.requests.filter((r) => r.path.startsWith("/.well-known/"));
    expect(cardRequests).toHaveLength(1);
    expect(cardRequests[0]?.path).toBe("/.well-known/agent-card.json");
    expect(provider.requests.some((r) => r.path === "/.well-known/agent.json")).toBe(false);
  });

  it("completed：真实 SSE wire → 归一化事件；公开合同 metadata 精确到达 Provider", async () => {
    provider.setScenario("completed");
    const { transport, batches } = freshTransport();
    const resp = await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      idempotencyKey: "idem-completed",
      requestBody: requestBody(),
    });
    expect(resp.accepted).toBe(true);
    expect(resp.runtime_session_ref).toBeTruthy();
    expect(resp.runtime_execution_ref).toBeTruthy();
    await waitForEvents(batches, 3);
    const types = batches.flatMap((b) => b.events).map((e) => e.type);
    expect(types).toContain("progress.snapshot");
    expect(types).toContain("response.completed");
    expect(types).toContain("execution.completed");

    // trusted subject（07 §4-1）：Provider 收到 required execution_subject 公开对象，
    // 且不携带任何内部键（invocation_id/trace_id/span_id/protocol/tenant_id 等）。
    const last = provider.captured[provider.captured.length - 1];
    expect(last?.messageMetadata).toEqual({
      execution_subject: { subject_id: "user-1", subject_kind: "platform_user" },
    });
  });

  it("无 execution_subject：Provider 收到的 Message 无 metadata 键", async () => {
    provider.setScenario("completed");
    const { transport } = freshTransport();
    await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      idempotencyKey: "idem-no-subject",
      requestBody: requestBody({ invocation_context: undefined }),
    });
    const last = provider.captured[provider.captured.length - 1];
    expect(last?.messageMetadata).toBeUndefined();
  });

  it("context continuity：第二次 Invocation 复用 contextId（07 §5）", async () => {
    provider.setScenario("completed");
    const contextIds: string[] = [];
    const { transport } = freshTransport({
      resolveExistingContextId: async () => contextIds[0] ?? null,
    });
    const first = await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      idempotencyKey: "idem-ctx-1",
      requestBody: requestBody({ invocation_id: "inv-ctx-1" }),
    });
    contextIds.push(first.runtime_session_ref);
    const second = await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      idempotencyKey: "idem-ctx-2",
      requestBody: requestBody({ invocation_id: "inv-ctx-2" }),
    });
    // 跨 Invocation contextId 连续（06 §5：runtime_session_ref 跨 Turn 连续）。
    expect(second.runtime_session_ref).toBe(first.runtime_session_ref);
  });

  it("input_required → resume：artifact 支撑追问 + 同 Task 纯文本 resume + 官方 Task 完成事件（07 §5/§6）", async () => {
    provider.setScenario("input_required");
    const refs = { executionRef: "", sessionRef: "" };
    const { transport, batches } = freshTransport({
      resolveRuntimeRefs: async () => ({
        runtimeExecutionRef: refs.executionRef,
        runtimeSessionRef: refs.sessionRef,
      }),
      resolveNextProducerSequence: async () => 101,
    });
    const resp = await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      idempotencyKey: "idem-input",
      requestBody: requestBody(),
    });
    refs.executionRef = resp.runtime_execution_ref;
    refs.sessionRef = resp.runtime_session_ref;
    await waitForEvents(batches, 1);
    // HR 官方顺序：input-required 无 status.message，追问文本来自 artifact TextPart。
    const action = batches.flatMap((b) => b.events).find((e) => e.type === "user_action.requested");
    expect(action?.payload.request_type).toBe("input");
    expect(action?.payload.prompt).toBe("请提供申请日期");
    const schema = action?.payload.input_schema as Record<string, unknown>;
    expect(schema?.type).toBe("object");
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required).toEqual(["text"]);

    const startBatchCount = batches.length;
    const resumed = await transport.resumeInvocation({
      runtimeEndpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      invocationId: "inv-1",
      idempotencyKey: "idem-resume",
      requestBody: {
        resume_payload: { text: "申请日期 2026-09-01" },
        gateway_access: { access_token: "t", expires_at: "2026-08-25T09:00:00.000Z" },
      },
    });
    expect(resumed.resumed).toBe(true);
    // resume 消息带原 taskId + contextId（08：继续原 Task，不开新会话），
    // 发送精确纯文本，且无任何 metadata。
    const last = provider.captured[provider.captured.length - 1];
    expect(last?.resume).toBe(true);
    expect(last?.text).toBe("申请日期 2026-09-01");
    expect(last?.taskId).toBe(refs.executionRef);
    expect(last?.contextId).toBe(refs.sessionRef);
    expect(last?.messageMetadata).toBeUndefined();

    // 官方 Task（含 artifacts）→ response.completed 携带 artifact 实际答复 +
    // execution.completed，producer_sequence 始于注入值。
    await waitForEvents(batches, startBatchCount + 1);
    const resumeBatch = batches[startBatchCount];
    expect(resumeBatch?.producerSequenceStart).toBe(101);
    const completed = resumeBatch?.events.find((e) => e.type === "response.completed");
    expect((completed?.payload as { text?: string }).text).toBe("申请已提交完成");
    expect(resumeBatch?.events.map((e) => e.type)).toContain("execution.completed");
  });

  it("resume correlation 被篡改（官方 Task id/contextId 变化）→ invalid_correlation，事件批次不新增", async () => {
    provider.setScenario("input_required");
    const refs = { executionRef: "", sessionRef: "" };
    const { transport, batches } = freshTransport({
      resolveRuntimeRefs: async () => ({
        runtimeExecutionRef: refs.executionRef,
        runtimeSessionRef: refs.sessionRef,
      }),
      resolveNextProducerSequence: async () => 51,
    });
    const resp = await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      idempotencyKey: "idem-corrupt",
      requestBody: requestBody(),
    });
    refs.executionRef = resp.runtime_execution_ref;
    refs.sessionRef = resp.runtime_session_ref;
    await waitForEvents(batches, 1);
    provider.corruptResumeCorrelation();
    const batchCountBefore = batches.length;
    await expect(
      transport.resumeInvocation({
        runtimeEndpoint: provider.endpoint,
        auth: { mode: "bearer", token: "token" },
        invocationId: "inv-1",
        idempotencyKey: "idem-resume-corrupt",
        requestBody: {
          resume_payload: { text: "补充" },
          gateway_access: { access_token: "t", expires_at: "2026-08-25T09:00:00.000Z" },
        },
      }),
    ).rejects.toMatchObject({ kind: "invalid_correlation" });
    expect(batches.length).toBe(batchCountBefore);
    provider.reset();
    provider.setScenario("completed");
  });

  it("long_running + cancel：tasks/cancel 真实 wire（07 §5）", async () => {
    provider.setScenario("long_running");
    const refs = { executionRef: "", sessionRef: "" };
    const { transport } = freshTransport({
      resolveRuntimeRefs: async () => ({
        runtimeExecutionRef: refs.executionRef,
        runtimeSessionRef: refs.sessionRef,
      }),
    });
    const resp = await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      idempotencyKey: "idem-cancel",
      requestBody: requestBody(),
    });
    refs.executionRef = resp.runtime_execution_ref;
    refs.sessionRef = resp.runtime_session_ref;
    const cancelled = await transport.cancelInvocation({
      runtimeEndpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      invocationId: "inv-1",
      idempotencyKey: "idem-cancel-2",
      requestBody: { reason: "user" },
    });
    expect(cancelled.cancelled).toBe(true);
  });

  it("failed / rejected / malformed：远端失败语义逐场景成立（07 §5）", async () => {
    provider.setScenario("failed");
    const { transport, batches } = freshTransport();
    await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      idempotencyKey: "idem-failed",
      requestBody: requestBody(),
    });
    await waitForEvents(batches, 1);
    const failed = batches.flatMap((b) => b.events).find((e) => e.type === "execution.failed");
    expect(failed?.payload.error_code).toBe("REMOTE_TASK_FAILED");

    provider.setScenario("rejected");
    await expect(
      freshTransport().transport.startInvocation({
        runtimeEndpoint: provider.endpoint,
        auth: { mode: "bearer", token: "token" },
        idempotencyKey: "idem-rejected",
        requestBody: requestBody(),
      }),
    ).rejects.toMatchObject({ kind: "remote_task_rejected" });

    provider.setScenario("malformed");
    await expect(
      freshTransport().transport.startInvocation({
        runtimeEndpoint: provider.endpoint,
        auth: { mode: "bearer", token: "token" },
        idempotencyKey: "idem-malformed",
        requestBody: requestBody(),
      }),
    ).rejects.toBeInstanceOf(RuntimeTransportError);
    provider.setScenario("completed");
  });

  it("subject echo：Provider 回显 trusted subject 公开对象（07 §5 execution subject echo）", async () => {
    provider.setScenario("subject_echo");
    const { transport, batches } = freshTransport();
    await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      idempotencyKey: "idem-echo",
      requestBody: requestBody(),
    });
    await waitForEvents(batches, 2);
    const completed = batches.flatMap((b) => b.events).find((e) => e.type === "response.completed");
    expect((completed?.payload as { text?: string }).text).toContain(
      "subject:user-1:platform_user",
    );
    provider.setScenario("completed");
  });
});
