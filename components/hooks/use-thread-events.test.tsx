import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 12-P1-3：useThreadEvents hook 测试。
 *
 * 验证：
 * - 建立 EventSource 订阅 ?threadId=xxx
 * - onmessage 解析 kind=status / kind=event 信封，调对应回调
 * - onerror 启动降级轮询，onopen 重连后停轮询
 * - 卸载时关闭 EventSource + 清轮询
 */

// EventSource mock
const esInstances: MockEventSource[] = [];
class MockEventSource {
  url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    esInstances.push(this);
  }
  close() {
    this.closed = true;
  }
}

vi.stubGlobal("EventSource", MockEventSource);

import { useThreadEvents } from "./use-thread-events";

beforeEach(() => {
  esInstances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useThreadEvents", () => {
  it("建立 EventSource 订阅 ?threadId=xxx", () => {
    renderHook(() => useThreadEvents({ threadId: "t1", onEvent: vi.fn(), onStatus: vi.fn() }));
    expect(esInstances).toHaveLength(1);
    expect(esInstances[0]?.url).toContain("threadId=t1");
  });

  it("kind=status 信封调 onStatus 回调", () => {
    const onStatus = vi.fn();
    renderHook(() => useThreadEvents({ threadId: "t1", onStatus }));
    const es = esInstances[0];
    if (!es) throw new Error("es not created");
    act(() => {
      es.onmessage?.({
        data: JSON.stringify({ kind: "status", threadId: "t1", status: "running" }),
      });
    });
    expect(onStatus).toHaveBeenCalledWith({ status: "running" });
  });

  it("kind=event 信封调 onEvent 回调（含 type/payload/sequence）", () => {
    const onEvent = vi.fn();
    renderHook(() => useThreadEvents({ threadId: "t1", onEvent }));
    const es = esInstances[0];
    if (!es) throw new Error("es not created");
    act(() => {
      es.onmessage?.({
        data: JSON.stringify({
          kind: "event",
          threadId: "t1",
          type: "subagent.spawned",
          payload: { runId: "sa1" },
          sequence: 3,
        }),
      });
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "subagent.spawned",
      payload: { runId: "sa1" },
      sequence: 3,
    });
  });

  it("非 JSON / 无 kind 数据静默忽略", () => {
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    renderHook(() => useThreadEvents({ threadId: "t1", onEvent, onStatus }));
    const es = esInstances[0];
    if (!es) throw new Error("es not created");
    act(() => {
      es.onmessage?.({ data: "not json" });
      es.onmessage?.({ data: JSON.stringify({ foo: "bar" }) });
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("onerror 启动降级轮询，onopen 重连后停轮询", () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    renderHook(() => useThreadEvents({ threadId: "t1", onEvent, fallbackPollMs: 1000 }));
    const es = esInstances[0];
    if (!es) throw new Error("es not created");
    // 触发断线
    act(() => {
      es.onerror?.();
    });
    // 推进 1s，降级轮询应触发 onEvent（type=__fallback__）
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "__fallback__" }));
    // 重连成功
    act(() => {
      es.onopen?.();
    });
    const callCountBefore = onEvent.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // 重连后不再有降级轮询调用
    expect(onEvent.mock.calls.length).toBe(callCountBefore);
  });

  it("卸载时关闭 EventSource", () => {
    const { unmount } = renderHook(() => useThreadEvents({ threadId: "t1", onEvent: vi.fn() }));
    const es = esInstances[0];
    if (!es) throw new Error("es not created");
    expect(es.closed).toBe(false);
    unmount();
    expect(es.closed).toBe(true);
  });

  it("threadId 变化时重建 EventSource", () => {
    const { rerender } = renderHook(
      ({ threadId }: { threadId: string }) => useThreadEvents({ threadId, onEvent: vi.fn() }),
      { initialProps: { threadId: "t1" } },
    );
    expect(esInstances).toHaveLength(1);
    rerender({ threadId: "t2" });
    expect(esInstances).toHaveLength(2);
    expect(esInstances[0]?.closed).toBe(true);
    expect(esInstances[1]?.url).toContain("threadId=t2");
  });
});
