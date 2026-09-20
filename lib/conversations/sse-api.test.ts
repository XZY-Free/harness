/**
 * S04-C05：SSE 持久续读集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖 GET /api/threads/{thread_id}/events（§3.6）：
 * - 核心场景：无 Last-Event-ID 连接、Last-Event-ID 续读、after_sequence 续读、两者同时存在。
 * - 错误场景：Thread 不存在、跨租户、Last-Event-ID 过期、after_sequence 非法。
 * - 事件格式：SSE id = 十进制 event_sequence、event = eventType、data 含必要字段。
 * - 新事件推送：连接后新 Turn 产生的事件能被推送。
 * - 关闭连接后不影响其他操作。
 *
 * 测试环境：APP_ENV=test，显式 Vitest 身份夹具（resolvePrincipal 使用 DEFAULT_USER_ID）。
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { GET as eventsGET } from "@/app/api/threads/[threadId]/events/route";
import { POST as createTurnPOST } from "@/app/api/threads/[threadId]/turns/route";
import { POST as createThreadPOST } from "@/app/api/threads/route";
import {
  initEventStreamFloor,
  updateEventStreamFloorEarliest,
} from "@/lib/conversations/projection-checkpoint-queries";
import { THREAD_EVENT_STREAM } from "@/lib/conversations/projector";
import { db } from "@/lib/db/client";
import { assertCrossTenantHidden, buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { markAttemptPreparedInTransaction } from "@/lib/executions/persistence/attempt-store";
import { acquireTestRuntimeAuthority } from "@/lib/executions/test-support/seed-runtime-authority";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { publishThreadTransientEvent } from "@/lib/runtime/transient-event-bus";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_VITEST_IDENTITY_FIXTURE=enabled（与 employee-api.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_VITEST_IDENTITY_FIXTURE;

beforeEach(async () => {
  process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_VITEST_IDENTITY_FIXTURE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：seed 默认身份 + 可调度的 Agent + Ready Route ─────
//
// SSE 事件流测试需要 Turn 真正被调度（dispatched=true）才会产生
// item.created / turn.accepted 之外的执行事件。因此这里用
// seedDispatchableTurn 建出完整正式链上下文（§27"测试必须证明生产链"），
// 仅暴露测试用到的 agent.id 与 tenantId，保持调用点不变。

async function seedContext() {
  const { tenantId, agentId, ownerId } = await seedDispatchableTurn({
    agentKey: "sse-agent",
  });
  return { tenantId, userIdentityId: ownerId, agent: { id: agentId } };
}

/**
 * seed Thread + Turn，产生 3 个事件：
 * thread.created(1) + turn.accepted(2) + item.created(3)。
 */
async function seedThreadWithTurn(agentId: string, key: string): Promise<string> {
  const createReq = buildApiRequest({
    audience: "employee",
    method: "POST",
    path: "/threads",
    idempotencyKey: `${key}-thread`,
    body: { agent_id: agentId },
  });
  const createResp = await createThreadPOST(createReq);
  const { id: threadId } = (await createResp.json()) as { id: string };

  const turnReq = buildApiRequest({
    audience: "employee",
    method: "POST",
    path: `/threads/${threadId}/turns`,
    idempotencyKey: `${key}-turn`,
    body: { input: { type: "text", text: "SSE 测试" } },
  });
  await createTurnPOST(turnReq, {
    params: Promise.resolve({ threadId: threadId }),
  });

  return threadId;
}

/** 再创建一个 Turn，产生 turn.accepted(4) + item.created(5)（不含 thread.created）。 */
async function createAnotherTurn(threadId: string, key: string): Promise<void> {
  const turnReq = buildApiRequest({
    audience: "employee",
    method: "POST",
    path: `/threads/${threadId}/turns`,
    idempotencyKey: `${key}-turn`,
    body: { input: { type: "text", text: "第二条消息" } },
  });
  const resp = await createTurnPOST(turnReq, {
    params: Promise.resolve({ threadId: threadId }),
  });
  expect(resp.status).toBe(201);
}

// ─── SSE 解析辅助 ──────────────────────────────────────────

interface ParsedSSE {
  id?: number;
  event: string;
  data: unknown;
}

/** 解析单条 SSE 文本（不含末尾空行）为结构。 */
function parseSSEMessage(text: string): ParsedSSE | null {
  const lines = text.split("\n");
  let id: number | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("id: ")) {
      id = Number.parseInt(line.slice(4), 10);
    } else if (line.startsWith("event: ")) {
      event = line.slice(7);
    } else if (line.startsWith("data: ")) {
      dataLines.push(line.slice(6));
    }
  }
  if (event === undefined) return null;
  const dataStr = dataLines.join("\n");
  let data: unknown = dataStr;
  try {
    data = JSON.parse(dataStr);
  } catch {
    // 保留原始字符串
  }
  return { id, event, data };
}

/**
 * 从流中读取 N 条 SSE 消息（带超时）。
 * 超时返回已读取的消息（可能不足 N 条）。
 */
async function readSSEMessages(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
  timeoutMs = 3000,
): Promise<ParsedSSE[]> {
  const messages: ParsedSSE[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  while (messages.length < count) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true }>((resolve) =>
      setTimeout(() => resolve({ done: true }), remaining),
    );
    const result = await Promise.race([readPromise, timeoutPromise]);
    if (result.done) break;
    if (result.value) {
      buffer += decoder.decode(result.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim()) {
          const msg = parseSSEMessage(part);
          if (msg) messages.push(msg);
        }
      }
    }
  }
  return messages;
}

/**
 * 读取连接建立时的**两条控制消息**：`stream.resumed` + `stream.generation`。
 *
 * A11：代际基线必须先于任何 transient 投递下发，因此它是连接初始化固定的一部分；
 * 位置敏感的历史断言不应再假设"resumed 之后立刻就是持久事件"。
 */
async function readStreamPrelude(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ resumed: ParsedSSE; generation: ParsedSSE }> {
  const messages = await readSSEMessages(reader, 2);
  expect(messages).toHaveLength(2);
  const resumed = messages[0];
  const generation = messages[1];
  expect(resumed?.event).toBe("stream.resumed");
  expect(generation?.event).toBe("stream.generation");
  if (!resumed || !generation) throw new Error("控制消息缺失");
  return { resumed, generation };
}

/**
 * 读到**第一条指定 event 名称**的消息（跳过持久 backlog 与其它控制消息）。
 *
 * A11：连接建立后流里既有持久 backlog，也可能插入代际控制消息，因此 transient 断言
 * 不能再假设"prelude 之后的下一条就是 transient"。
 */
async function readUntilEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  event: string,
  timeoutMs = 3000,
): Promise<ParsedSSE | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [message] = await readSSEMessages(reader, 1, Math.max(1, deadline - Date.now()));
    if (!message) return null;
    if (message.event === event) return message;
  }
  return null;
}

/**
 * 用 reader 执行测试回调，结束后自动 cancel reader 清理 SSE 轮询。
 */
async function withSseReader<T>(
  response: Response,
  fn: (reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<T>,
): Promise<T> {
  if (!response.body) throw new Error("response.body 为 null");
  const reader = response.body.getReader();
  try {
    return await fn(reader);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** 调用 SSE 路由。 */
async function callEventsRoute(
  threadId: string,
  options?: { lastEventId?: string; afterSequence?: string; includeTransient?: string },
): Promise<Response> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (options?.lastEventId !== undefined) headers["last-event-id"] = options.lastEventId;
  const query = new URLSearchParams();
  if (options?.afterSequence !== undefined) query.set("after_sequence", options.afterSequence);
  if (options?.includeTransient !== undefined)
    query.set("include_transient", options.includeTransient);
  const path = query.toString()
    ? `/threads/${threadId}/events?${query}`
    : `/threads/${threadId}/events`;
  const request = buildApiRequest({
    audience: "employee",
    method: "GET",
    path,
    headers,
  });
  return eventsGET(request, { params: Promise.resolve({ threadId: threadId }) });
}

// ═══════════════════════════════════════════════════════════
// 1. 核心场景
// ═══════════════════════════════════════════════════════════

describe("GET /api/threads/{thread_id}/events — 核心场景", () => {
  it("无 Last-Event-ID 连接 → stream.resumed + 后续 Event", async () => {
    const { agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "core-no-cursor");

    const response = await callEventsRoute(threadId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    await withSseReader(response, async (reader) => {
      // A11：先读两条控制消息（stream.resumed + 权威代际基线），再读持久事件。
      const { resumed } = await readStreamPrelude(reader);
      expect(resumed.id).toBeUndefined();
      const resumedData = resumed.data as { latest_sequence: number };
      // Hosted Runtime 会在 Turn 接纳后异步追加 response/execution 事件，
      // 因此建立连接时的最新序号可能已超过 seed 阶段的 3。
      expect(resumedData.latest_sequence).toBeGreaterThanOrEqual(3);

      // 后续 3 条：持久 Event，sequence 1/2/3
      const events = await readSSEMessages(reader, 3);
      expect(events).toHaveLength(3);
      expect(events[0]?.id).toBe(1);
      expect(events[1]?.id).toBe(2);
      expect(events[2]?.id).toBe(3);
    });
  });

  it("带 Last-Event-ID 续读：从 sequence+1 开始发送", async () => {
    const { agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "core-last-event-id");

    const response = await callEventsRoute(threadId, { lastEventId: "1" });
    expect(response.status).toBe(200);

    await withSseReader(response, async (reader) => {
      await readStreamPrelude(reader);
      // 事件 2, 3
      const events = await readSSEMessages(reader, 2);
      expect(events).toHaveLength(2);
      expect(events[0]?.id).toBe(2);
      expect(events[1]?.id).toBe(3);
    });
  });

  it("带 after_sequence 续读：等效 Last-Event-ID", async () => {
    const { agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "core-after-seq");

    const response = await callEventsRoute(threadId, { afterSequence: "1" });
    expect(response.status).toBe(200);

    await withSseReader(response, async (reader) => {
      await readStreamPrelude(reader);
      const events = await readSSEMessages(reader, 2);
      expect(events).toHaveLength(2);
      expect(events[0]?.id).toBe(2);
      expect(events[1]?.id).toBe(3);
    });
  });

  it("Last-Event-ID 和 after_sequence 同时存在：以 Last-Event-ID 为准", async () => {
    const { agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "core-both");

    // Last-Event-ID=2 优先；after_sequence=1 应被忽略
    const response = await callEventsRoute(threadId, {
      lastEventId: "2",
      afterSequence: "1",
    });
    expect(response.status).toBe(200);

    await withSseReader(response, async (reader) => {
      await readStreamPrelude(reader);
      // 从 sequence 3 开始（Last-Event-ID=2 → 3）
      const events = await readSSEMessages(reader, 1);
      expect(events).toHaveLength(1);
      expect(events[0]?.id).toBe(3);
    });
  });

  it("after_sequence=0 等效无 cursor → 从 sequence 1 开始", async () => {
    const { agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "core-after-zero");

    const response = await callEventsRoute(threadId, { afterSequence: "0" });
    expect(response.status).toBe(200);

    await withSseReader(response, async (reader) => {
      await readStreamPrelude(reader);
      const events = await readSSEMessages(reader, 3);
      expect(events).toHaveLength(3);
      expect(events[0]?.id).toBe(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 2. 错误场景
// ═══════════════════════════════════════════════════════════

describe("GET /api/threads/{thread_id}/events — 错误场景", () => {
  it("Thread 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    await seedContext();
    const response = await callEventsRoute("non-existent-thread");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("跨租户访问 → 404 隐藏式", async () => {
    const requestId = "req-sse-cross-tenant";
    const request = buildApiRequest({
      audience: "employee",
      method: "GET",
      path: "/threads/other-tenant-thread/events",
      requestId,
      headers: { accept: "text/event-stream" },
    });
    const response = await eventsGET(request, {
      params: Promise.resolve({ threadId: "other-tenant-thread" }),
    });
    await assertCrossTenantHidden(response, requestId);
  });

  it("Last-Event-ID < earliest_available_sequence → 409 EVENT_CURSOR_EXPIRED + details", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "expired-cursor");

    // 手动插入 event_stream_floor，设 earliest=5
    await initEventStreamFloor({
      streamType: THREAD_EVENT_STREAM,
      streamId: threadId,
      tenantId,
      latestSequence: 3,
    });
    await updateEventStreamFloorEarliest(THREAD_EVENT_STREAM, threadId, 5);

    const response = await callEventsRoute(threadId, { lastEventId: "3" });
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: {
        code: string;
        details: {
          stream_id: string;
          requested_sequence: number;
          earliest_available_sequence: number;
        };
      };
    };
    expect(body.error.code).toBe("EVENT_CURSOR_EXPIRED");
    expect(body.error.details.stream_id).toBe(threadId);
    expect(body.error.details.requested_sequence).toBe(3);
    expect(body.error.details.earliest_available_sequence).toBe(5);
  });

  it("after_sequence 为负数 → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "bad-after-neg");

    const response = await callEventsRoute(threadId, { afterSequence: "-1" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("after_sequence 非数字 → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "bad-after-nan");

    const response = await callEventsRoute(threadId, { afterSequence: "abc" });
    expect(response.status).toBe(400);
  });

  it("Last-Event-ID 为负数 → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "bad-lei-neg");

    const response = await callEventsRoute(threadId, { lastEventId: "-5" });
    expect(response.status).toBe(400);
  });

  it("include_transient=false 不报错（参数被接受）", async () => {
    const { agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "transient-false");

    const response = await callEventsRoute(threadId, { includeTransient: "false" });
    expect(response.status).toBe(200);

    await withSseReader(response, async (reader) => {
      const messages = await readSSEMessages(reader, 1);
      expect(messages[0]?.event).toBe("stream.resumed");
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 事件格式
// ═══════════════════════════════════════════════════════════

describe("GET /api/threads/{thread_id}/events — 事件格式", () => {
  it("SSE id 等于十进制 event_sequence；event 等于 eventType；data 含必要字段", async () => {
    const { agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "format");

    const response = await callEventsRoute(threadId);
    expect(response.status).toBe(200);

    await withSseReader(response, async (reader) => {
      // A11：控制消息固定两条（resumed + generation），之后才是持久事件。
      await readStreamPrelude(reader);
      const events = await readSSEMessages(reader, 3);
      expect(events).toHaveLength(3);

      for (let i = 0; i < events.length; i++) {
        const msg = events[i];
        if (!msg) continue;
        // SSE id = event_sequence（十进制）
        expect(msg.id).toBe(i + 1);
        // event 字段 = eventType（非空字符串）
        expect(typeof msg.event).toBe("string");
        expect(msg.event.length).toBeGreaterThan(0);
        // data 是合法 JSON 对象
        expect(typeof msg.data).toBe("object");
        const data = msg.data as Record<string, unknown>;
        // 含必要字段
        expect(data.event_id).toEqual(expect.any(String));
        expect(data.sequence).toBe(i + 1);
        expect(data.schema_version).toBe(1);
        expect(data.thread_id).toBe(threadId);
        expect(data.payload).toEqual(expect.any(Object));
        expect(data.occurred_at).toEqual(expect.any(String));
      }
    });
  });

  it("thread.created 事件的 turn_id/item_id 为 null", async () => {
    const { agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "format-null-fields");

    const response = await callEventsRoute(threadId);
    expect(response.status).toBe(200);

    await withSseReader(response, async (reader) => {
      await readStreamPrelude(reader);
      const events = await readSSEMessages(reader, 3);
      // thread.created 是 sequence=1 的事件
      const created = events[0];
      expect(created?.id).toBe(1);
      const data = created?.data as Record<string, unknown>;
      expect(data.turn_id).toBeNull();
      expect(data.item_id).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 4. 新事件推送
// ═══════════════════════════════════════════════════════════

describe("GET /api/threads/{thread_id}/events — 新事件推送", () => {
  /**
   * A11：建出"当前有一代 Hosted 执行者正在跑"的真实上下文（Thread/Turn 走真实调度链），
   * 并返回该 Turn 的权威代际，供基线断言与 transient 发布使用。
   */
  async function seedExecutingTurn(agentKey: string) {
    const ctx = await seedDispatchableTurn({ agentKey });
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: {
        tenantId: ctx.tenantId,
        subjectType: "user",
        subjectId: ctx.ownerId,
      },
    });
    const { invocation, binding, attempt } = dispatch;
    if (!invocation || !binding || !attempt) throw new Error("调度失败");
    const evidence = {
      kind: "sse-api-transient-generation",
      invocationId: invocation.id,
      attemptId: attempt.id,
    };
    await db.transaction((tx) =>
      markAttemptPreparedInTransaction(tx, {
        attemptId: attempt.id,
        evidence,
        digest: protocolDigest(evidence),
      }),
    );
    const gen = await acquireTestRuntimeAuthority({
      tenantId: ctx.tenantId,
      invocationId: invocation.id,
      attemptId: attempt.id,
      runtimeRevisionId: binding.runtimeRevisionId,
      phase: "dispatching",
    });
    return {
      ctx,
      invocationId: invocation.id,
      generation: {
        invocationId: invocation.id,
        attemptId: gen.ownership.attemptId,
        ownershipId: gen.ownership.id,
        leaseEpoch: String(gen.ownership.leaseEpoch),
      },
    };
  }

  it("response.delta 通过无 id 的 transient SSE 立即推送，且基线携带完整权威代际（A11）", async () => {
    const { ctx, invocationId, generation } = await seedExecutingTurn("sse-agent-transient");
    const { threadId, turnId } = ctx;
    const response = await callEventsRoute(threadId, { lastEventId: "1" });

    await withSseReader(response, async (reader) => {
      // A11：基线必须来自**正式执行事实**，而不是"第一条 delta 自报"。
      const { generation: baselineMsg } = await readStreamPrelude(reader);
      const baseline = baselineMsg.data as {
        thread_id: string;
        generations: Array<{ turn_id: string; generation: unknown }>;
      };
      expect(baseline.thread_id).toBe(threadId);
      const entry = baseline.generations.find((candidate) => candidate.turn_id === turnId);
      expect(entry?.generation).toEqual({
        invocation_id: invocationId,
        attempt_id: generation.attemptId,
        ownership_id: generation.ownershipId,
        lease_epoch: generation.leaseEpoch,
      });

      publishThreadTransientEvent({
        transientId: "delta-route-1",
        threadId,
        turnId,
        // A11：transient 必须带完整代际；与基线 exact tuple 一致才允许进入展示流。
        generation,
        type: "response.delta",
        occurredAt: "2026-07-21T00:00:00.000Z",
        payload: { delta: "增量正文" },
      });

      // 跳过持久 backlog，读到的第一条 delta 必须就是刚发布的那条。
      const delta = await readUntilEvent(reader, "response.delta");
      expect(delta?.event).toBe("response.delta");
      expect(delta?.id).toBeUndefined();
      expect(delta?.data).toMatchObject({
        transient_id: "delta-route-1",
        thread_id: threadId,
        turn_id: turnId,
        generation: {
          invocation_id: invocationId,
          attempt_id: generation.attemptId,
          ownership_id: generation.ownershipId,
          lease_epoch: generation.leaseEpoch,
        },
        occurred_at: "2026-07-21T00:00:00.000Z",
        payload: { delta: "增量正文" },
      });
    });
  });

  it("A11：旧代际的一次性 buffer 不得进入新正文 —— 基线先于缓冲应用", async () => {
    const { ctx, invocationId, generation } = await seedExecutingTurn("sse-agent-stale-buffer");
    const { threadId, turnId } = ctx;

    // 连接建立**之前**产生一条旧代际 transient：此时无 listener → 落进一次性 buffer。
    // 旧实现会在 subscribe 时同步 drain 并直接输出（早于基线），这正是要暴露的缺口。
    publishThreadTransientEvent({
      transientId: "stale-buffered",
      threadId,
      turnId,
      generation: {
        invocationId,
        attemptId: "stale-attempt",
        ownershipId: "stale-ownership",
        leaseEpoch: "1",
      },
      type: "response.delta",
      occurredAt: "2026-07-21T00:00:00.000Z",
      payload: { delta: "旧代际残留" },
    });

    const response = await callEventsRoute(threadId, { lastEventId: "1" });

    await withSseReader(response, async (reader) => {
      // 1. 控制消息先到：resumed 在旧实现里会排在同步 drain 的 transient 之后，遂立即失败。
      const { generation: baselineMsg } = await readStreamPrelude(reader);
      const baseline = baselineMsg.data as { generations: Array<{ turn_id: string }> };
      expect(baseline.generations.some((entry) => entry.turn_id === turnId)).toBe(true);

      // 2. 与基线一致的代际才可投递；旧代际 buffer 已按 exact tuple 过滤掉。
      publishThreadTransientEvent({
        transientId: "fresh-after-baseline",
        threadId,
        turnId,
        generation,
        type: "response.delta",
        occurredAt: "2026-07-21T00:00:01.000Z",
        payload: { delta: "新代际正文" },
      });

      // 跳过持久 backlog：第一条 delta 必须已是新代际那条。
      // 若旧代际 buffer 被展示，这里会先读到 stale-buffered。
      const delta = await readUntilEvent(reader, "response.delta");
      expect(delta?.event).toBe("response.delta");
      expect((delta?.data as { transient_id: string }).transient_id).toBe("fresh-after-baseline");
      expect((delta?.data as { payload: { delta: string } }).payload.delta).toBe("新代际正文");
    });
  });

  it("连接建立后新创建 Turn 产生的事件能被推送到流中", async () => {
    const { agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "push");
    // 当前 latest_sequence=3

    // 从 sequence 3 续订（无 backlog）
    const response = await callEventsRoute(threadId, { lastEventId: "3" });
    expect(response.status).toBe(200);

    await withSseReader(response, async (reader) => {
      // A11：先读两条控制消息（stream.resumed + 权威代际基线）
      await readStreamPrelude(reader);

      // 在连接保持期间创建新 Turn（产生 sequence 4, 5）
      await createAnotherTurn(threadId, "push-2");

      // 等待轮询推送新事件（200ms 间隔，给足时间）
      const pushed = await readSSEMessages(reader, 2, 3000);
      const ids = pushed.map((m) => m.id);
      // 新 Turn 产生 2 个事件：turn.accepted(4) + item.created(5)
      expect(ids).toContain(4);
      expect(ids).toContain(5);
    });
  });

  it("关闭连接后不影响其他操作（新 Turn 仍可创建）", async () => {
    const { agent } = await seedContext();
    const threadId = await seedThreadWithTurn(agent.id, "close-and-create");

    const response = await callEventsRoute(threadId, { lastEventId: "3" });
    expect(response.status).toBe(200);

    // 读取后立即关闭
    await withSseReader(response, async (reader) => {
      const first = await readSSEMessages(reader, 1);
      expect(first[0]?.event).toBe("stream.resumed");
    });

    // 流关闭后，创建新 Turn 仍应成功
    await createAnotherTurn(threadId, "after-close");
  });
});
