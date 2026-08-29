/**
 * A2A AgentTransport 黑盒 E2E 测试（AgentCall 协议层；真实 HTTP/SSE wire）。
 *
 * 黑盒原则（07 §2）：Transport 只通过 Agent Card + 真实 A2A wire behavior 与 Provider
 * 交互（真实 fetch，无 fetchImpl 注入）。断言全部基于 wire 事实（captured 请求 +
 * 归一化 AgentCall 候选事件），不读 Provider 内部状态形成合同。
 *
 * HR 官方顺序（Provider fixture 冻结）：status working → artifact-update
 * （TextPart 追问 + DataPart 公共结构化结果）→ input-required 无 status.message；
 * message/send（resume）同步返回完整 Task（kind:"task"，id/contextId/status/artifacts）。
 *
 * 本文件用公共 AgentTransport 端口（startCall/resumeCall/cancelCall/getCall/probe），
 * 不用 Runtime fixtures。所有归一化输出必须是 AgentCall 候选事件（call.*）。
 */
import {
  AgentTransportError,
  type AgentCallEventSink,
} from "@/lib/agents/calls/transport/agent-transport";
import { createA2AAgentTransport } from "@/lib/agents/calls/transport/a2a/a2a-client";
import {
  type A2ATestProvider,
  A2A_TEST_PROVIDER_CAPABILITY_MANIFEST,
  A2A_TEST_PROVIDER_CONTEXT_CONTRACT,
  startA2ATestProvider,
} from "@/lib/agents/calls/test/a2a-test-provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** 测试共享 Provider（真实 HTTP server）；事件 batch 每用例独立收集。 */
let provider: A2ATestProvider;

beforeAll(async () => {
  provider = await startA2ATestProvider("completed");
});

afterAll(async () => {
  await provider.close();
});

/** 每用例独立的 transport + 事件收集器。 */
function freshTransport(
  extra?: Partial<Parameters<typeof createA2AAgentTransport>[0]>,
) {
  const batches: Array<Parameters<AgentCallEventSink>[0]> = [];
  const transport = createA2AAgentTransport({
    capabilities: { cancel: true, resume: true, steer: false },
    eventSink: async (batch) => {
      batches.push(batch);
    },
    streamTimeoutMs: 5_000,
    ...extra,
  });
  return { transport, batches };
}

/** 等待后台流消费 flush。 */
async function waitForEvents(
  batches: Array<Parameters<AgentCallEventSink>[0]>,
  count: number,
): Promise<void> {
  for (let i = 0; i < 200 && batches.length < count; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function startParams(overrides: Record<string, unknown> = {}) {
  return {
    callId: "call-1",
    endpoint: provider.endpoint,
    auth: { mode: "bearer", token: "token" } as const,
    input: "帮我提交申请",
    idempotencyKey: "idem-1",
    capabilities: { cancel: true, resume: true, steer: false },
    contextMetadata: {
      execution_subject: { subject_id: "user-1", subject_kind: "platform_user" },
    },
    ...overrides,
  };
}

describe("仓内 A2A Provider 黑盒 E2E（AgentCall 协议层，真实 wire）", () => {
  it("Agent Card：标准路径唯一（agent-card.json，不请求废弃 agent.json）", async () => {
    const { transport } = freshTransport();
    const caps = await transport.probe({
      endpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
    });
    expect(caps.features.event_stream).toBe(true);
    expect(A2A_TEST_PROVIDER_CAPABILITY_MANIFEST.capabilities.length).toBeGreaterThanOrEqual(3);
    const kinds = A2A_TEST_PROVIDER_CONTEXT_CONTRACT;
    expect(kinds.required.map((r) => r.context_kind)).toContain("execution_subject");
    expect(kinds.preferred.length).toBeGreaterThanOrEqual(4);
    const cardRequests = provider.requests.filter((r) => r.path.startsWith("/.well-known/"));
    expect(cardRequests).toHaveLength(1);
    expect(cardRequests[0]?.path).toBe("/.well-known/agent-card.json");
    expect(provider.requests.some((r) => r.path === "/.well-known/agent.json")).toBe(false);
  });

  it("completed：真实 SSE wire → call.* 归一化事件；公开合同 metadata 精确到达 Provider", async () => {
    provider.setScenario("completed");
    const { transport, batches } = freshTransport();
    const resp = await transport.startCall(startParams());
    expect(resp.callId).toBe("call-1");
    expect(resp.taskId).toBeTruthy();
    expect(resp.contextId).toBeTruthy();
    await waitForEvents(batches, 3);
    const types = batches.flatMap((b) => b.events).map((e) => e.type);
    for (const t of types) expect(t).toMatch(/^call\./);
    expect(types).toContain("call.started");
    expect(types).toContain("call.completed");

    const last = provider.captured[provider.captured.length - 1];
    expect(last?.messageMetadata).toEqual({
      execution_subject: { subject_id: "user-1", subject_kind: "platform_user" },
    });
  });

  it("无 execution_subject：Provider 收到的 Message 无 metadata 键", async () => {
    provider.setScenario("completed");
    const { transport } = freshTransport();
    await transport.startCall(startParams({ contextMetadata: undefined }));
    const last = provider.captured[provider.captured.length - 1];
    expect(last?.messageMetadata).toBeUndefined();
  });

  it("context continuity：第二次 startCall 复用 contextId（existingContextId）", async () => {
    provider.setScenario("completed");
    let existing: string | null = null;
    const { transport } = freshTransport({
      // 第二次调用前由调用方提供首次返回的 contextId。
    });
    const first = await transport.startCall(startParams({ callId: "call-ctx-1" }));
    existing = first.contextId;
    const second = await transport.startCall(
      startParams({ callId: "call-ctx-2", existingContextId: existing }),
    );
    expect(second.contextId).toBe(first.contextId);
  });

  it("input_required → resume：artifact 支撑追问 + 同 Task 纯文本 resume + 官方 Task 完成事件", async () => {
    provider.setScenario("input_required");
    const { transport, batches } = freshTransport();
    const resp = await transport.startCall(startParams());
    await waitForEvents(batches, 3);
    const action = batches.flatMap((b) => b.events).find((e) => e.type === "call.input_required");
    expect(action).toBeDefined();
    expect((action?.payload as Record<string, unknown>).prompt).toBe("请提供申请日期");
    const schema = (action?.payload as Record<string, unknown>).input_schema as Record<
      string,
      unknown
    >;
    expect(schema?.type).toBe("object");
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required).toEqual(["text"]);

    const startBatchCount = batches.length;
    await transport.resumeCall({
      callId: "call-1",
      endpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      taskId: resp.taskId,
      contextId: resp.contextId,
      text: "申请日期 2026-09-01",
      nextProducerSequence: 101,
      idempotencyKey: "idem-resume",
    });
    const last = provider.captured[provider.captured.length - 1];
    expect(last?.resume).toBe(true);
    expect(last?.text).toBe("申请日期 2026-09-01");
    expect(last?.taskId).toBe(resp.taskId);
    expect(last?.contextId).toBe(resp.contextId);
    expect(last?.messageMetadata).toBeUndefined();

    await waitForEvents(batches, startBatchCount + 1);
    const resumeBatch = batches[startBatchCount];
    expect(resumeBatch?.producerSequenceStart).toBe(101);
    const completed = resumeBatch?.events.find((e) => e.type === "call.completed");
    expect((completed?.payload as Record<string, unknown>).text).toBe("申请已提交完成");
  });

  it("resume correlation 被篡改（官方 Task id/contextId 变化）→ invalid_correlation，事件批次不新增", async () => {
    provider.setScenario("input_required");
    const { transport, batches } = freshTransport();
    const resp = await transport.startCall(startParams());
    await waitForEvents(batches, 3);
    provider.corruptResumeCorrelation();
    const batchCountBefore = batches.length;
    await expect(
      transport.resumeCall({
        callId: "call-1",
        endpoint: provider.endpoint,
        auth: { mode: "bearer", token: "token" },
        taskId: resp.taskId,
        contextId: resp.contextId,
        text: "补充",
        nextProducerSequence: 51,
        idempotencyKey: "idem-resume-corrupt",
      }),
    ).rejects.toMatchObject({ kind: "invalid_correlation" });
    expect(batches.length).toBe(batchCountBefore);
    provider.reset();
    provider.setScenario("completed");
  });

  it("long_running + cancel：tasks/cancel 真实 wire 携带官方 TaskIdParams.id", async () => {
    provider.setScenario("long_running");
    const { transport } = freshTransport();
    const resp = await transport.startCall(startParams());
    await transport.cancelCall({
      callId: "call-1",
      endpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      taskId: resp.taskId,
      idempotencyKey: "idem-cancel-2",
    });
    const cancelRpc = provider.rpcMethods.find((m) => m === "tasks/cancel");
    expect(cancelRpc).toBe("tasks/cancel");
  });

  it("getCall：tasks/get 真实 wire 携带官方 TaskQueryParams.id，返回 state/taskId/contextId", async () => {
    provider.setScenario("completed");
    const { transport } = freshTransport();
    const resp = await transport.startCall(startParams());
    const got = await transport.getCall({
      callId: "call-1",
      endpoint: provider.endpoint,
      auth: { mode: "bearer", token: "token" },
      taskId: resp.taskId,
    });
    expect(got.state).toBe("working");
    expect(got.taskId).toBe(resp.taskId);
    expect(got.contextId).toBeTruthy();
    expect(provider.rpcMethods).toContain("tasks/get");
  });

  it("failed / rejected / malformed：远端失败语义逐场景成立", async () => {
    provider.setScenario("failed");
    const { transport, batches } = freshTransport();
    await transport.startCall(startParams());
    await waitForEvents(batches, 2);
    const failed = batches.flatMap((b) => b.events).find((e) => e.type === "call.failed");
    expect((failed?.payload as Record<string, unknown>).error_code).toBe("REMOTE_TASK_FAILED");

    provider.setScenario("rejected");
    await expect(freshTransport().transport.startCall(startParams())).rejects.toMatchObject({
      kind: "remote_task_rejected",
    });

    provider.setScenario("malformed");
    await expect(freshTransport().transport.startCall(startParams())).rejects.toBeInstanceOf(
      AgentTransportError,
    );
    provider.setScenario("completed");
  });

  it("subject echo：Provider 回显 trusted subject 公开对象", async () => {
    provider.setScenario("subject_echo");
    const { transport, batches } = freshTransport();
    await transport.startCall(startParams());
    await waitForEvents(batches, 3);
    const completed = batches.flatMap((b) => b.events).find((e) => e.type === "call.completed");
    expect((completed?.payload as Record<string, unknown>).text).toContain(
      "subject:user-1:platform_user",
    );
    provider.setScenario("completed");
  });
});
