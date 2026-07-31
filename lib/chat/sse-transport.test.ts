import type { UIMessageChunk } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SseChatTransport } from "./sse-transport";

/**
 * V4 Phase B-4 + V7 S5-3：SseChatTransport 断连重连 + sequence 续传单测。
 *
 * mock fetch：POST 返回 {ok,data:{runId}}，GET 返回 SSE 字节流（模拟 RunBroadcaster）。
 * 退避注入 [1,1,1]（真实 timers，1ms 瞬间完成），避免 fake timers 与 ReadableStream
 * 多级 pipeThrough 微任务链的交互问题。
 * 验证：正常完成不重连 / 网络断重连去重续传 / abort 不重连 / 连续连接失败报 failed。
 *
 * V7 S5-3：后端 SSE data 格式为 `{ sequence, chunk }`。为验证 sequence 去重，
 * 重连场景使用 SEQ_TEXT / SEQ_ARTIFACT 包装 sequence；旧格式（纯 chunk）仍通过
 * openChunkStream 的兼容性分支解析。
 *
 * S1 修复（预存在 flaky）：真实 timers + ReadableStream 多级 pipeThrough 微任务链对事件循环
 * 延迟敏感，全量套件并发负载下偶发超 5s 默认超时。提高本文件 testTimeout 至 20s 给微任务链
 * 足够调度余量，消除负载相关 flaky（单跑已稳定）。
 */
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const TEXT = (id: string, delta: string): UIMessageChunk =>
  ({ type: "text-delta", id, delta }) as UIMessageChunk;
const ARTIFACT = (status: string): UIMessageChunk =>
  ({ type: "data-artifact", data: { status, previewUrl: "" } }) as UIMessageChunk;

/** V7 S5-3：带 sequence 的 SSE data 包装。 */
const SEQ_TEXT = (id: string, delta: string, sequence: number) => ({
  sequence,
  chunk: TEXT(id, delta),
});
const SEQ_ARTIFACT = (status: string, sequence: number) => ({
  sequence,
  chunk: ARTIFACT(status),
});

/** 构造 SSE 字节流：每个 chunk 编码为 `data: {json}\n\n`，发完 close。 */
function sseBody(chunks: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(ctl) {
      const enc = new TextEncoder();
      for (const c of chunks) ctl.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      ctl.close();
    },
  });
}

function sseResponse(body: ReadableStream<Uint8Array> | null, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function postOk(runId = "r1"): Response {
  return new Response(JSON.stringify({ ok: true, data: { runId } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function consume(stream: ReadableStream): Promise<unknown[]> {
  const reader = stream.getReader();
  const out: unknown[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

const sendOpts = (abortSignal?: AbortSignal) =>
  ({
    trigger: "submit-message",
    chatId: "t1",
    messageId: undefined,
    messages: [],
    abortSignal,
  }) as never;

const FAST_BACKOFF = { backoffMs: [1, 1, 1] };

describe("SseChatTransport B-4 断连重连", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("正常完成：转发所有 chunk，不重连", async () => {
    const reconnect = vi.fn();
    let getCalls = 0;
    const fetchFn = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") return postOk();
      getCalls++;
      return sseResponse(sseBody([TEXT("m1", "hi"), ARTIFACT("idle")]));
    });
    const transport = new SseChatTransport({
      fetch: fetchFn,
      onReconnectStateChange: reconnect,
      ...FAST_BACKOFF,
    });
    const stream = await transport.sendMessages(sendOpts());
    const out = await consume(stream);

    expect(getCalls).toBe(1);
    expect(out).toHaveLength(2);
    expect((out[0] as { type: string }).type).toBe("text-delta");
    expect((out[1] as { type: string }).type).toBe("data-artifact");
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("网络断开 → 重连去重续传（历史 chunk 不重复）", async () => {
    const reconnect = vi.fn();
    let getCalls = 0;
    const fetchFn = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") return postOk();
      getCalls++;
      if (getCalls === 1) {
        // 首次：发 1 个 chunk 后断（无 data-artifact，模拟网络中断）
        return sseResponse(sseBody([SEQ_TEXT("m1", "hi", 1)]));
      }
      // 重连：broadcaster 回放历史（chunk1）+ 断连期间新产出（chunk2）+ 终止信号
      return sseResponse(
        sseBody([SEQ_TEXT("m1", "hi", 1), SEQ_TEXT("m1", " world", 2), SEQ_ARTIFACT("idle", 3)]),
      );
    });
    const transport = new SseChatTransport({
      fetch: fetchFn,
      onReconnectStateChange: reconnect,
      ...FAST_BACKOFF,
    });
    const stream = await transport.sendMessages(sendOpts());
    const out = await consume(stream);

    expect(getCalls).toBe(2);
    // chunk1 去重只出现一次，chunk2 + artifact 续传
    expect(out).toHaveLength(3);
    expect((out[0] as { delta: string }).delta).toBe("hi");
    expect((out[1] as { delta: string }).delta).toBe(" world");
    expect((out[2] as { type: string }).type).toBe("data-artifact");
    expect(reconnect).toHaveBeenCalledWith("reconnecting");
    expect(reconnect).toHaveBeenCalledWith("idle");
  });

  it("abortSignal 触发（用户停止）→ 不重连", async () => {
    const reconnect = vi.fn();
    const ac = new AbortController();
    let getCalls = 0;
    const fetchFn = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") return postOk();
      getCalls++;
      const sig = init?.signal as AbortSignal | undefined;
      // 发 1 个 chunk 后保持流开启（模拟长任务），abort 时 error 流（模拟真实 fetch 响应 abort）
      return sseResponse(
        new ReadableStream<Uint8Array>({
          start(ctl) {
            ctl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(TEXT("m1", "hi"))}\n\n`));
            sig?.addEventListener("abort", () => {
              try {
                ctl.error(new Error("aborted"));
              } catch {
                // 已关闭，忽略
              }
            });
          },
        }),
      );
    });
    const transport = new SseChatTransport({
      fetch: fetchFn,
      onReconnectStateChange: reconnect,
      ...FAST_BACKOFF,
    });
    const stream = await transport.sendMessages(sendOpts(ac.signal));
    const consumeP = consume(stream);
    // 让首个 chunk 入队并被消费（负载下需稍长等待，确保 abort 前已转发）
    await new Promise((r) => setTimeout(r, 50));
    ac.abort(); // 用户点停止
    const out = await consumeP;
    // 再等一会确认无重连
    await new Promise((r) => setTimeout(r, 50));

    expect(getCalls).toBe(1);
    expect(reconnect).not.toHaveBeenCalledWith("reconnecting");
    expect(reconnect).not.toHaveBeenCalledWith("failed");
    expect(out).toHaveLength(1);
  });

  it("连续连接失败 → onReconnectStateChange('failed')", async () => {
    const reconnect = vi.fn();
    const fetchFn = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") return postOk();
      // GET 始终 502，openChunkStream 抛错
      return sseResponse(null, 502);
    });
    const transport = new SseChatTransport({
      fetch: fetchFn,
      onReconnectStateChange: reconnect,
      ...FAST_BACKOFF,
    });
    const stream = await transport.sendMessages(sendOpts());
    const out = await consume(stream);

    expect(out).toHaveLength(0);
    expect(reconnect).toHaveBeenCalledWith("reconnecting");
    expect(reconnect).toHaveBeenCalledWith("failed");
  });

  it("reconnectToStream：无活跃 run 时返回 null（接口契约）", async () => {
    const fetchFn = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") return postOk();
      return sseResponse(sseBody([ARTIFACT("idle")]));
    });
    const transport = new SseChatTransport({ fetch: fetchFn, ...FAST_BACKOFF });
    // 未 sendMessages 过 → 无 lastRunId → null
    const r0 = await transport.reconnectToStream({ chatId: "t1" });
    expect(r0).toBeNull();
  });
});

describe("V6-M3-6（A5）onSendSuccess 回调", () => {
  it("POST 成功 → onSendSuccess 被调用", async () => {
    const onSendSuccess = vi.fn();
    const fetchFn = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") return postOk();
      return sseResponse(sseBody([ARTIFACT("idle")]));
    });
    const transport = new SseChatTransport({ fetch: fetchFn, onSendSuccess, ...FAST_BACKOFF });
    await transport.sendMessages(sendOpts());
    expect(onSendSuccess).toHaveBeenCalledTimes(1);
  });

  it("POST 失败 → onSendSuccess 不被调用（replaceFromRef 保留供重试）", async () => {
    const onSendSuccess = vi.fn();
    const fetchFn = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ ok: false, error: "server error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return sseResponse(sseBody([ARTIFACT("idle")]));
    });
    const transport = new SseChatTransport({ fetch: fetchFn, onSendSuccess, ...FAST_BACKOFF });
    await expect(transport.sendMessages(sendOpts())).rejects.toThrow();
    expect(onSendSuccess).not.toHaveBeenCalled();
  });
});

describe("V7 S3-2: setTargetRun 预设 runId", () => {
  it("setTargetRun 后 reconnectToStream 可命中指定 runId", async () => {
    const fetchFn = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") return postOk();
      return sseResponse(sseBody([ARTIFACT("idle")]));
    });
    const transport = new SseChatTransport({ fetch: fetchFn, ...FAST_BACKOFF });
    // 未 sendMessages 过，但通过 setTargetRun 预设
    transport.setTargetRun("t-target", "run-target");
    const stream = await transport.reconnectToStream({ chatId: "t-target" });
    expect(stream).not.toBeNull();
    // 验证 fetch 被调用且 URL 包含正确的 threadId 和 runId
    expect(fetchFn).toHaveBeenCalled();
    const callUrl = String(fetchFn.mock.calls[0]?.[0] ?? "");
    expect(callUrl).toContain("t-target");
    expect(callUrl).toContain("run-target");
  });

  it("setTargetRun 后 chatId 不匹配 → reconnectToStream 返回 null", async () => {
    const fetchFn = vi.fn(async () => sseResponse(sseBody([])));
    const transport = new SseChatTransport({ fetch: fetchFn, ...FAST_BACKOFF });
    transport.setTargetRun("t-a", "run-a");
    const stream = await transport.reconnectToStream({ chatId: "t-b" });
    expect(stream).toBeNull();
  });
});
