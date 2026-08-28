import { describe, expect, it, vi } from "vitest";
import { createThreadClient, requiresSnapshotRefresh } from "./thread-client";
import type { ClientEvent } from "./types";

/** 可控 SSE 响应体：可按需向已建立的 SSE 连接 push 事件。 */
function makeSseBody(): {
  body: ReadableStream<Uint8Array>;
  push: (eventType: string, data: Record<string, unknown>) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    body,
    push: (eventType, data) => {
      controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    close: () => controller.close(),
  };
}

/**
 * 摘要 Item resnapshot 测试夹具：/items 立即返回可配置 cursor，
 * /events 返回可控 SSE 流（记录每次连接，便于向最新连接 push 事件）。
 */
function makeSseHarness() {
  let cursor: { sequence: number; event_id: string | null } = { sequence: 0, event_id: null };
  let itemsCalls = 0;
  const events: Array<ReturnType<typeof makeSseBody>> = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/items")) {
      itemsCalls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], latest_event_cursor: cursor }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.includes("/events")) {
      const sse = makeSseBody();
      events.push(sse);
      return Promise.resolve(
        new Response(sse.body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  return {
    fetchImpl,
    events,
    get itemsCalls() {
      return itemsCalls;
    },
    setCursor: (sequence: number, event_id: string | null) => {
      cursor = { sequence, event_id };
    },
  };
}

/** 摘要 Item 事件：payload 无完整 item（item.created + content_hash）。 */
function digestEvent(overrides: Partial<ClientEvent> = {}): ClientEvent {
  return event({
    event_type: "item.created",
    payload: { item_type: "assistant_message", content_hash: "sha256:example" },
    ...overrides,
  });
}

/** 可手动控制 resolve 的 Response 承诺（模拟进行中的 snapshot fetch）。 */
function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeSnapshotResponse(): Response {
  return new Response(
    JSON.stringify({ items: [], latest_event_cursor: { sequence: 0, event_id: null } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** 测试夹具：/items 可控挂起、/events 计次，用于观测生命周期开/关连接。 */
function makeHarness() {
  const eventsCalls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const snapshotDeferreds: Array<ReturnType<typeof deferredResponse>> = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/items")) {
      const deferred = deferredResponse();
      snapshotDeferreds.push(deferred);
      return deferred.promise;
    }
    if (url.includes("/events")) {
      // SSE 连接：记录一次连接，流保持打开（不 resolve、不 reject）。
      eventsCalls.push({ url, signal: init?.signal ?? null });
      return new Promise<Response>(() => undefined);
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  return { fetchImpl, eventsCalls, snapshotDeferreds };
}

function event(overrides: Partial<ClientEvent>): ClientEvent {
  return {
    event_id: "event-1",
    sequence: 1,
    schema_version: 1,
    thread_id: "thread-1",
    turn_id: "turn-1",
    item_id: "item-1",
    occurred_at: "2026-07-30T00:00:00.000Z",
    event_type: "item.created",
    payload: {},
    ...overrides,
  };
}

describe("createThreadClient 生命周期（start/stop/resnapshot 幂等与竞态）", () => {
  it("start→stop→start 且第一次 snapshot 未完成时，仅最新生命周期建立一次 SSE", async () => {
    const { fetchImpl, eventsCalls, snapshotDeferreds } = makeHarness();
    const client = createThreadClient({
      threadId: "thread-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Strict Mode：第一次 start 的 snapshot 尚未完成时 stop，再 start。
    const firstStart = client.start();
    client.stop();
    const secondStart = client.start();

    expect(snapshotDeferreds.length).toBe(2);

    // 先解析旧生命周期（第一次 start）的 snapshot —— 不得建立 SSE。
    snapshotDeferreds[0]!.resolve(makeSnapshotResponse());
    await firstStart;
    // 再解析新生命周期（第二次 start）的 snapshot —— 建立唯一 SSE。
    snapshotDeferreds[1]!.resolve(makeSnapshotResponse());
    await secondStart;

    expect(eventsCalls.length).toBe(1);
  });

  it("重叠 resnapshot 时，旧一代完成不得启动或覆盖新一代 SSE", async () => {
    const { fetchImpl, eventsCalls, snapshotDeferreds } = makeHarness();
    const client = createThreadClient({
      threadId: "thread-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // 初次启动建立第一个 SSE。
    const initial = client.start();
    snapshotDeferreds[0]!.resolve(makeSnapshotResponse());
    await initial;
    expect(eventsCalls.length).toBe(1);

    // 两次重叠 resnapshot，snapshot 均保持未完成。
    const resnap1 = client.resnapshot();
    const resnap2 = client.resnapshot();
    expect(snapshotDeferreds.length).toBe(3);

    // 先解析旧一代 resnapshot —— 不得建立新连接。
    snapshotDeferreds[1]!.resolve(makeSnapshotResponse());
    await resnap1;
    // 再解析最新一代 resnapshot —— 建立唯一的新连接。
    snapshotDeferreds[2]!.resolve(makeSnapshotResponse());
    await resnap2;

    // 初始连接 + 最新一代 = 恰好 2 个 events 连接；旧一代不额外启动、不覆盖。
    expect(eventsCalls.length).toBe(2);
  });

  it("stop 使进行中的 snapshot 失效，不建立 SSE", async () => {
    const { fetchImpl, eventsCalls, snapshotDeferreds } = makeHarness();
    const client = createThreadClient({
      threadId: "thread-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const started = client.start();
    client.stop();
    // 旧 snapshot 之后才完成：即使 ok 也不得建立 SSE。
    snapshotDeferreds[0]!.resolve(makeSnapshotResponse());
    await started;

    expect(eventsCalls.length).toBe(0);
  });
});

describe("createThreadClient 摘要 Item resnapshot（防重放循环）", () => {
  it("有效摘要事件只触发一次 resnapshot；新 SSE 重放同一 event_id/sequence 不再 resnapshot 也不创建第三条连接", async () => {
    const harness = makeSseHarness();
    const client = createThreadClient({
      threadId: "thread-1",
      fetchImpl: harness.fetchImpl as unknown as typeof fetch,
    });

    await client.start();
    expect(harness.events.length).toBe(1);

    // 连接 0 推送一条"有效"摘要 Item 事件（新 sequence=1）。
    harness.events[0]!.push("item.created", {
      event_id: "evt-1",
      sequence: 1,
      item_id: "item-1",
      turn_id: "turn-1",
      item_type: "assistant_message",
      content_hash: "sha256:example",
    });
    // 服务端此时已有该 item，cursor 前进到 1（新 SSE 将从 cursor=1 补发）。
    harness.setCursor(1, "evt-1");

    // 有效事件只触发一次 resnapshot → 第二次 /items + 第二条 SSE。
    await vi.waitFor(() => expect(harness.events.length).toBe(2));
    expect(harness.itemsCalls).toBe(2);

    // 新 SSE（连接 1）从 cursor=1 补发同一条 evt-1/seq1（重放）。
    harness.events[1]!.push("item.created", {
      event_id: "evt-1",
      sequence: 1,
      item_id: "item-1",
      turn_id: "turn-1",
      item_type: "assistant_message",
      content_hash: "sha256:example",
    });

    // 给潜在的错误 resnapshot 留出时间；不得再重读 snapshot，也不得创建第三条 SSE。
    await vi.waitFor(() => expect(harness.events[1]).toBeDefined());
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.itemsCalls).toBe(2);
    expect(harness.events.length).toBe(2);
    client.stop();
  });
});

describe("requiresSnapshotRefresh", () => {
  it("Item 事件只有摘要时要求重新读取完整快照", () => {
    expect(
      requiresSnapshotRefresh(
        event({ payload: { item_type: "assistant_message", content_hash: "sha256:example" } }),
      ),
    ).toBe(true);
  });

  it("已携带完整 Item 的事件可直接应用", () => {
    expect(
      requiresSnapshotRefresh(
        event({
          payload: {
            item: {
              id: "item-1",
              turn_id: "turn-1",
              item_sequence: 1,
              item_type: "assistant_message",
              item_state: "completed",
              content: { text: "已完成" },
              created_at: "2026-07-30T00:00:00.000Z",
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("非 Item 事件不触发快照重读", () => {
    expect(requiresSnapshotRefresh(event({ event_type: "turn.queued" }))).toBe(false);
  });
});
