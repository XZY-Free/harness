import type { StartInvocationRequestBody } from "@/lib/runtime/runtime-client";
/**
 * A2A Transport 测试 — Batch 6 Gate（04 §9）。
 *
 * 仓内 A2A Provider fixture 以注入 fetchImpl 模拟（真实 wire 形态：
 * JSON-RPC over HTTP + SSE Task/Artifact updates）。覆盖：
 * start stream / final response / multiple chunks / remote failure /
 * protocol invalid / cancel / input-required + resume / context reuse /
 * no context new session / subject metadata / disconnect。
 */
import type { A2AEventBatchSink } from "@/lib/runtime/transport/a2a-transport";
import { createA2ATransport } from "@/lib/runtime/transport/a2a-transport";
import { RuntimeTransportError } from "@/lib/runtime/transport/runtime-transport";
import { describe, expect, it } from "vitest";

/** 构造 SSE 流 Response（chunks 控制分块，模拟真实网络分片）。 */
function sseResponse(lines: string[], options?: { chunks?: number[] }): Response {
  const text = lines.map((l) => `data: ${l}\n\n`).join("");
  const chunks = options?.chunks ?? [text.length];
  const encoder = new TextEncoder();
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = chunks.shift();
      if (size === undefined || offset >= text.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(text.slice(offset, offset + size)));
      offset += size;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function statusUpdate(state: string, taskId = "task-1", contextId = "ctx-1", text?: string) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "rpc-1",
    result: {
      kind: "status-update",
      taskId,
      contextId,
      status: {
        state,
        ...(text !== undefined
          ? { message: { role: "agent", parts: [{ kind: "text", text }] } }
          : {}),
      },
    },
  });
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
      { type: "user_message", item_id: "item-1", content: { text: "帮我查退款" } },
    ],
    context_handle: "ctx-handle-1",
    governance_config: {
      revision_id: "gov-1",
      config_digest: "sha256:0",
      config: {},
    },
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
    ...overrides,
  };
}

interface Fixture {
  requests: Array<{ url: string; init: RequestInit }>;
  batches: Array<Parameters<A2AEventBatchSink>[0]>;
  fetchImpl: typeof fetch;
  queuedResponses: Array<Response | Error>;
}

function createFixture(responses: Array<Response | Error>): Fixture {
  const requests: Fixture["requests"] = [];
  const batches: Fixture["batches"] = [];
  const queuedResponses = [...responses];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const next = queuedResponses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("fixture 无更多响应");
    return next;
  }) as unknown as typeof fetch;
  return { requests, batches, fetchImpl, queuedResponses };
}

/** 等待后台流消费完成（flush batches）。 */
async function waitForBatches(fixture: Fixture, count: number): Promise<void> {
  for (let i = 0; i < 100 && fixture.batches.length < count; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeTransport(
  fixture: Fixture,
  extra?: Partial<Parameters<typeof createA2ATransport>[0]>,
) {
  return createA2ATransport({
    eventBatchSink: async (batch) => {
      fixture.batches.push(batch);
    },
    fetchImpl: fixture.fetchImpl,
    streamTimeoutMs: 2_000,
    ...extra,
  });
}

describe("createA2ATransport（04 §4–§9）", () => {
  it("start stream：首 update 确定 taskId/contextId，映射 runtime_execution_ref/runtime_session_ref", async () => {
    const fixture = createFixture([
      sseResponse([
        statusUpdate("working"),
        statusUpdate("completed", "task-1", "ctx-1", "最终答复"),
      ]),
    ]);
    const transport = makeTransport(fixture);
    const resp = await transport.startInvocation({
      runtimeEndpoint: "https://agent.example.com",
      authToken: "token",
      idempotencyKey: "idem-1",
      requestBody: requestBody(),
    });
    expect(resp.accepted).toBe(true);
    expect(resp.runtime_execution_ref).toBe("task-1");
    expect(resp.runtime_session_ref).toBe("ctx-1");
    expect(resp.invocation_id).toBe("inv-1");

    // message/stream wire 形态。
    const rpc = JSON.parse(String(fixture.requests[0]?.init.body)) as {
      method: string;
      params: {
        message: {
          role: string;
          parts: Array<{ kind: string; text: string }>;
          metadata: Record<string, unknown>;
        };
      };
    };
    expect(rpc.method).toBe("message/stream");
    expect(rpc.params.message.role).toBe("user");
    expect(rpc.params.message.parts[0]).toEqual({ kind: "text", text: "帮我查退款" });
    // subject/correlation metadata（04 §5）。
    expect(rpc.params.message.metadata.invocation_id).toBe("inv-1");
    expect(rpc.params.message.metadata.trace_id).toBe("trace-1");
  });

  it("final response：completed → response.completed + execution.completed 归一化事件", async () => {
    const fixture = createFixture([
      sseResponse([
        statusUpdate("working"),
        statusUpdate("completed", "task-1", "ctx-1", "最终答复"),
      ]),
    ]);
    const transport = makeTransport(fixture);
    await transport.startInvocation({
      runtimeEndpoint: "https://agent.example.com",
      authToken: "token",
      idempotencyKey: "idem-1",
      requestBody: requestBody(),
    });
    await waitForBatches(fixture, 3);
    const all = fixture.batches.flatMap((b) => b.events);
    const types = all.map((e) => e.type);
    expect(types).toContain("progress.snapshot");
    expect(types).toContain("response.completed");
    expect(types).toContain("execution.completed");
    const completed = all.find((e) => e.type === "response.completed");
    expect((completed?.payload as { text?: string }).text).toBe("最终答复");
    // producer_sequence 连续递增。
    const seqs = all.map((e) => e.producer_sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("multiple chunks：一个 SSE 事件跨多个网络分片仍完整解析", async () => {
    const full = `data: ${statusUpdate("working")}\n\ndata: ${statusUpdate("completed", "task-1", "ctx-1", "ok")}\n\n`;
    const fixture = createFixture([
      sseResponse(
        [statusUpdate("working"), statusUpdate("completed", "task-1", "ctx-1", "ok")],
        // 每 20 字节一个分片。
        { chunks: Array.from({ length: Math.ceil(full.length / 20) }, () => 20) },
      ),
    ]);
    const transport = makeTransport(fixture);
    const resp = await transport.startInvocation({
      runtimeEndpoint: "https://agent.example.com",
      authToken: "token",
      idempotencyKey: "idem-1",
      requestBody: requestBody(),
    });
    expect(resp.runtime_execution_ref).toBe("task-1");
    await waitForBatches(fixture, 3);
    expect(fixture.batches.flatMap((b) => b.events)).toHaveLength(3);
  });

  it("remote failure：failed state → execution.failed；首事件 JSON-RPC error → remote_task_failed", async () => {
    const fixture = createFixture([
      sseResponse([statusUpdate("failed", "task-1", "ctx-1", "boom")]),
    ]);
    const transport = makeTransport(fixture);
    await transport.startInvocation({
      runtimeEndpoint: "https://agent.example.com",
      authToken: "token",
      idempotencyKey: "idem-1",
      requestBody: requestBody(),
    });
    await waitForBatches(fixture, 1);
    const failed = fixture.batches
      .flatMap((b) => b.events)
      .find((e) => e.type === "execution.failed");
    expect(failed?.payload.error_code).toBe("REMOTE_TASK_FAILED");

    const fixture2 = createFixture([
      sseResponse([
        JSON.stringify({
          jsonrpc: "2.0",
          id: "rpc-1",
          error: { code: -32000, message: "internal" },
        }),
      ]),
    ]);
    const transport2 = makeTransport(fixture2);
    await expect(
      transport2.startInvocation({
        runtimeEndpoint: "https://agent.example.com",
        authToken: "token",
        idempotencyKey: "idem-1",
        requestBody: requestBody(),
      }),
    ).rejects.toMatchObject({ kind: "remote_task_failed" });
  });

  it("protocol invalid：非 JSON data / 缺 taskId → protocol_schema / invalid_correlation", async () => {
    const fixture = createFixture([sseResponse(["{not-json"])]);
    const transport = makeTransport(fixture);
    await expect(
      transport.startInvocation({
        runtimeEndpoint: "https://agent.example.com",
        authToken: "token",
        idempotencyKey: "idem-1",
        requestBody: requestBody(),
      }),
    ).rejects.toMatchObject({ kind: "protocol_schema" });

    const fixture2 = createFixture([
      sseResponse([JSON.stringify({ jsonrpc: "2.0", id: "x", result: { kind: "status-update" } })]),
    ]);
    const transport2 = makeTransport(fixture2);
    await expect(
      transport2.startInvocation({
        runtimeEndpoint: "https://agent.example.com",
        authToken: "token",
        idempotencyKey: "idem-1",
        requestBody: requestBody(),
      }),
    ).rejects.toMatchObject({ kind: "invalid_correlation" });
  });

  it("cancel：tasks/cancel 携带 taskId；无 refs → invalid_correlation", async () => {
    const fixture = createFixture([jsonResponse({ jsonrpc: "2.0", id: "x", result: {} })]);
    const transport = makeTransport(fixture, {
      resolveRuntimeRefs: async () => ({
        runtimeExecutionRef: "task-9",
        runtimeSessionRef: "ctx-9",
      }),
    });
    const resp = await transport.cancelInvocation({
      runtimeEndpoint: "https://agent.example.com",
      authToken: "token",
      invocationId: "inv-1",
      idempotencyKey: "idem-cancel",
      requestBody: { reason: "user" },
    });
    expect(resp.cancelled).toBe(true);
    const rpc = JSON.parse(String(fixture.requests[0]?.init.body)) as {
      method: string;
      params: { taskId: string };
    };
    expect(rpc.method).toBe("tasks/cancel");
    expect(rpc.params.taskId).toBe("task-9");

    const noRefs = createFixture([]);
    const transport2 = makeTransport(noRefs);
    await expect(
      transport2.cancelInvocation({
        runtimeEndpoint: "https://agent.example.com",
        authToken: "token",
        invocationId: "inv-1",
        idempotencyKey: "idem",
        requestBody: { reason: "user" },
      }),
    ).rejects.toMatchObject({ kind: "invalid_correlation" });
  });

  it("input-required + resume：user_action.requested 事件 + resume → message/send", async () => {
    const fixture = createFixture([
      sseResponse([statusUpdate("input-required", "task-1", "ctx-1", "请提供订单号")]),
      jsonResponse({
        jsonrpc: "2.0",
        id: "rpc-2",
        result: {
          kind: "status-update",
          taskId: "task-1",
          contextId: "ctx-1",
          status: { state: "working" },
        },
      }),
    ]);
    const transport = makeTransport(fixture, {
      resolveRuntimeRefs: async () => ({
        runtimeExecutionRef: "task-1",
        runtimeSessionRef: "ctx-1",
      }),
    });
    await transport.startInvocation({
      runtimeEndpoint: "https://agent.example.com",
      authToken: "token",
      idempotencyKey: "idem-1",
      requestBody: requestBody(),
    });
    await waitForBatches(fixture, 1);
    const action = fixture.batches
      .flatMap((b) => b.events)
      .find((e) => e.type === "user_action.requested");
    expect(action?.payload.request_type).toBe("input");

    const resumeResp = await transport.resumeInvocation({
      runtimeEndpoint: "https://agent.example.com",
      authToken: "token",
      invocationId: "inv-1",
      idempotencyKey: "idem-resume",
      requestBody: {
        resume_payload: { text: "订单号 123" },
        gateway_access: { access_token: "t", expires_at: "2026-08-25T09:00:00.000Z" },
      },
    });
    expect(resumeResp.resumed).toBe(true);
    const rpc = JSON.parse(String(fixture.requests[1]?.init.body)) as {
      method: string;
      params: { message: { contextId: string; taskId: string } };
    };
    expect(rpc.method).toBe("message/send");
    expect(rpc.params.message.taskId).toBe("task-1");
    expect(rpc.params.message.contextId).toBe("ctx-1");
  });

  it("context reuse：resolveExistingContextId 命中 → 请求携带 contextId", async () => {
    const fixture = createFixture([
      sseResponse([statusUpdate("working", "task-2", "ctx-existing")]),
    ]);
    const transport = makeTransport(fixture, {
      resolveExistingContextId: async () => "ctx-existing",
    });
    await transport.startInvocation({
      runtimeEndpoint: "https://agent.example.com",
      authToken: "token",
      idempotencyKey: "idem-1",
      requestBody: requestBody(),
    });
    const rpc = JSON.parse(String(fixture.requests[0]?.init.body)) as {
      params: { message: { contextId?: string } };
    };
    expect(rpc.params.message.contextId).toBe("ctx-existing");
  });

  it("no context → 新会话：请求不携带 contextId 字段", async () => {
    const fixture = createFixture([sseResponse([statusUpdate("working", "task-3", "ctx-new")])]);
    const transport = makeTransport(fixture);
    await transport.startInvocation({
      runtimeEndpoint: "https://agent.example.com",
      authToken: "token",
      idempotencyKey: "idem-1",
      requestBody: requestBody(),
    });
    const rpc = JSON.parse(String(fixture.requests[0]?.init.body)) as {
      params: { message: Record<string, unknown> };
    };
    expect("contextId" in rpc.params.message).toBe(false);
  });

  it("disconnect/interruption：fetch 抛错 → stream_interrupted；401 → endpoint_auth", async () => {
    const fixture = createFixture([new Error("ECONNRESET")]);
    const transport = makeTransport(fixture);
    await expect(
      transport.startInvocation({
        runtimeEndpoint: "https://agent.example.com",
        authToken: "token",
        idempotencyKey: "idem-1",
        requestBody: requestBody(),
      }),
    ).rejects.toMatchObject({ kind: "stream_interrupted" });

    const fixture2 = createFixture([new Response("denied", { status: 401 })]);
    const transport2 = makeTransport(fixture2);
    await expect(
      transport2.startInvocation({
        runtimeEndpoint: "https://agent.example.com",
        authToken: "token",
        idempotencyKey: "idem-1",
        requestBody: requestBody(),
      }),
    ).rejects.toMatchObject({ kind: "endpoint_auth" });
  });

  it("execution_subject（06 §7）：execution_subject → snowharness.execution_subject metadata；缺省不发送", async () => {
    const fixture = createFixture([sseResponse([statusUpdate("working", "task-4", "ctx-4")])]);
    const transport = makeTransport(fixture);
    await transport.startInvocation({
      runtimeEndpoint: "https://agent.example.com",
      authToken: "token",
      idempotencyKey: "idem-1",
      requestBody: requestBody({
        execution_subject: {
          tenant_id: "tenant-1",
          subject_type: "user",
          subject_id: "user-1",
        },
      }),
    });
    const rpc = JSON.parse(String(fixture.requests[0]?.init.body)) as {
      params: { message: { metadata: Record<string, string> } };
    };
    expect(rpc.params.message.metadata["snowharness.execution_subject"]).toBe(
      JSON.stringify({ tenant_id: "tenant-1", subject_type: "user", subject_id: "user-1" }),
    );

    // 缺省：不发送该 metadata key。
    const fixture2 = createFixture([sseResponse([statusUpdate("working", "task-5", "ctx-5")])]);
    const transport2 = makeTransport(fixture2);
    await transport2.startInvocation({
      runtimeEndpoint: "https://agent.example.com",
      authToken: "token",
      idempotencyKey: "idem-1",
      requestBody: requestBody(),
    });
    const rpc2 = JSON.parse(String(fixture2.requests[0]?.init.body)) as {
      params: { message: { metadata: Record<string, string> } };
    };
    expect("snowharness.execution_subject" in rpc2.params.message.metadata).toBe(false);
  });

  it("steer → unsupported_capability（A2A 0.3.0 冻结范围不含 steer）", async () => {
    const fixture = createFixture([]);
    const transport = makeTransport(fixture);
    await expect(
      transport.steerInvocation({
        runtimeEndpoint: "https://agent.example.com",
        authToken: "token",
        invocationId: "inv-1",
        idempotencyKey: "idem",
        requestBody: { steer_payload: "x" },
      }),
    ).rejects.toMatchObject({ kind: "unsupported_capability" });
  });

  it("probeCapabilities：Agent Card → 协议中立能力视图", async () => {
    const fixture = createFixture([
      jsonResponse({
        name: "agent",
        capabilities: { streaming: true },
      }),
    ]);
    const transport = makeTransport(fixture);
    const caps = await transport.probeCapabilities("https://agent.example.com", "token");
    expect(caps.features.event_stream).toBe(true);
    expect(caps.features.steer).toBe(false);
    expect(fixture.requests[0]?.url).toBe("https://agent.example.com/.well-known/agent.json");
  });

  it("错误分类为 RuntimeTransportError（稳定 kind，不暴露 SDK 异常字符串合同）", async () => {
    const fixture = createFixture([new Error("ECONNRESET")]);
    const transport = makeTransport(fixture);
    try {
      await transport.startInvocation({
        runtimeEndpoint: "https://agent.example.com",
        authToken: "token",
        idempotencyKey: "idem-1",
        requestBody: requestBody(),
      });
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeTransportError);
      expect((err as RuntimeTransportError).kind).toBe("stream_interrupted");
    }
  });
});
