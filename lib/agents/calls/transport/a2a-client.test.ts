import { createA2AAgentTransport } from "@/lib/agents/calls/transport/a2a/a2a-client";
/**
 * A2A AgentTransport 测试 — 协议层 Gate（04 §4–§9，A2A 0.3.0 wire 冻结版）。
 *
 * 迁移自 lib/runtime/transport/a2a-transport.test.ts 的可靠性覆盖，但输入改为公共
 * AgentTransport 端口（startCall/resumeCall/cancelCall/getCall/probe），不用 Runtime
 * fixtures。所有映射输出必须是 AgentCall 候选事件（call.*），绝不产生 parent
 * 输出（execution 系、response 系、progress.snapshot、user_action.requested）。
 *
 * 仓内 A2A Provider fixture 以注入 fetchImpl 模拟（真实 wire 形态：JSON-RPC over
 * HTTP + SSE Task/Artifact updates）。覆盖：
 * - Agent Card 路径 / JSON-RPC message/stream/SSE / LF+CRLF+分块 / Task 初始与同步形态
 * - artifact text + data / input-required / same task/context resume / tasks/get 与 tasks/cancel
 * - idempotency header / capabilities fail closed / none vs bearer vs invalid auth /
 *   dead endpoint / 401/403 / 503 transient / malformed response / EOF / reader 失败 /
 *   parser / ingress 背景错误分类
 * - 流 task/context 不匹配（首个 correlation 之前与之后）、unknown/malformed state fail closed、
 *   多独立调用共享 transport 的独立失败处理、JSON-RPC 同步响应畸形与 correlation 校验、
 *   resume null/undefined/空/空白与 next seq null/0 网络前拒绝。
 *
 * 本文件按「真实 RED」组织：凡生产 Agent draft 未达标的 wire 契约，断言保持强 RED
 * （start capabilities protocol_versions 应为 A2A "0.3.0"、流 correlation 失配 fail
 * closed、未知 auth mode 网络前拒绝、tasks/get|cancel 官方 {id} params、resume 输入
 * 网络前类型校验、reader 超时上报等），不因生产未达标而弱化。
 */
import {
  type AgentCallEventSink,
  type AgentCardCapabilities,
  type AgentTransport,
  AgentTransportAuthError,
  AgentTransportError,
  type StartAgentCallParams,
  type StartAgentCallResult,
} from "@/lib/agents/calls/transport/agent-transport";
import { describe, expect, it } from "vitest";

/**
 * StartAgentCallResult 的能力形状（结构性证据，不 alias any）。
 *
 * 端口类型 StartAgentCallResult["capabilities"] 把 A2A 能力拍平成 features&limits，
 * 不表达 protocol_versions；生产 startCall 实际返回 { protocol_versions, features,
 * limits }（protocol_versions 是 A2A "0.3.0" 协议证据）。本 helper 用结构性对象精确
 * 断言真实生产形状，保持 typecheck，不强转 any，也不把断言放宽到端口子集。
 */
interface StartCapabilitiesEvidence {
  protocol_versions: string[];
  features: AgentCardCapabilities["features"];
  limits: AgentCardCapabilities["limits"];
}

function capabilitiesEvidence(resp: StartAgentCallResult): StartCapabilitiesEvidence {
  return resp.capabilities as unknown as StartCapabilitiesEvidence;
}

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

function statusUpdate(
  state: string,
  taskId = "task-1",
  contextId = "ctx-1",
  text?: string,
  final?: boolean,
) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "rpc-1",
    result: {
      kind: "status-update",
      taskId,
      contextId,
      status: {
        state,
        // A2A 0.3.0 规范：status-update final 为必需字段（缺省按状态推导）。
        final: final ?? ["completed", "failed", "canceled", "rejected"].includes(state),
        ...(text !== undefined
          ? { message: { role: "agent", parts: [{ kind: "text", text }] } }
          : {}),
      },
    },
  });
}

/** HR 官方 artifact-update：TextPart 展示文本 + DataPart 公共结构化结果。 */
function artifactUpdate(
  text: string,
  data: Record<string, unknown>,
  taskId = "task-1",
  contextId = "ctx-1",
  artifactId = "art-1",
) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "rpc-1",
    result: {
      kind: "artifact-update",
      taskId,
      contextId,
      artifact: {
        artifactId,
        name: "answer",
        parts: [
          { kind: "text", text },
          { kind: "data", data },
        ],
      },
    },
  });
}

/** HR 官方 message/send 同步结果：完整 Task（id/contextId/status/artifacts）。 */
function taskResult(
  taskId = "task-1",
  contextId = "ctx-1",
  answerText = "最终答复",
  state = "completed",
) {
  return {
    kind: "task",
    id: taskId,
    contextId,
    status: { state },
    artifacts: [
      {
        artifactId: "art-final",
        name: "answer",
        parts: [
          { kind: "text", text: answerText },
          { kind: "data", data: { result: { status: "ok" } } },
        ],
      },
    ],
  };
}

/** startCall 公共入参（AgentCall 协议层，不用 Runtime fixtures）。 */
function startRequest(overrides: Partial<StartAgentCallParams> = {}): StartAgentCallParams {
  return {
    callId: "call-1",
    endpoint: "https://agent.example.com",
    auth: { mode: "bearer", token: "token" },
    input: "帮我查退款",
    idempotencyKey: "idem-1",
    capabilities: { cancel: true, resume: true, steer: false },
    ...overrides,
  };
}

interface Fixture {
  requests: Array<{ url: string; init: RequestInit }>;
  batches: Array<Parameters<AgentCallEventSink>[0]>;
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
  for (let i = 0; i < 200 && fixture.batches.length < count; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeTransport(
  fixture: Fixture,
  extra?: Partial<Parameters<typeof createA2AAgentTransport>[0]>,
) {
  return createA2AAgentTransport({
    capabilities: { cancel: true, resume: true, steer: false },
    eventSink: async (batch) => {
      fixture.batches.push(batch);
    },
    fetchImpl: fixture.fetchImpl,
    streamTimeoutMs: 2_000,
    ...extra,
  });
}

/** 断言 AgentCall 候选事件类型（绝无 parent 输出）。 */
function expectOnlyCallEvents(events: Array<{ type: string }>): void {
  for (const e of events) {
    expect(e.type).toMatch(/^call\./);
  }
}

describe("createA2AAgentTransport — start message/stream wire + 归一化（04 §4–§6）", () => {
  it("start stream：首 update 确定 taskId/contextId；无 contextMetadata 时 Message 无 metadata 键", async () => {
    const fixture = createFixture([
      sseResponse([
        statusUpdate("working"),
        statusUpdate("completed", "task-1", "ctx-1", "最终答复", true),
      ]),
    ]);
    const transport = makeTransport(fixture);
    const resp = await transport.startCall(startRequest());
    expect(resp.callId).toBe("call-1");
    expect(resp.taskId).toBe("task-1");
    expect(resp.contextId).toBe("ctx-1");

    const rpc = JSON.parse(String(fixture.requests[0]?.init.body)) as {
      method: string;
      params: {
        message: {
          role: string;
          parts: Array<{ kind: string; text: string }>;
          metadata?: Record<string, unknown>;
        };
      };
    };
    expect(rpc.method).toBe("message/stream");
    expect(rpc.params.message.role).toBe("user");
    expect(rpc.params.message.parts[0]).toEqual({ kind: "text", text: "帮我查退款" });
    // 无 contextMetadata → 整个 metadata 键不发送。
    expect("metadata" in rpc.params.message).toBe(false);
  });

  it("completed → 归一化 call.completed（AgentCall 事件，非 parent 输出），payload 携带 task_id/context_id/text", async () => {
    const fixture = createFixture([
      sseResponse([
        statusUpdate("working"),
        statusUpdate("completed", "task-1", "ctx-1", "最终答复", true),
      ]),
    ]);
    const transport = makeTransport(fixture);
    await transport.startCall(startRequest());
    await waitForBatches(fixture, 2);
    const all = fixture.batches.flatMap((b) => b.events);
    expectOnlyCallEvents(all);
    const types = all.map((e) => e.type);
    expect(types).toContain("call.started");
    expect(types).toContain("call.completed");
    const completed = all.find((e) => e.type === "call.completed");
    expect((completed?.payload as Record<string, unknown>).text).toBe("最终答复");
    // 持久化 ingress correlation：每个归一化事件必须携带 task_id/context_id。
    for (const e of all) {
      expect((e.payload as Record<string, unknown>).task_id).toBe("task-1");
      expect((e.payload as Record<string, unknown>).context_id).toBe("ctx-1");
    }
    const seqs = all.map((e) => e.producer_sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("multiple chunks：一个 SSE 事件跨多个网络分片仍完整解析", async () => {
    const full = `data: ${statusUpdate("working")}\n\ndata: ${statusUpdate("completed", "task-1", "ctx-1", "ok", true)}\n\n`;
    const fixture = createFixture([
      sseResponse(
        [statusUpdate("working"), statusUpdate("completed", "task-1", "ctx-1", "ok", true)],
        { chunks: Array.from({ length: Math.ceil(full.length / 20) }, () => 20) },
      ),
    ]);
    const transport = makeTransport(fixture);
    const resp = await transport.startCall(startRequest());
    expect(resp.taskId).toBe("task-1");
    await waitForBatches(fixture, 2);
    expect(fixture.batches.flatMap((b) => b.events)).toHaveLength(2);
  });

  it("CRLF 分隔的 SSE 流：\r\n\r\n 边界事件完整解析", async () => {
    const crlf = (l: string) => `data: ${l}\r\n\r\n`;
    const body =
      crlf(statusUpdate("working")) +
      crlf(statusUpdate("completed", "task-1", "ctx-1", "ok", true));
    const encoder = new TextEncoder();
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= body.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(body.slice(offset, offset + 13)));
        offset += 13;
      },
    });
    const fixture = createFixture([
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ]);
    const transport = makeTransport(fixture);
    const resp = await transport.startCall(startRequest());
    expect(resp.taskId).toBe("task-1");
    await waitForBatches(fixture, 3);
    expect(fixture.batches.flatMap((b) => b.events).map((e) => e.type)).toContain("call.completed");
  });

  it("context reuse：existingContextId 命中 → 请求 Message 携带 contextId", async () => {
    const fixture = createFixture([
      sseResponse([statusUpdate("working", "task-2", "ctx-existing")]),
    ]);
    const transport = makeTransport(fixture);
    await transport.startCall(startRequest({ existingContextId: "ctx-existing" }));
    const rpc = JSON.parse(String(fixture.requests[0]?.init.body)) as {
      params: { message: { contextId?: string } };
    };
    expect(rpc.params.message.contextId).toBe("ctx-existing");
  });

  it("no context → 新会话：请求 Message 不携带 contextId 字段", async () => {
    const fixture = createFixture([sseResponse([statusUpdate("working", "task-3", "ctx-new")])]);
    const transport = makeTransport(fixture);
    await transport.startCall(startRequest());
    const rpc = JSON.parse(String(fixture.requests[0]?.init.body)) as {
      params: { message: Record<string, unknown> };
    };
    expect("contextId" in rpc.params.message).toBe(false);
  });

  it("contextMetadata（execution_subject 单一 Authority）→ metadata 恰为公共对象，无内部键", async () => {
    const fixture = createFixture([sseResponse([statusUpdate("working", "task-4", "ctx-4")])]);
    const transport = makeTransport(fixture);
    await transport.startCall(
      startRequest({
        contextMetadata: {
          execution_subject: { subject_id: "user-1", subject_kind: "platform_user" },
        },
      }),
    );
    const rpc = JSON.parse(String(fixture.requests[0]?.init.body)) as {
      params: { message: { metadata?: Record<string, unknown> } };
    };
    expect(rpc.params.message.metadata).toEqual({
      execution_subject: { subject_id: "user-1", subject_kind: "platform_user" },
    });
    expect(typeof rpc.params.message.metadata?.execution_subject).toBe("object");
    const keys = Object.keys(rpc.params.message.metadata ?? {});
    for (const forbidden of [
      "invocation_id",
      "trace_id",
      "span_id",
      "protocol",
      "tenant_id",
      "corp_id",
      "employee_id",
      "snowharness.execution_subject",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("createA2AAgentTransport — artifact / input-required / resume（04 §6、官方 Task 同步形态）", () => {
  it("HR 官方顺序：artifact（TextPart+DataPart）→ 无 message 的 input-required，prompt 取 artifact 文本且 input_schema 合法", async () => {
    const fixture = createFixture([
      sseResponse([
        statusUpdate("working"),
        artifactUpdate("请提供订单号", { result: { question: "请提供订单号" } }),
        statusUpdate("input-required"),
      ]),
    ]);
    const transport = makeTransport(fixture);
    await transport.startCall(startRequest());
    await waitForBatches(fixture, 3);
    const action = fixture.batches
      .flatMap((b) => b.events)
      .find((e) => e.type === "call.input_required");
    expect(action).toBeDefined();
    expect((action?.payload as Record<string, unknown>).task_id).toBe("task-1");
    // prompt/message 必须来自最新 artifact 的 TextPart（status 无 message）。
    expect((action?.payload as Record<string, unknown>).prompt).toBe("请提供订单号");
    expect((action?.payload as Record<string, unknown>).message).toBe("请提供订单号");
    const schema = (action?.payload as Record<string, unknown>).input_schema as Record<
      string,
      unknown
    >;
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["text"]);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.text?.type).toBe("string");
    expect(props.text?.minLength).toBe(1);
    expect(typeof props.text?.maxLength).toBe("number");
    expect(props.text?.pattern).toBe("\\S");
  });

  it("artifact text + data 语义不得丢弃：completed payload 同时携带 text 与 artifact data", async () => {
    const fixture = createFixture([
      sseResponse([
        statusUpdate("working"),
        artifactUpdate("处理结果", { result: { status: "ok", ref: "T-9" } }),
        statusUpdate("completed"),
      ]),
    ]);
    const transport = makeTransport(fixture);
    await transport.startCall(startRequest());
    await waitForBatches(fixture, 3);
    const completed = fixture.batches
      .flatMap((b) => b.events)
      .find((e) => e.type === "call.completed");
    expect(completed).toBeDefined();
    // 生产 draft：mapper 只投影 text，丢弃 DataPart 公共结构化结果。
    const payload = completed?.payload as Record<string, unknown>;
    expect(payload.text).toBe("处理结果");
    expect(payload.data).toEqual({ result: { status: "ok", ref: "T-9" } });
  });

  it("resume（官方 Task）：发送精确纯文本、标准 Message 字段；completed 事件序号始于注入值并携带 artifact 答复", async () => {
    const fixture = createFixture([
      sseResponse([statusUpdate("working")]),
      jsonResponse({ jsonrpc: "2.0", id: "rpc-2", result: taskResult() }),
    ]);
    const transport = makeTransport(fixture);
    await transport.startCall(startRequest());
    await waitForBatches(fixture, 1);
    const startBatchCount = fixture.batches.length;

    await transport.resumeCall({
      callId: "call-1",
      endpoint: "https://agent.example.com",
      auth: { mode: "bearer", token: "token" },
      taskId: "task-1",
      contextId: "ctx-1",
      text: "订单号 123",
      nextProducerSequence: 41,
      idempotencyKey: "idem-resume",
    });

    const rpc = JSON.parse(String(fixture.requests[1]?.init.body)) as {
      method: string;
      params: { message: Record<string, unknown> };
    };
    expect(rpc.method).toBe("message/send");
    expect(Object.keys(rpc.params.message).sort()).toEqual(
      ["contextId", "kind", "messageId", "parts", "role", "taskId"].sort(),
    );
    expect(rpc.params.message.parts).toEqual([{ kind: "text", text: "订单号 123" }]);
    expect(rpc.params.message.taskId).toBe("task-1");
    expect(rpc.params.message.contextId).toBe("ctx-1");

    await waitForBatches(fixture, startBatchCount + 1);
    const resumeBatch = fixture.batches[startBatchCount];
    expect(resumeBatch?.producerSequenceStart).toBe(41);
    const types = resumeBatch?.events.map((e) => e.type) ?? [];
    expectOnlyCallEvents(resumeBatch?.events ?? []);
    expect(types).toContain("call.completed");
    const completed = resumeBatch?.events.find((e) => e.type === "call.completed");
    expect((completed?.payload as Record<string, unknown>).text).toBe("最终答复");
    expect(resumeBatch?.events.map((e) => e.producer_sequence)).toEqual([41]);
  });

  it("resume correlation 不匹配（官方 Task id/contextId ≠ 存储 refs）→ invalid_correlation，sink 不被调用", async () => {
    const fixture = createFixture([
      sseResponse([statusUpdate("working")]),
      jsonResponse({
        jsonrpc: "2.0",
        id: "rpc-2",
        result: taskResult("corrupted-task-1", "corrupted-ctx-1"),
      }),
    ]);
    const transport = makeTransport(fixture);
    await transport.startCall(startRequest());
    await waitForBatches(fixture, 1);
    const batchCountBefore = fixture.batches.length;
    await expect(
      transport.resumeCall({
        callId: "call-1",
        endpoint: "https://agent.example.com",
        auth: { mode: "bearer", token: "token" },
        taskId: "task-1",
        contextId: "ctx-1",
        text: "补充",
        nextProducerSequence: 41,
        idempotencyKey: "idem-resume",
      }),
    ).rejects.toMatchObject({ kind: "invalid_correlation" });
    expect(fixture.batches.length).toBe(batchCountBefore);
  });

  it("resume 畸形同步响应（kind/status 非法）→ protocol_schema，且不产生新批次", async () => {
    const fixture = createFixture([
      sseResponse([statusUpdate("working")]),
      jsonResponse({
        jsonrpc: "2.0",
        id: "rpc-2",
        result: { kind: "task", id: "task-1", contextId: "ctx-1" }, // 缺 status
      }),
    ]);
    const transport = makeTransport(fixture);
    await transport.startCall(startRequest());
    await waitForBatches(fixture, 1);
    const batchCountBefore = fixture.batches.length;
    await expect(
      transport.resumeCall({
        callId: "call-1",
        endpoint: "https://agent.example.com",
        auth: { mode: "bearer", token: "token" },
        taskId: "task-1",
        contextId: "ctx-1",
        text: "补充",
        nextProducerSequence: 41,
        idempotencyKey: "idem-resume",
      }),
    ).rejects.toMatchObject({ kind: "protocol_schema" });
    expect(fixture.batches.length).toBe(batchCountBefore);
  });

  it("resume 输入非法（null/undefined/空/空白/纯对象）→ protocol_schema，且不发起网络请求", async () => {
    const invalids: unknown[] = [null, undefined, "", "   ", "\t\n", 42, {}, { foo: "bar" }];
    for (const text of invalids) {
      const fixture = createFixture([sseResponse([statusUpdate("working")])]);
      const transport = makeTransport(fixture);
      await transport.startCall(startRequest());
      await waitForBatches(fixture, 1);
      const batchCountBefore = fixture.batches.length;
      await expect(
        transport.resumeCall({
          callId: "call-1",
          endpoint: "https://agent.example.com",
          auth: { mode: "bearer", token: "token" },
          taskId: "task-1",
          contextId: "ctx-1",
          text: text as string,
          nextProducerSequence: 41,
          idempotencyKey: "idem-resume",
        }),
      ).rejects.toMatchObject({ kind: "protocol_schema" });
      // fail closed 在网络之前：fetch 不再被调用，sink 不再收到批次。
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.batches.length).toBe(batchCountBefore);
    }
  });

  it("resume next producer sequence 非法（null/0/负/非整数/非数字）→ invalid_correlation，且不发起网络请求", async () => {
    const badSeqs: unknown[] = [null, undefined, 0, -1, 1.5, "5", Number.NaN];
    for (const seq of badSeqs) {
      const fixture = createFixture([sseResponse([statusUpdate("working")])]);
      const transport = makeTransport(fixture);
      await transport.startCall(startRequest());
      await waitForBatches(fixture, 1);
      const batchCountBefore = fixture.batches.length;
      await expect(
        transport.resumeCall({
          callId: "call-1",
          endpoint: "https://agent.example.com",
          auth: { mode: "bearer", token: "token" },
          taskId: "task-1",
          contextId: "ctx-1",
          text: "补充",
          nextProducerSequence: seq as number,
          idempotencyKey: "idem-resume",
        }),
      ).rejects.toMatchObject({ kind: "invalid_correlation" });
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.batches.length).toBe(batchCountBefore);
    }
  });

  it("resume 缺 taskId/contextId → resume_target_not_found，且不发起网络请求", async () => {
    const fixture = createFixture([sseResponse([statusUpdate("working")])]);
    const transport = makeTransport(fixture);
    await transport.startCall(startRequest());
    await waitForBatches(fixture, 1);
    const batchCountBefore = fixture.batches.length;
    await expect(
      transport.resumeCall({
        callId: "call-1",
        endpoint: "https://agent.example.com",
        auth: { mode: "bearer", token: "token" },
        taskId: "",
        contextId: "ctx-1",
        text: "补充",
        nextProducerSequence: 41,
        idempotencyKey: "idem-resume",
      }),
    ).rejects.toMatchObject({ kind: "resume_target_not_found" });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.batches.length).toBe(batchCountBefore);
  });

  it("cancel：tasks/cancel 携带官方 TaskIdParams.id（非 taskId），返回成功", async () => {
    const fixture = createFixture([
      jsonResponse({ jsonrpc: "2.0", id: "x", result: { id: "task-9", state: "canceled" } }),
    ]);
    const transport = makeTransport(fixture);
    await transport.cancelCall({
      callId: "call-1",
      endpoint: "https://agent.example.com",
      auth: { mode: "bearer", token: "token" },
      taskId: "task-9",
      idempotencyKey: "idem-cancel",
    });
    const rpc = JSON.parse(String(fixture.requests[0]?.init.body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(rpc.method).toBe("tasks/cancel");
    // 生产 draft 发送 {taskId}，官方 0.3.0 要求 {id}。
    expect(rpc.params.id).toBe("task-9");
    expect("taskId" in rpc.params).toBe(false);
  });

  it("cancel 无 taskId → invalid_correlation，且不发起网络请求", async () => {
    const fixture = createFixture([]);
    const transport = makeTransport(fixture);
    await expect(
      transport.cancelCall({
        callId: "call-1",
        endpoint: "https://agent.example.com",
        auth: { mode: "bearer", token: "token" },
        taskId: "",
        idempotencyKey: "idem",
      }),
    ).rejects.toMatchObject({ kind: "invalid_correlation" });
    expect(fixture.requests).toHaveLength(0);
  });

  it("getCall：tasks/get 携带官方 TaskQueryParams.id（非 taskId），返回 state/taskId/contextId", async () => {
    const fixture = createFixture([
      jsonResponse({
        jsonrpc: "2.0",
        id: "x",
        result: { kind: "task", id: "task-7", contextId: "ctx-7", status: { state: "working" } },
      }),
    ]);
    const transport = makeTransport(fixture);
    const resp = await transport.getCall({
      callId: "call-1",
      endpoint: "https://agent.example.com",
      auth: { mode: "bearer", token: "token" },
      taskId: "task-7",
    });
    expect(resp.state).toBe("working");
    expect(resp.taskId).toBe("task-7");
    expect(resp.contextId).toBe("ctx-7");
    const rpc = JSON.parse(String(fixture.requests[0]?.init.body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(rpc.method).toBe("tasks/get");
    // 生产 draft 发送 {taskId}，官方 0.3.0 要求 {id}。
    expect(rpc.params.id).toBe("task-7");
    expect("taskId" in rpc.params).toBe(false);
  });

  it("getCall：官方 Task 响应 taskId 与请求 taskId 不一致 → invalid_correlation（不得返回错配 ref）", async () => {
    const fixture = createFixture([
      jsonResponse({
        jsonrpc: "2.0",
        id: "x",
        result: {
          kind: "task",
          id: "corrupted-7",
          contextId: "ctx-7",
          status: { state: "working" },
        },
      }),
    ]);
    const transport = makeTransport(fixture);
    // 生产 draft 不校验 tasks/get 返回的 task id 是否与请求 ref 一致。
    await expect(
      transport.getCall({
        callId: "call-1",
        endpoint: "https://agent.example.com",
        auth: { mode: "bearer", token: "token" },
        taskId: "task-7",
      }),
    ).rejects.toMatchObject({ kind: "invalid_correlation" });
  });

  it("getCall：malformed 响应（缺 status/id/contextId）→ protocol_schema", async () => {
    const fixture = createFixture([
      jsonResponse({ jsonrpc: "2.0", id: "x", result: { kind: "task", id: "task-7" } }), // 缺 contextId/status
    ]);
    const transport = makeTransport(fixture);
    await expect(
      transport.getCall({
        callId: "call-1",
        endpoint: "https://agent.example.com",
        auth: { mode: "bearer", token: "token" },
        taskId: "task-7",
      }),
    ).rejects.toMatchObject({ kind: "protocol_schema" });
  });

  it("x-idempotency-key 由 durable idempotencyKey 原样发送（start/resume/cancel 三路）", async () => {
    const fixture = createFixture([
      sseResponse([statusUpdate("working", "task-1", "ctx-1")]),
      jsonResponse({ jsonrpc: "2.0", id: "rpc-2", result: taskResult("task-1", "ctx-1") }),
      jsonResponse({ jsonrpc: "2.0", id: "x", result: { id: "task-1", state: "canceled" } }),
    ]);
    const transport = makeTransport(fixture);
    const headerOf = (index: number) =>
      (fixture.requests[index]?.init.headers as Record<string, string>)["x-idempotency-key"];

    await transport.startCall(startRequest({ idempotencyKey: "idem-start" }));
    expect(headerOf(0)).toBe("idem-start");

    await transport.resumeCall({
      callId: "call-1",
      endpoint: "https://agent.example.com",
      auth: { mode: "bearer", token: "token" },
      taskId: "task-1",
      contextId: "ctx-1",
      text: "补充",
      nextProducerSequence: 41,
      idempotencyKey: "idem-resume",
    });
    expect(headerOf(1)).toBe("idem-resume");

    await transport.cancelCall({
      callId: "call-1",
      endpoint: "https://agent.example.com",
      auth: { mode: "bearer", token: "token" },
      taskId: "task-1",
      idempotencyKey: "idem-cancel",
    });
    expect(headerOf(2)).toBe("idem-cancel");
  });
});

describe("createA2AAgentTransport — auth / probe / capabilities / 错误分类", () => {
  it("probe：Agent Card 标准路径 agent-card.json 恰好一次；protocolVersion 0.3.0 被接受", async () => {
    const fixture = createFixture([
      jsonResponse({
        name: "agent",
        protocolVersion: "0.3.0",
        capabilities: { streaming: true },
      }),
    ]);
    const transport = makeTransport(fixture);
    const caps = await transport.probe({
      endpoint: "https://agent.example.com",
      auth: { mode: "bearer", token: "token" },
    });
    expect(caps.features.event_stream).toBe(true);
    expect(caps.features.steer).toBe(false);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.url).toBe("https://agent.example.com/.well-known/agent-card.json");
    expect(fixture.requests.some((r) => r.url.includes("/.well-known/agent.json"))).toBe(false);
  });

  it("probe：Agent Card protocolVersion 不匹配 0.3.0 → 拒绝", async () => {
    const fixture = createFixture([
      jsonResponse({
        name: "agent",
        protocolVersion: "1.0",
        capabilities: { streaming: true },
      }),
    ]);
    const transport = makeTransport(fixture);
    await expect(
      transport.probe({
        endpoint: "https://agent.example.com",
        auth: { mode: "bearer", token: "token" },
      }),
    ).rejects.toMatchObject({ kind: "protocol_schema" });
  });

  it("probe：不冒充 effective capability（cancel/resume/user_action=false；Agent Card 无对应声明）", async () => {
    const fixture = createFixture([
      // 前置条件：Agent Card 必须声明 A2A 0.3.0，否则 probe 先因版本拒绝，测错目标。
      jsonResponse({ name: "agent", protocolVersion: "0.3.0", capabilities: { streaming: true } }),
    ]);
    const transport = makeTransport(fixture);
    const caps = await transport.probe({
      endpoint: "https://agent.example.com",
      auth: { mode: "bearer", token: "token" },
    });
    expect(caps.features.cancel).toBe(false);
    expect(caps.features.resume).toBe(false);
    expect(caps.features.user_action).toBe(false);
  });

  it("startCall：auth=none 时 wire 上完全不发送 Authorization 头", async () => {
    const fixture = createFixture([
      sseResponse([
        statusUpdate("working"),
        statusUpdate("completed", "task-1", "ctx-1", "ok", true),
      ]),
    ]);
    const transport = makeTransport(fixture);
    await transport.startCall(startRequest({ auth: { mode: "none" } }));
    const headers = fixture.requests[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(Object.keys(headers).some((k) => k.toLowerCase() === "authorization")).toBe(false);
  });

  it("startCall：空 bearer token → 网络前 fail closed（AgentTransportAuthError），0 网络请求", async () => {
    const fixture = createFixture([]);
    const transport = makeTransport(fixture);
    await expect(
      transport.startCall(startRequest({ auth: { mode: "bearer", token: "  " } })),
    ).rejects.toBeInstanceOf(AgentTransportAuthError);
    expect(fixture.requests).toHaveLength(0);
  });

  it("startCall：workload_token（未知 auth mode）→ 网络前 fail closed，0 网络请求，绝不发送内部 Workload Token", async () => {
    const fixture = createFixture([]);
    const transport = makeTransport(fixture);
    await expect(
      transport.startCall(
        startRequest({ auth: { mode: "workload_token", token: "internal-wt" } as never }),
      ),
    ).rejects.toBeInstanceOf(AgentTransportAuthError);
    expect(fixture.requests).toHaveLength(0);
  });

  it("错误分类为 AgentTransportError（稳定 kind，不暴露 SDK 异常字符串合同）", async () => {
    const fixture = createFixture([new Error("ECONNRESET")]);
    const transport = makeTransport(fixture);
    try {
      await transport.startCall(startRequest());
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentTransportError);
      expect((err as AgentTransportError).kind).toBe("stream_interrupted");
    }
  });

  it("startCall：dead endpoint / 401 / 403 / 503 分类", async () => {
    const dead = createFixture([new Error("ECONNREFUSED")]);
    await expect(makeTransport(dead).startCall(startRequest())).rejects.toMatchObject({
      kind: "stream_interrupted",
    });

    const unauthorized = createFixture([new Response("denied", { status: 401 })]);
    await expect(makeTransport(unauthorized).startCall(startRequest())).rejects.toMatchObject({
      kind: "endpoint_auth",
    });

    const forbidden = createFixture([new Response("denied", { status: 403 })]);
    await expect(makeTransport(forbidden).startCall(startRequest())).rejects.toMatchObject({
      kind: "endpoint_auth",
    });

    // 503 = transient（retryable）→ stream_interrupted 语义，非终态。
    const unavailable = createFixture([new Response("unavailable", { status: 503 })]);
    await expect(makeTransport(unavailable).startCall(startRequest())).rejects.toMatchObject({
      kind: "stream_interrupted",
    });
  });

  it("startCall：malformed 响应（SSE data 非 JSON / 结构非法）→ protocol_schema", async () => {
    // SSE data 行非合法 JSON → 解析期 protocol_schema。
    const badJson = createFixture([sseResponse(["{not-json"])]);
    await expect(makeTransport(badJson).startCall(startRequest())).rejects.toMatchObject({
      kind: "protocol_schema",
    });

    const noCorrelation = createFixture([
      sseResponse([JSON.stringify({ jsonrpc: "2.0", id: "x", result: { kind: "status-update" } })]),
    ]);
    await expect(makeTransport(noCorrelation).startCall(startRequest())).rejects.toMatchObject({
      kind: "invalid_correlation",
    });
  });

  it("startCall：capabilities.protocol_versions 是 A2A 0.3.0，不是 runtime protocol 2", async () => {
    const fixture = createFixture([sseResponse([statusUpdate("working", "task-1", "ctx-1")])]);
    const transport = makeTransport(fixture);
    const resp = await transport.startCall(startRequest());
    // 端口类型不表达 protocol_versions（见 capabilitiesEvidence helper）；生产 draft
    // 返回 ["2"]（Runtime 协议版本），A2A 应为 ["0.3.0"]。
    expect(capabilitiesEvidence(resp).protocol_versions).toEqual(["0.3.0"]);
  });

  it("05 专项：startCall 只投影冻结 effective profile（cancel=false/resume=true/user_action=true）", async () => {
    const fixture = createFixture([sseResponse([statusUpdate("working", "task-1", "ctx-1")])]);
    const transport = makeTransport(fixture, {
      capabilities: {
        cancel: false,
        resume: true,
        steer: false,
        user_action: true,
        streaming: true,
      },
    });
    const resp = await transport.startCall(startRequest());
    expect(capabilitiesEvidence(resp).features).toMatchObject({
      cancel: false,
      resume: true,
      steer: false,
      user_action: true,
      event_stream: true,
      dynamic_tools: false,
    });
  });

  it("05 §6：cancel=false → cancelCall 本地 unsupported_capability，不发网络请求", async () => {
    const fixture = createFixture([]);
    const transport = makeTransport(fixture, {
      capabilities: { cancel: false, resume: true, steer: false },
    });
    await expect(
      transport.cancelCall({
        callId: "call-1",
        endpoint: "https://agent.example.com",
        auth: { mode: "bearer", token: "token" },
        taskId: "task-1",
        idempotencyKey: "idem",
      }),
    ).rejects.toMatchObject({ kind: "unsupported_capability" });
    expect(fixture.requests).toHaveLength(0);
  });

  it("05 §6：resume=false → resumeCall 本地 unsupported_capability，不发网络请求", async () => {
    const fixture = createFixture([]);
    const transport = makeTransport(fixture, {
      capabilities: { cancel: true, resume: false, steer: false },
    });
    await expect(
      transport.resumeCall({
        callId: "call-1",
        endpoint: "https://agent.example.com",
        auth: { mode: "bearer", token: "token" },
        taskId: "task-1",
        contextId: "ctx-1",
        text: "补充",
        nextProducerSequence: 41,
        idempotencyKey: "idem",
      }),
    ).rejects.toMatchObject({ kind: "unsupported_capability" });
    expect(fixture.requests).toHaveLength(0);
  });
});

describe("createA2AAgentTransport — 背景流终态与 Recovery（06 §5–§9）", () => {
  /** 等待条件成立（背景流消费是异步任务）。 */
  async function waitUntil(predicate: () => boolean, ms = 1_000): Promise<void> {
    for (let i = 0; i < ms / 5 && !predicate(); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** 中途 socket 断开的 SSE 流：逐块发出 raw 片段，发完后 reader 抛错。 */
  function sseChunksThenError(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const pending = [...chunks];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = pending.shift();
        if (chunk === undefined) {
          controller.error(new Error("socket reset by peer"));
          return;
        }
        controller.enqueue(encoder.encode(chunk));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("completed → EOF：不 lost（不上报背景失败）", async () => {
    const fixture = createFixture([
      sseResponse([
        statusUpdate("working"),
        statusUpdate("completed", "task-1", "ctx-1", "答复", true),
      ]),
    ]);
    const failures: string[] = [];
    const transport = makeTransport(fixture, {
      onBackgroundFailure: (report) => {
        failures.push(report.failureKind);
      },
    });
    await transport.startCall(startRequest());
    await waitForBatches(fixture, 3);
    await new Promise((r) => setTimeout(r, 50));
    expect(failures).toEqual([]);
  });

  it("input-required → EOF：不 lost（06 §6：EOF 也正常）", async () => {
    const fixture = createFixture([
      sseResponse([statusUpdate("working"), statusUpdate("input-required")]),
    ]);
    const failures: string[] = [];
    const transport = makeTransport(fixture, {
      onBackgroundFailure: (report) => {
        failures.push(report.failureKind);
      },
    });
    await transport.startCall(startRequest());
    await waitForBatches(fixture, 3);
    await new Promise((r) => setTimeout(r, 50));
    expect(failures).toEqual([]);
  });

  it("working → socket close：stream_read_failed → lost", async () => {
    const fixture = createFixture([sseChunksThenError([`data: ${statusUpdate("working")}\n\n`])]);
    const failures: Array<{ callId: string; failureKind: string }> = [];
    const transport = makeTransport(fixture, {
      onBackgroundFailure: (report) => {
        failures.push({ callId: report.callId, failureKind: report.failureKind });
      },
    });
    await transport.startCall(startRequest());
    await waitUntil(() => failures.length > 0);
    expect(failures).toEqual([{ callId: "call-1", failureKind: "stream_read_failed" }]);
  });

  it("malformed JSON：protocol_parse_failed → lost", async () => {
    const fixture = createFixture([
      sseChunksThenError([`data: ${statusUpdate("working")}\n\n`, "data: {invalid\n\n"]),
    ]);
    const failures: string[] = [];
    const transport = makeTransport(fixture, {
      onBackgroundFailure: (report) => {
        failures.push(report.failureKind);
      },
    });
    await transport.startCall(startRequest());
    await waitUntil(() => failures.length > 0);
    expect(failures).toEqual(["protocol_parse_failed"]);
  });

  it("首个 durable handoff 写库失败：startCall fail closed + ingress_failed，停止消费", async () => {
    const fixture = createFixture([sseResponse([statusUpdate("working")])]);
    const failures: string[] = [];
    let sinkCalls = 0;
    const transport = makeTransport(fixture, {
      eventSink: async () => {
        sinkCalls += 1;
        throw new Error("db: connection refused");
      },
      onBackgroundFailure: (report) => {
        failures.push(report.failureKind);
      },
    });
    await expect(transport.startCall(startRequest())).rejects.toMatchObject({
      kind: "stream_interrupted",
    });
    expect(failures).toEqual(["ingress_failed"]);
    const settled = sinkCalls;
    await new Promise((r) => setTimeout(r, 50));
    expect(sinkCalls).toBe(settled);
  });

  it("remote failed：call.failed 协议终态，不 lost", async () => {
    const fixture = createFixture([
      sseResponse([
        statusUpdate("working"),
        statusUpdate("failed", "task-1", "ctx-1", "出错", true),
      ]),
    ]);
    const failures: string[] = [];
    const transport = makeTransport(fixture, {
      onBackgroundFailure: (report) => {
        failures.push(report.failureKind);
      },
    });
    await transport.startCall(startRequest());
    await waitForBatches(fixture, 3);
    await new Promise((r) => setTimeout(r, 50));
    expect(failures).toEqual([]);
    expect(fixture.batches.some((b) => b.events.some((e) => e.type === "call.failed"))).toBe(true);
  });
});

describe("createA2AAgentTransport — A2A wire 契约缺陷（生产 draft 未达标，保持 RED）", () => {
  /** 等待条件成立（背景流消费是异步任务）。 */
  async function waitUntil(predicate: () => boolean, ms = 1_000): Promise<void> {
    for (let i = 0; i < ms / 5 && !predicate(); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** 中途 socket 断开的 SSE 流：逐块发出 raw 片段，发完后 reader 抛错。 */
  function sseChunksThenError(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const pending = [...chunks];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = pending.shift();
        if (chunk === undefined) {
          controller.error(new Error("socket reset by peer"));
          return;
        }
        controller.enqueue(encoder.encode(chunk));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("首个 correlation 之后，流事件 taskId/contextId 不匹配必须 fail closed（correlation_lost）", async () => {
    // 首个 correlation 确立 task-1/ctx-1，随后同一流出现 task-2/ctx-2（被篡改/串流）。
    const fixture = createFixture([
      sseResponse([
        statusUpdate("working", "task-1", "ctx-1"),
        statusUpdate("working", "task-2", "ctx-2"),
      ]),
    ]);
    const failures: string[] = [];
    const transport = makeTransport(fixture, {
      onBackgroundFailure: (report) => {
        failures.push(report.failureKind);
      },
    });
    await transport.startCall(startRequest());
    await waitUntil(() => failures.length > 0);
    // 生产 draft 不校验 correlation 一致性，静默覆盖 taskId → 永不报 correlation_lost。
    expect(failures).toContain("correlation_lost");
  });

  it("同一 chunk 内首事件 taskId 与后事件 taskId 不一致 → correlation_lost（不能重定 correlation）", async () => {
    const oneChunk =
      `data: ${statusUpdate("working", "task-1", "ctx-1")}\n\n` +
      `data: ${statusUpdate("working", "task-9", "ctx-9")}\n\n`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode(oneChunk));
        controller.close();
      },
    });
    const fixture = createFixture([
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ]);
    const failures: string[] = [];
    const transport = makeTransport(fixture, {
      onBackgroundFailure: (report) => {
        failures.push(report.failureKind);
      },
    });
    await transport.startCall(startRequest());
    await waitUntil(() => failures.length > 0);
    expect(failures).toContain("correlation_lost");
  });

  it("unknown/malformed state：startCall 必须在网络内 fail closed 为 protocol_schema（不得静默忽略、不得漏原始异常）", async () => {
    const fixture = createFixture([
      sseResponse([
        statusUpdate("working", "task-1", "ctx-1"),
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          result: {
            kind: "status-update",
            taskId: "task-1",
            contextId: "ctx-1",
            status: { state: "bogus-state" },
          },
        }),
      ]),
    ]);
    const transport = makeTransport(fixture);
    // 前置条件：首个合法 correlation 确立后，随后的 unknown state 必须 fail closed。
    // 生产 draft 的 mapper 抛裸 Error（非 AgentTransportError），startCall 把它原样漏出 →
    // 未归类为 protocol_schema，即 fail closed 但归类缺失。
    await expect(transport.startCall(startRequest())).rejects.toMatchObject({
      kind: "protocol_schema",
    });
  });

  it("多独立调用共享一个 transport，背景失败处理必须互相独立（不得全局布尔抑制）", async () => {
    // 两个独立 call 各自流失败；第二个 call 的失败也必须被上报。
    const mkFail = () =>
      sseChunksThenError([`data: ${statusUpdate("working", "task-1", "ctx-1")}\n\n`]);
    const fixture = createFixture([mkFail(), mkFail()]);
    const failures: Array<{ callId: string; failureKind: string }> = [];
    const transport = makeTransport(fixture, {
      onBackgroundFailure: (report) => {
        failures.push({ callId: report.callId, failureKind: report.failureKind });
      },
    });
    await transport.startCall(startRequest({ callId: "call-A" }));
    await waitUntil(() => failures.some((f) => f.callId === "call-A"));
    await transport.startCall(startRequest({ callId: "call-B" }));
    await waitUntil(() => failures.some((f) => f.callId === "call-B"));
    // 生产 draft 的 backgroundFailureReported 是 transport 级全局布尔，call-A 失败后
    // 会抑制 call-B 的上报 → 第二个 call 的失败被吞掉。
    expect(
      failures.some((f) => f.callId === "call-B" && f.failureKind === "stream_read_failed"),
    ).toBe(true);
  });

  it("start stream 首事件为官方 Task 形态（kind:task + 状态）时，该初始 Task 状态须归一化为 call.started", async () => {
    const fixture = createFixture([
      sseResponse([
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          result: {
            kind: "task",
            id: "task-1",
            contextId: "ctx-1",
            status: { state: "working" },
          },
        }),
        statusUpdate("completed", "task-1", "ctx-1", "ok", true),
      ]),
    ]);
    const transport = makeTransport(fixture);
    const resp = await transport.startCall(startRequest());
    expect(resp.taskId).toBe("task-1");
    await waitForBatches(fixture, 2);
    const types = fixture.batches.flatMap((b) => b.events).map((e) => e.type);
    // 生产 draft 只用官方 Task 形态作 correlation 来源，不把它归一化为事件 →
    // 首个 call.started 缺失。
    expect(types).toContain("call.started");
  });

  it("背景流 reader.read 卡死超过 streamTimeoutMs 必须上报（不能无限挂起）", async () => {
    // 流发完首个 correlation 事件后永不 EOF、永不发送终态（read 永不 resolve）。
    const first = `data: ${statusUpdate("working", "task-1", "ctx-1")}\n\n`;
    const encoder = new TextEncoder();
    let sentFirst = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentFirst) {
          sentFirst = true;
          controller.enqueue(encoder.encode(first));
          return;
        }
        // 后续永不 resolve（模拟 Provider 挂起），draft 的 collectOneEvent 在此无限阻塞。
      },
    });
    const fixture = createFixture([
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ]);
    const failures: string[] = [];
    const transport = makeTransport(fixture, {
      streamTimeoutMs: 200,
      onBackgroundFailure: (report) => {
        failures.push(report.failureKind);
      },
    });
    const resp = await transport.startCall(startRequest());
    expect(resp.taskId).toBe("task-1");
    // 生产 draft 的 reader.read 无超时，后台消费无限挂起 → 不会上报任何背景失败。
    // 用有限等待竞态验证，不悬挂超过测试超时。
    await waitUntil(() => failures.length > 0, 500);
    expect(failures).not.toEqual([]);
  });
});
