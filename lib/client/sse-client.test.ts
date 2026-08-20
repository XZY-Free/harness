import { describe, expect, it, vi } from "vitest";
import { createSSEClient } from "./sse-client";

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

/** 刷新若干轮微任务，让 async connect 链落地。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function makeCallbacks(overrides: Partial<Parameters<typeof createSSEClient>[1]> = {}) {
  return {
    onOpen: vi.fn(),
    onEvent: vi.fn(),
    onTransient: vi.fn(),
    onReconnecting: vi.fn(),
    onCursorExpired: vi.fn(),
    onFailed: vi.fn(),
    ...overrides,
  };
}

describe("createSSEClient transient events", () => {
  it("解析没有持久 id 的 response.delta", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              "event: response.delta",
              'data: {"transient_id":"delta-1","thread_id":"thread-1","turn_id":"turn-1","occurred_at":"2026-07-21T00:00:00.000Z","payload":{"delta":"你好"}}',
              "",
              "",
            ].join("\n"),
          ),
        );
      },
    });
    const onTransient = vi.fn();
    const handle = createSSEClient(
      {
        threadId: "thread-1",
        getLastEventId: () => null,
        fetchImpl: vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
      },
      {
        onOpen: vi.fn(),
        onEvent: vi.fn(),
        onTransient,
        onReconnecting: vi.fn(),
        onCursorExpired: vi.fn(),
        onFailed: vi.fn(),
      },
    );

    handle.start();
    await vi.waitFor(() => {
      expect(onTransient).toHaveBeenCalledWith({
        transient_id: "delta-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        occurred_at: "2026-07-21T00:00:00.000Z",
        delta: "你好",
      });
    });
    handle.close();
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
