import { describe, expect, it, vi } from "vitest";
import { createSSEClient } from "./sse-client";
import { createInitialState } from "./thread-reducer";
import { createThreadStore } from "./thread-store";

/** 立即结束的 SSE 响应体：发出少量数据后立刻 close。 */
function immediateBody(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: ping\n\n"));
      controller.close();
    },
  });
}

/** 可控响应体：返回 body 和一个能手动 close 的句柄（模拟长连接）。 */
function controllableBody(): {
  body: ReadableStream<Uint8Array>;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { body, close: () => controller.close() };
}

/** 可控响应体（可多次 push）：用于"写一批消息后保持连接打开"的场景。 */
function pushableBody(): {
  body: ReadableStream<Uint8Array>;
  push: (chunk: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    body,
    push: (chunk) => controller.enqueue(encoder.encode(chunk)),
    close: () => controller.close(),
  };
}

/** 由若干 SSE 消息（原始文本块）构成的响应体，写完即结束。 */
function bodyFromChunks(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** 一条 `response.delta` 的原始 SSE 文本（data 由调用方给出）。 */
function deltaChunk(data: Record<string, unknown>): string {
  return `event: response.delta\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 一条 `stream.generation` 的原始 SSE 文本。 */
function generationChunk(data: Record<string, unknown>): string {
  return `event: stream.generation\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 刷新若干轮微任务，让 async connect 链落地。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function makeCallbacks(overrides: Partial<Parameters<typeof createSSEClient>[1]> = {}) {
  return {
    onOpen: vi.fn(),
    onEvent: vi.fn(),
    onTransient: vi.fn(),
    onGeneration: vi.fn(),
    onTransientRejected: vi.fn(),
    onReconnecting: vi.fn(),
    onCursorExpired: vi.fn(),
    onFailed: vi.fn(),
    ...overrides,
  };
}

/** 一个合法代际（线上 snake_case 形态）。 */
const GENERATION_WIRE = {
  invocation_id: "invocation-1",
  attempt_id: "attempt-1",
  ownership_id: "ownership-1",
  lease_epoch: "9007199254740993",
};

describe("createSSEClient transient events — A11 代际贯穿", () => {
  it("A11-T01：真实 SSE 字节流 → parser → store → reducer 保留完整 tuple 并显示正文", async () => {
    const store = createThreadStore(createInitialState("thread-1"));
    // 真实客户端链：parser 回调直接进入真实 store/reducer。
    const handle = createSSEClient(
      {
        threadId: "thread-1",
        getLastEventId: () => null,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            bodyFromChunks([
              generationChunk({
                thread_id: "thread-1",
                baseline_sequence: 3,
                issued_revision: 1,
                generations: [{ turn_id: "turn-1", generation: GENERATION_WIRE }],
              }),
              deltaChunk({
                transient_id: "delta-1",
                thread_id: "thread-1",
                turn_id: "turn-1",
                generation: GENERATION_WIRE,
                occurred_at: "2026-07-21T00:00:00.000Z",
                payload: { delta: "你好" },
              }),
            ]),
            { status: 200 },
          ),
        ),
      },
      makeCallbacks({
        onGeneration: (baseline) => store.dispatch({ type: "stream.generation", baseline }),
        onTransient: (event) => store.dispatch({ type: "stream.delta", event }),
      }),
    );

    handle.start();
    await vi.waitFor(() => {
      expect(store.getState().items).toHaveLength(1);
    });
    handle.close();

    const state = store.getState();
    // 基线进入状态（控制消息，不推进持久游标）。
    expect(state.generationBaseline?.generations[0]?.generation).toEqual(GENERATION_WIRE);
    expect(state.lastAppliedEventSequence).toBe(0);

    const item = state.items[0];
    expect(item?.item_state).toBe("pending");
    expect(item?.item_type).toBe("assistant_message");
    // 正文显示出来，且临时 Item 携带**完整**代际（invocation/attempt/ownership/epoch）。
    expect((item?.content as { text: string }).text).toBe("你好");
    expect((item?.content as { generation: unknown }).generation).toEqual(GENERATION_WIRE);
    // 临时 Item key 含完整 tuple，不再只有 turn_id。
    expect(item?.id).toContain("invocation-1");
    expect(item?.id).toContain("ownership-1");
    expect(item?.id).toContain("9007199254740993");
    expect(item?.id).not.toBe("stream-turn-1");
  });

  it("A11-T05：缺失/畸形代际不构造可拼接 delta，触发有界刷新且不摧毁读循环", async () => {
    const onTransient = vi.fn();
    const onTransientRejected = vi.fn();
    const onReconnecting = vi.fn();
    const bad = [
      // 完全缺 generation。
      {
        transient_id: "d-missing",
        thread_id: "thread-1",
        turn_id: "turn-1",
        payload: { delta: "缺代际" },
      },
      // generation 存在但缺 invocation_id。
      {
        transient_id: "d-no-invocation",
        thread_id: "thread-1",
        turn_id: "turn-1",
        generation: { attempt_id: "a", ownership_id: "o", lease_epoch: "1" },
        payload: { delta: "缺 Invocation" },
      },
      // epoch 非十进制（科学计数法）。
      {
        transient_id: "d-sci-epoch",
        thread_id: "thread-1",
        turn_id: "turn-1",
        generation: { ...GENERATION_WIRE, lease_epoch: "1e3" },
        payload: { delta: "非法 epoch" },
      },
      // epoch 为空白字符串。
      {
        transient_id: "d-blank-epoch",
        thread_id: "thread-1",
        turn_id: "turn-1",
        generation: { ...GENERATION_WIRE, lease_epoch: " " },
        payload: { delta: "空白 epoch" },
      },
      // generation 根本不是对象。
      {
        transient_id: "d-non-object",
        thread_id: "thread-1",
        turn_id: "turn-1",
        generation: "invocation-1",
        payload: { delta: "非对象" },
      },
    ];

    // 连接保持打开：畸形消息本身不得引发重连（自然结束引发的重连不在此断言范围）。
    const stream = pushableBody();
    const handle = createSSEClient(
      {
        threadId: "thread-1",
        getLastEventId: () => null,
        fetchImpl: vi.fn().mockResolvedValue(new Response(stream.body, { status: 200 })),
      },
      makeCallbacks({ onTransient, onTransientRejected, onReconnecting }),
    );

    handle.start();
    await flush();
    for (const data of bad) stream.push(deltaChunk(data));
    // 最后一条合法：证明读循环没有被畸形消息摧毁（不是抛异常/提前断开）。
    stream.push(
      deltaChunk({
        transient_id: "d-ok",
        thread_id: "thread-1",
        turn_id: "turn-1",
        generation: GENERATION_WIRE,
        payload: { delta: "合法" },
      }),
    );

    await vi.waitFor(() => {
      expect(onTransient).toHaveBeenCalledTimes(1);
    });
    expect(onReconnecting).not.toHaveBeenCalled();
    handle.close();
    stream.close();

    // 畸形消息既不构造 delta，也不被静默忽略：每条都请求一次有界权威刷新。
    expect(onTransientRejected).toHaveBeenCalledTimes(bad.length);
    expect(onTransient).toHaveBeenCalledTimes(1);
    expect(onTransient.mock.calls[0]?.[0]).toMatchObject({
      transient_id: "d-ok",
      generation: GENERATION_WIRE,
    });
    // 畸形代际本身不得引发重连（有界刷新由消费侧做，不是"每坏一条就重连"）。
    expect(onReconnecting).not.toHaveBeenCalled();
  });

  it("A11-T07：超大 epoch 按十进制字符串原样保留，Number 会合并的相邻值仍可区分", async () => {
    const onTransient = vi.fn();
    // 2^53 = 9007199254740992：Number 无法区分它与 9007199254740993。
    const big = "9007199254740993";
    const adjacent = "9007199254740992";
    // 负向对照：Number 路径确实会合并这两个 epoch —— 所以"转 Number 再比较"必然失败。
    expect(Number(big)).toBe(Number(adjacent));
    expect(big).not.toBe(adjacent);

    const handle = createSSEClient(
      {
        threadId: "thread-1",
        getLastEventId: () => null,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            bodyFromChunks([
              // 逆序送达：先大后小。
              deltaChunk({
                transient_id: "d-big",
                thread_id: "thread-1",
                turn_id: "turn-1",
                generation: { ...GENERATION_WIRE, lease_epoch: big },
                payload: { delta: "大" },
              }),
              deltaChunk({
                transient_id: "d-adjacent",
                thread_id: "thread-1",
                turn_id: "turn-1",
                generation: { ...GENERATION_WIRE, lease_epoch: adjacent },
                payload: { delta: "小" },
              }),
            ]),
            { status: 200 },
          ),
        ),
      },
      makeCallbacks({ onTransient }),
    );

    handle.start();
    await vi.waitFor(() => {
      expect(onTransient).toHaveBeenCalledTimes(2);
    });
    handle.close();

    const epochs = onTransient.mock.calls.map(
      (call) => (call[0] as { generation: { lease_epoch: string } }).generation.lease_epoch,
    );
    // 精度零损失：两个相邻 epoch 仍是两个可区分的字符串。
    expect(epochs).toEqual([big, adjacent]);
    expect(new Set(epochs).size).toBe(2);
  });
});

describe("createSSEClient retry budget", () => {
  it("连续立即结束的 200 SSE 流不能无限重连：受 maxRetries 限制并最终只失败一次", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(immediateBody(), { status: 200 }));
      const callbacks = makeCallbacks();
      const handle = createSSEClient(
        {
          threadId: "thread-1",
          getLastEventId: () => null,
          fetchImpl,
          maxRetries: 3,
          baseBackoffMs: 100,
          // 稳定阈值远超测试退避：连续立即结束的连接永远到不了“健康”，预算不应被清零。
          healthyResetMs: 60_000,
        },
        callbacks,
      );

      handle.start();
      // 退避序列：100ms / 200ms / 400ms
      for (const ms of [100, 200, 400]) {
        await vi.advanceTimersByTimeAsync(ms);
        await flush();
      }

      // 3 次重连尝试（attempt 1/2/3）后，第 4 次 connect 发现已用尽预算 → onFailed 一次。
      expect(callbacks.onReconnecting).toHaveBeenCalledTimes(3);
      expect(callbacks.onFailed).toHaveBeenCalledTimes(1);
      // fetch 调用 = 初始 1 + 重试 3 = 4 次。
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("连接超过健康阈值后重试预算被重置，下次断线从第 1 次重连开始", async () => {
    vi.useFakeTimers();
    try {
      const long = controllableBody();
      let callCount = 0;
      const fetchImpl = vi.fn().mockImplementation(() => {
        callCount += 1;
        // 第 3 次 connect 是长连接（模拟稳定连接）。
        if (callCount === 3) return Promise.resolve(new Response(long.body, { status: 200 }));
        return Promise.resolve(new Response(immediateBody(), { status: 200 }));
      });
      const callbacks = makeCallbacks();
      const handle = createSSEClient(
        {
          threadId: "thread-1",
          getLastEventId: () => null,
          fetchImpl,
          maxRetries: 3,
          baseBackoffMs: 100,
          healthyResetMs: 50,
        },
        callbacks,
      );

      // attempts() = 每次 onReconnecting 的 attempt 参数序列。
      const attempts = () =>
        (callbacks.onReconnecting as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

      handle.start();
      await flush();
      // 初始 connect 立即结束 → attempt 1。
      expect(attempts()).toEqual([1]);

      await vi.advanceTimersByTimeAsync(100);
      await flush();
      // 第二次立即结束 → attempt 2（预算尚未被健康计时器清零）。
      expect(attempts()).toEqual([1, 2]);

      // 第 3 次 connect 进入长连接（模拟稳定连接）。
      await vi.advanceTimersByTimeAsync(200);
      await flush();
      expect(fetchImpl).toHaveBeenCalledTimes(3);

      // 连接保持超过健康阈值 50ms → 预算被重置为 0。
      await vi.advanceTimersByTimeAsync(60);
      await flush();

      long.close();
      await flush();
      // 稳定连接结束后断线：从重置后的 attempt 1 重新计数（若预算未重置会是 attempt 3）。
      expect(attempts()).toEqual([1, 2, 1]);
      handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("close 清理健康/重试定时器，不再发起请求", async () => {
    vi.useFakeTimers();
    try {
      const long = controllableBody();
      const fetchImpl = vi.fn().mockResolvedValue(new Response(long.body, { status: 200 }));
      const callbacks = makeCallbacks();
      const handle = createSSEClient(
        {
          threadId: "thread-1",
          getLastEventId: () => null,
          fetchImpl,
          maxRetries: 5,
          baseBackoffMs: 100,
          healthyResetMs: 50,
        },
        callbacks,
      );

      handle.start();
      await flush();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // 连接打开期间调用 close（同时存在健康定时器与可能的重试定时器）。
      handle.close();

      const callsAfterClose = fetchImpl.mock.calls.length;
      // 若定时器未被清理，runAllTimersAsync 会再次触发请求。
      await vi.runAllTimersAsync();
      await flush();
      expect(fetchImpl).toHaveBeenCalledTimes(callsAfterClose);
      expect(callbacks.onFailed).not.toHaveBeenCalled();
      expect(callbacks.onReconnecting).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
