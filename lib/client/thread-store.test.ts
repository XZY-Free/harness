/**
 * S10-W01：createThreadStore 单元测试。
 *
 * 覆盖：
 * - getState 返回当前 immutable 状态。
 * - dispatch 应用 reducer 并通知 listener。
 * - 状态未变化（reducer 返回同引用）时不通知 listener。
 * - subscribe 返回 unsubscribe；取消订阅后不再通知。
 * - 多 listener 各自接收通知。
 */
import { describe, expect, it, vi } from "vitest";
import { createInitialState } from "./thread-reducer";
import { createThreadStore } from "./thread-store";

describe("createThreadStore", () => {
  it("getState 返回初始状态", () => {
    const store = createThreadStore(createInitialState("thread-1"));
    expect(store.getState().threadId).toBe("thread-1");
    expect(store.getState().items).toEqual([]);
  });

  it("dispatch 应用 reducer 并通知 listener", () => {
    const store = createThreadStore(createInitialState("thread-1"));
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatch({ type: "snapshot.loading" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].snapshotStatus).toBe("loading");
  });

  it("reducer 返回同引用时不通知 listener", () => {
    const store = createThreadStore(createInitialState("thread-1"));
    const listener = vi.fn();
    store.subscribe(listener);

    // stream.resumed 不改变状态（reducer 返回同引用）
    store.dispatch({
      type: "event.received",
      event: {
        event_id: "x",
        sequence: 999,
        schema_version: 1,
        thread_id: "thread-1",
        turn_id: null,
        item_id: null,
        occurred_at: "2026-07-21T00:00:00.000Z",
        payload: {},
        event_type: "stream.resumed",
      },
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe 后不再接收通知", () => {
    const store = createThreadStore(createInitialState("thread-1"));
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.dispatch({ type: "snapshot.loading" });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.dispatch({
      type: "snapshot.loaded",
      items: [],
      latestEventCursor: null,
    });
    expect(listener).toHaveBeenCalledTimes(1); // 不再增加
  });

  it("多 listener 各自接收通知", () => {
    const store = createThreadStore(createInitialState("thread-1"));
    const l1 = vi.fn();
    const l2 = vi.fn();
    store.subscribe(l1);
    store.subscribe(l2);

    store.dispatch({ type: "snapshot.loading" });
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });
});
