import type { StartInvocationRequestBody } from "@/lib/runtime/runtime-client";
import {
  type A2ATestProvider,
  A2A_TEST_PROVIDER_CAPABILITY_MANIFEST,
  A2A_TEST_PROVIDER_CONTEXT_CONTRACT,
  startA2ATestProvider,
} from "@/lib/runtime/test-support/a2a-test-provider";
/**
 * 仓内 A2A Provider 黑盒 E2E 测试（07 §2/§5/§9，Batch 9 Gate — Platform PASS 子集）。
 *
 * 黑盒原则：Transport 只通过 Agent Card + 真实 HTTP/SSE wire 与 Provider 交互
 * （真实 fetch，无 fetchImpl 注入）。断言全部基于 wire 事实（captured 请求 +
 * 归一化事件），不读 Provider 内部状态形成合同。
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
function freshTransport(extra?: Partial<Parameters<typeof createA2ATransport>[0]>) {
  const batches: Array<Parameters<A2AEventBatchSink>[0]> = [];
  const transport = createA2ATransport({
    eventBatchSink: async (batch) => {
      batches.push(batch);
    },
    streamTimeoutMs: 5_000,
    ...extra,
  });
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
    execution_subject: {
      tenant_id: "tenant-1",
      subject_type: "user",
      subject_id: "user-1",
    },
    ...overrides,
  };
}

describe("仓内 A2A Provider 黑盒 E2E（07）", () => {
  it("Agent Card：公开 Capability Manifest 与 Invocation Context Contract（三种 necessity）", async () => {
    const { transport } = freshTransport();
    const caps = await transport.probeCapabilities(provider.endpoint, "token");
    expect(caps.features.event_stream).toBe(true);
    // Agent Card 通用扩展合同（07 §7）：明确版本、非函数列表、三种 necessity。
    expect(A2A_TEST_PROVIDER_CAPABILITY_MANIFEST.capabilities.length).toBeGreaterThanOrEqual(3);
    const kinds = A2A_TEST_PROVIDER_CONTEXT_CONTRACT;
    expect(kinds.required.map((r) => r.context_kind)).toContain("execution_subject");
    expect(kinds.preferred.length).toBeGreaterThanOrEqual(4);
    expect(kinds.accepted.length).toBeGreaterThanOrEqual(2);
  });

  it("completed：真实 SSE wire → 归一化事件 + subject metadata 到达 Provider", async () => {
    provider.setScenario("completed");
    const { transport, batches } = freshTransport();
    const resp = await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      authToken: "token",
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

    // trusted subject（07 §4-1）：Provider 收到 required execution_subject。
    const last = provider.captured[provider.captured.length - 1];
    expect(last?.messageMetadata["snowharness.execution_subject"]).toBe(
      JSON.stringify({ tenant_id: "tenant-1", subject_type: "user", subject_id: "user-1" }),
    );
  });

  it("context continuity：第二次 Invocation 复用 contextId（07 §5）", async () => {
    provider.setScenario("completed");
    const contextIds: string[] = [];
    const { transport } = freshTransport({
      resolveExistingContextId: async () => contextIds[0] ?? null,
    });
    const first = await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      authToken: "token",
      idempotencyKey: "idem-ctx-1",
      requestBody: requestBody({ invocation_id: "inv-ctx-1" }),
    });
    contextIds.push(first.runtime_session_ref);
    const second = await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      authToken: "token",
      idempotencyKey: "idem-ctx-2",
      requestBody: requestBody({ invocation_id: "inv-ctx-2" }),
    });
    // 跨 Invocation contextId 连续（06 §5：runtime_session_ref 跨 Turn 连续）。
    expect(second.runtime_session_ref).toBe(first.runtime_session_ref);
  });

  it("input_required → resume：继续原 taskId/contextId（07 §5/§6：真正缺业务信息才追问）", async () => {
    provider.setScenario("input_required");
    const refs = { executionRef: "", sessionRef: "" };
    const { transport, batches } = freshTransport({
      resolveRuntimeRefs: async () => ({
        runtimeExecutionRef: refs.executionRef,
        runtimeSessionRef: refs.sessionRef,
      }),
    });
    const resp = await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      authToken: "token",
      idempotencyKey: "idem-input",
      requestBody: requestBody(),
    });
    refs.executionRef = resp.runtime_execution_ref;
    refs.sessionRef = resp.runtime_session_ref;
    await waitForEvents(batches, 2);
    const action = batches.flatMap((b) => b.events).find((e) => e.type === "user_action.requested");
    expect(action?.payload.request_type).toBe("input");

    provider.setScenario("completed");
    const resumed = await transport.resumeInvocation({
      runtimeEndpoint: provider.endpoint,
      authToken: "token",
      invocationId: "inv-1",
      idempotencyKey: "idem-resume",
      requestBody: {
        resume_payload: { text: "申请日期 2026-09-01" },
        gateway_access: { access_token: "t", expires_at: "2026-08-25T09:00:00.000Z" },
      },
    });
    expect(resumed.resumed).toBe(true);
    // resume 消息带原 taskId + contextId（08：继续原 Task，不开新会话）。
    const last = provider.captured[provider.captured.length - 1];
    expect(last?.resume).toBe(true);
    expect(last?.contextId).toBe(refs.sessionRef);
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
      authToken: "token",
      idempotencyKey: "idem-cancel",
      requestBody: requestBody(),
    });
    refs.executionRef = resp.runtime_execution_ref;
    refs.sessionRef = resp.runtime_session_ref;
    const cancelled = await transport.cancelInvocation({
      runtimeEndpoint: provider.endpoint,
      authToken: "token",
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
      authToken: "token",
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
        authToken: "token",
        idempotencyKey: "idem-rejected",
        requestBody: requestBody(),
      }),
    ).rejects.toMatchObject({ kind: "remote_task_rejected" });

    provider.setScenario("malformed");
    await expect(
      freshTransport().transport.startInvocation({
        runtimeEndpoint: provider.endpoint,
        authToken: "token",
        idempotencyKey: "idem-malformed",
        requestBody: requestBody(),
      }),
    ).rejects.toBeInstanceOf(RuntimeTransportError);
  });

  it("subject echo：Provider 回显 trusted subject（07 §5 execution subject echo）", async () => {
    provider.setScenario("subject_echo");
    const { transport, batches } = freshTransport();
    await transport.startInvocation({
      runtimeEndpoint: provider.endpoint,
      authToken: "token",
      idempotencyKey: "idem-echo",
      requestBody: requestBody(),
    });
    await waitForEvents(batches, 2);
    const completed = batches.flatMap((b) => b.events).find((e) => e.type === "response.completed");
    expect((completed?.payload as { text?: string }).text).toContain("subject:");
    expect((completed?.payload as { text?: string }).text).toContain("tenant-1");
  });
});
