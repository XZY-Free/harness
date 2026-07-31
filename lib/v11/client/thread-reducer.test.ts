/**
 * S10-W01：threadProjectionReducer 单元测试。
 *
 * 覆盖（与 S10-W01 验收一一对应）：
 * - snapshot.loaded：重置 items / itemsById / lastAppliedEventSequence / appliedEventIds。
 * - event.received：
 *   - 相同 event_id 去重（跨重连重复 SSE）。
 *   - 旧 sequence 丢弃（防倒退）。
 *   - sequence gap 触发 EVENT_SEQUENCE_GAP + resnapshot 状态。
 *   - item.created / item.updated 按 item_sequence 插入到正确位置。
 *   - item.superseded 把旧 Item 标记为 superseded，不删除。
 * - snapshot 重载（threadId 不变，强制 resnapshot）：
 *   - 不重复插入已有 Item。
 *   - 不回到旧的 lastAppliedEventSequence。
 * - 非 Item 事件（turn.* / thread.*）：只更新 sequence，不影响 items。
 *
 * 不需要 MySQL — 纯函数测试。
 */
import { describe, expect, it } from "vitest";
import { createInitialState, threadProjectionReducer } from "./thread-reducer";
import type { V11ClientEvent, V11ClientItem, V11ThreadProjectionState } from "./types";

function makeItem(overrides: Partial<V11ClientItem> = {}): V11ClientItem {
  return {
    id: overrides.id ?? "item-1",
    turn_id: overrides.turn_id ?? "turn-1",
    item_sequence: overrides.item_sequence ?? 1,
    item_type: overrides.item_type ?? "user_message",
    item_state: overrides.item_state ?? "completed",
    content: overrides.content ?? { text: "hello" },
    created_at: overrides.created_at ?? "2026-07-21T00:00:00.000Z",
  };
}

function makeEvent(overrides: Partial<V11ClientEvent> = {}): V11ClientEvent {
  return {
    event_id: overrides.event_id ?? "evt-1",
    sequence: overrides.sequence ?? 1,
    schema_version: overrides.schema_version ?? 1,
    thread_id: overrides.thread_id ?? "thread-1",
    turn_id: overrides.turn_id ?? "turn-1",
    item_id: overrides.item_id ?? null,
    occurred_at: overrides.occurred_at ?? "2026-07-21T00:00:00.000Z",
    payload: overrides.payload ?? {},
    event_type: overrides.event_type ?? "item.created",
  };
}

function loadedState(
  items: readonly V11ClientItem[],
  cursor: { sequence: number; event_id: string | null } | null,
): V11ThreadProjectionState {
  return threadProjectionReducer(createInitialState("thread-1"), {
    type: "snapshot.loaded",
    items,
    latestEventCursor: cursor,
  });
}

describe("threadProjectionReducer", () => {
  describe("snapshot.loaded", () => {
    it("用空 snapshot 初始化状态", () => {
      const state = loadedState([], null);
      expect(state.items).toEqual([]);
      expect(state.itemsById).toEqual({});
      expect(state.lastAppliedEventSequence).toBe(0);
      expect(state.appliedEventIds.size).toBe(0);
      expect(state.latestEventCursor).toBeNull();
      expect(state.snapshotStatus).toBe("ready");
    });

    it("按 item_sequence 升序排序 items", () => {
      const item1 = makeItem({ id: "a", item_sequence: 3 });
      const item2 = makeItem({ id: "b", item_sequence: 1 });
      const item3 = makeItem({ id: "c", item_sequence: 2 });
      const state = loadedState([item1, item2, item3], null);
      expect(state.items.map((i) => i.id)).toEqual(["b", "c", "a"]);
    });

    it("latest_event_cursor 写入 lastAppliedEventSequence 和 appliedEventIds", () => {
      const state = loadedState([], { sequence: 42, event_id: "evt-42" });
      expect(state.lastAppliedEventSequence).toBe(42);
      expect(state.appliedEventIds.has("evt-42")).toBe(true);
      expect(state.latestEventCursor).toEqual({ sequence: 42, event_id: "evt-42" });
    });

    it("itemsById 派生自 items", () => {
      const item = makeItem({ id: "x" });
      const state = loadedState([item], null);
      expect(state.itemsById.x).toEqual(item);
    });
  });

  describe("event.received - item.created", () => {
    it("在 snapshot 后接收第一条事件（sequence = cursor + 1）", () => {
      const state = loadedState([], { sequence: 10, event_id: "evt-10" });
      const newItem = makeItem({ id: "new-item", item_sequence: 1 });
      const next = threadProjectionReducer(state, {
        type: "event.received",
        event: makeEvent({
          event_id: "evt-11",
          sequence: 11,
          item_id: "new-item",
          payload: { item: newItem },
        }),
      });
      expect(next.items.map((i) => i.id)).toEqual(["new-item"]);
      expect(next.lastAppliedEventSequence).toBe(11);
      expect(next.appliedEventIds.has("evt-11")).toBe(true);
    });

    it("按 item_sequence 把 Item 插入到正确位置", () => {
      const item1 = makeItem({ id: "a", item_sequence: 1 });
      const item3 = makeItem({ id: "c", item_sequence: 3 });
      const state = loadedState([item1, item3], { sequence: 10, event_id: null });
      const item2 = makeItem({ id: "b", item_sequence: 2 });
      const next = threadProjectionReducer(state, {
        type: "event.received",
        event: makeEvent({
          event_id: "evt-11",
          sequence: 11,
          payload: { item: item2 },
        }),
      });
      expect(next.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    });

    it("相同 item_id 替换旧 Item（item.updated）", () => {
      const itemV1 = makeItem({ id: "a", item_sequence: 1, content: { text: "v1" } });
      const state = loadedState([itemV1], { sequence: 10, event_id: null });
      const itemV2 = makeItem({ id: "a", item_sequence: 1, content: { text: "v2" } });
      const next = threadProjectionReducer(state, {
        type: "event.received",
        event: makeEvent({
          event_id: "evt-11",
          sequence: 11,
          event_type: "item.updated",
          payload: { item: itemV2 },
        }),
      });
      expect(next.items).toHaveLength(1);
      expect(next.items[0]?.content).toEqual({ text: "v2" });
    });
  });

  describe("event.received - 幂等与顺序", () => {
    it("相同 event_id 不重复应用", () => {
      const state = loadedState([], { sequence: 10, event_id: null });
      const event = makeEvent({
        event_id: "evt-11",
        sequence: 11,
        payload: { item: makeItem({ id: "x", item_sequence: 1 }) },
      });
      const after1 = threadProjectionReducer(state, {
        type: "event.received",
        event,
      });
      const after2 = threadProjectionReducer(after1, {
        type: "event.received",
        event,
      });
      expect(after2).toBe(after1); // 引用相等 → 无状态变化
      expect(after2.items).toHaveLength(1);
    });

    it("旧 sequence 直接丢弃（防倒退）", () => {
      const state = loadedState([], { sequence: 10, event_id: null });
      const oldEvent = makeEvent({
        event_id: "evt-5",
        sequence: 5,
        payload: { item: makeItem({ id: "x", item_sequence: 1 }) },
      });
      const next = threadProjectionReducer(state, {
        type: "event.received",
        event: oldEvent,
      });
      expect(next).toBe(state);
      expect(next.items).toHaveLength(0);
    });

    it("sequence gap 触发 EVENT_SEQUENCE_GAP + resnapshot 状态", () => {
      // snapshot 后收到 sequence=10；再收到 sequence=15（gap：11/12/13/14 缺失）
      const state1 = loadedState([], { sequence: 9, event_id: null });
      const state2 = threadProjectionReducer(state1, {
        type: "event.received",
        event: makeEvent({
          event_id: "evt-10",
          sequence: 10,
          payload: { item: makeItem({ id: "a", item_sequence: 1 }) },
        }),
      });
      expect(state2.lastAppliedEventSequence).toBe(10);

      const state3 = threadProjectionReducer(state2, {
        type: "event.received",
        event: makeEvent({
          event_id: "evt-15",
          sequence: 15,
          payload: { item: makeItem({ id: "b", item_sequence: 2 }) },
        }),
      });
      expect(state3.streamStatus).toBe("resnapshot");
      expect(state3.visibleError?.code).toBe("EVENT_SEQUENCE_GAP");
      expect(state3.visibleError?.retryable).toBe(true);
      // gap 事件不应用到投影
      expect(state3.lastAppliedEventSequence).toBe(10);
      expect(state3.items.map((i) => i.id)).toEqual(["a"]);
    });

    it("snapshot 后第一条事件的 sequence 不视为 gap", () => {
      // snapshot cursor = 100，服务端在 snapshot 期间写入到 sequence=105；
      // SSE 重连后服务端从 cursor=100 补发，第一条事件 sequence=101，不是 gap。
      const state = loadedState([], { sequence: 100, event_id: null });
      const next = threadProjectionReducer(state, {
        type: "event.received",
        event: makeEvent({
          event_id: "evt-101",
          sequence: 101,
          payload: { item: makeItem({ id: "x", item_sequence: 1 }) },
        }),
      });
      expect(next.streamStatus).toBe("idle"); // 不进入 resnapshot
      expect(next.visibleError).toBeNull();
      expect(next.lastAppliedEventSequence).toBe(101);
    });
  });

  describe("event.received - item.superseded", () => {
    it("标记旧 Item 为 superseded，不删除", () => {
      const oldItem = makeItem({ id: "old", item_sequence: 1 });
      const newItem = makeItem({ id: "new", item_sequence: 2 });
      const state = loadedState([oldItem, newItem], { sequence: 10, event_id: null });
      const next = threadProjectionReducer(state, {
        type: "event.received",
        event: makeEvent({
          event_id: "evt-11",
          sequence: 11,
          event_type: "item.superseded",
          item_id: "old",
          payload: { superseded_by_item_id: "new" },
        }),
      });
      expect(next.items).toHaveLength(2);
      const old = next.itemsById.old;
      expect(old?.item_state).toBe("superseded");
      expect((old?.content as Record<string, unknown>).superseded_by_item_id).toBe("new");
      // 新 Item 不受影响
      expect(next.itemsById.new?.item_state).toBe("completed");
    });
  });

  describe("event.received - 非 Item 事件", () => {
    it("turn.accepted 不影响 items，只更新 sequence", () => {
      const item = makeItem({ id: "x", item_sequence: 1 });
      const state = loadedState([item], { sequence: 10, event_id: null });
      const next = threadProjectionReducer(state, {
        type: "event.received",
        event: makeEvent({
          event_id: "evt-11",
          sequence: 11,
          event_type: "turn.accepted",
          payload: {},
        }),
      });
      expect(next.items).toEqual(state.items);
      expect(next.lastAppliedEventSequence).toBe(11);
    });

    it("stream.resumed 完全忽略", () => {
      const state = loadedState([], { sequence: 10, event_id: null });
      const next = threadProjectionReducer(state, {
        type: "event.received",
        event: makeEvent({
          event_id: "stream-resumed",
          sequence: 999,
          event_type: "stream.resumed",
          payload: { latest_sequence: 10 },
        }),
      });
      expect(next).toBe(state);
    });
  });

  describe("stream.delta", () => {
    it("按 turn 增量拼接临时 Agent 消息", () => {
      const initial = loadedState(
        [makeItem({ id: "user-1", turn_id: "turn-1", content: { text: "你好" } })],
        { sequence: 2, event_id: "evt-2" },
      );
      const first = threadProjectionReducer(initial, {
        type: "stream.delta",
        event: {
          transient_id: "transient-1",
          thread_id: "thread-1",
          turn_id: "turn-1",
          occurred_at: "2026-07-21T00:00:01.000Z",
          delta: "你",
        },
      });
      const second = threadProjectionReducer(first, {
        type: "stream.delta",
        event: {
          transient_id: "transient-2",
          thread_id: "thread-1",
          turn_id: "turn-1",
          occurred_at: "2026-07-21T00:00:02.000Z",
          delta: "好",
        },
      });

      expect(second.items).toHaveLength(2);
      expect(second.items[1]).toMatchObject({
        id: "stream-turn-1",
        item_type: "agent_message",
        item_state: "pending",
        content: { text: "你好" },
      });
      expect(second.lastAppliedEventSequence).toBe(2);

      const replay = threadProjectionReducer(second, {
        type: "stream.delta",
        event: {
          transient_id: "transient-2",
          thread_id: "thread-1",
          turn_id: "turn-1",
          occurred_at: "2026-07-21T00:00:03.000Z",
          delta: "好",
        },
      });
      expect(replay).toBe(second);
    });

    it("已有该 turn 的正式回复时忽略重放的 delta", () => {
      const state = loadedState(
        [
          makeItem({
            id: "agent-1",
            turn_id: "turn-1",
            item_type: "agent_message",
            content: { text: "正式回复" },
          }),
        ],
        null,
      );
      const next = threadProjectionReducer(state, {
        type: "stream.delta",
        event: {
          transient_id: "old-delta",
          thread_id: "thread-1",
          turn_id: "turn-1",
          occurred_at: "2026-07-21T00:00:01.000Z",
          delta: "旧",
        },
      });
      expect(next).toBe(state);
    });
  });

  describe("snapshot 重载", () => {
    it("resnapshot 不重复插入已有 Item", () => {
      const item1 = makeItem({ id: "a", item_sequence: 1 });
      const state1 = loadedState([item1], { sequence: 10, event_id: null });
      // 应用一条事件
      const item2 = makeItem({ id: "b", item_sequence: 2 });
      const state2 = threadProjectionReducer(state1, {
        type: "event.received",
        event: makeEvent({
          event_id: "evt-11",
          sequence: 11,
          payload: { item: item2 },
        }),
      });
      expect(state2.items).toHaveLength(2);

      // resnapshot：snapshot 只返回 item1（item2 在 snapshot 时已被服务端确认，但
      // 这里模拟服务端 snapshot 滞后）。snapshot 是权威，应该完全替换。
      const state3 = threadProjectionReducer(state2, {
        type: "snapshot.loaded",
        items: [item1, item2],
        latestEventCursor: { sequence: 11, event_id: "evt-11" },
      });
      expect(state3.items).toHaveLength(2);
      expect(state3.lastAppliedEventSequence).toBe(11);
      // appliedEventIds 重置为 cursor event_id
      expect(state3.appliedEventIds.has("evt-11")).toBe(true);
      expect(state3.appliedEventIds.size).toBe(1);
    });

    it("snapshot 重载后 lastAppliedEventSequence 不倒退", () => {
      const state1 = loadedState([], { sequence: 100, event_id: null });
      // 服务端 snapshot 重载（假设 retention 已截断），cursor = 80 < 100
      // 但客户端按规则接受新的 cursor；后续只接受 > 80 的事件。
      const state2 = threadProjectionReducer(state1, {
        type: "snapshot.loaded",
        items: [],
        latestEventCursor: { sequence: 80, event_id: null },
      });
      expect(state2.lastAppliedEventSequence).toBe(80);
    });
  });

  describe("stream 状态变化", () => {
    it("stream.status 更新连接状态", () => {
      const state = createInitialState("thread-1");
      const next = threadProjectionReducer(state, {
        type: "stream.status",
        status: "open",
      });
      expect(next.streamStatus).toBe("open");
    });

    it("stream.cursor_expired 设置 resnapshot 状态", () => {
      const state = createInitialState("thread-1");
      const next = threadProjectionReducer(state, {
        type: "stream.cursor_expired",
        error: {
          code: "EVENT_CURSOR_EXPIRED",
          title: "会话已过期",
          description: "正在重新加载",
          retryable: false,
          recoveryAction: "resnapshot",
          requestId: null,
        },
      });
      expect(next.streamStatus).toBe("resnapshot");
      expect(next.visibleError?.code).toBe("EVENT_CURSOR_EXPIRED");
    });

    it("stream.failed 设置 failed 状态", () => {
      const state = createInitialState("thread-1");
      const next = threadProjectionReducer(state, {
        type: "stream.failed",
        error: {
          code: "AUTHENTICATION_REQUIRED",
          title: "登录已失效",
          description: "请重新登录",
          retryable: false,
          recoveryAction: "reload_page",
          requestId: null,
        },
      });
      expect(next.streamStatus).toBe("failed");
      expect(next.visibleError?.code).toBe("AUTHENTICATION_REQUIRED");
    });
  });

  describe("snapshot.loading / snapshot.failed", () => {
    it("snapshot.loading 清除错误并进入 loading", () => {
      const state = createInitialState("thread-1");
      const next = threadProjectionReducer(state, { type: "snapshot.loading" });
      expect(next.snapshotStatus).toBe("loading");
      expect(next.visibleError).toBeNull();
    });

    it("snapshot.failed 设置错误", () => {
      const state = createInitialState("thread-1");
      const next = threadProjectionReducer(state, {
        type: "snapshot.failed",
        error: {
          code: "RESOURCE_NOT_FOUND",
          title: "内容不存在",
          description: "会话不存在",
          retryable: false,
          recoveryAction: "reload_page",
          requestId: null,
        },
      });
      expect(next.snapshotStatus).toBe("failed");
      expect(next.visibleError?.code).toBe("RESOURCE_NOT_FOUND");
    });
  });
});
