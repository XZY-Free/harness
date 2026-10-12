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
import {
  classifyTransientDelta,
  createInitialState,
  threadProjectionReducer,
} from "./thread-reducer";
import type {
  ClientEvent,
  ClientGenerationBaseline,
  ClientItem,
  ClientTransientDelta,
  ClientTransientGeneration,
  ThreadProjectionState,
} from "./types";

function makeItem(overrides: Partial<ClientItem> = {}): ClientItem {
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

function makeEvent(overrides: Partial<ClientEvent> = {}): ClientEvent {
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
  items: readonly ClientItem[],
  cursor: { sequence: number; event_id: string | null } | null,
): ThreadProjectionState {
  return threadProjectionReducer(createInitialState("thread-1"), {
    type: "snapshot.loaded",
    items,
    latestEventCursor: cursor,
  });
}

// ─── A11 代际 fixture ──────────────────────────────────────

/** A11 测试用稳定 Turn id。 */
const TURN = "turn-1";

/** 权威代际：Invocation-1 的第 1 代。 */
const GEN_A: ClientTransientGeneration = {
  invocation_id: "invocation-1",
  attempt_id: "attempt-1",
  ownership_id: "ownership-1",
  lease_epoch: "1",
};

/** 同一 Invocation 的下一租约代（接管后换掉 Attempt/Ownership）。 */
const GEN_A2: ClientTransientGeneration = {
  invocation_id: "invocation-1",
  attempt_id: "attempt-2",
  ownership_id: "ownership-2",
  lease_epoch: "2",
};

/**
 * 同 Turn 的**全新 Invocation**（Replacement/Regenerate）。
 *
 * epoch 从它自己的计数重新开始，因此数值可能比旧 Invocation 更小 —— 这正是
 * "不能比较不同 Invocation 的 epoch 大小"的原因。
 */
const GEN_B: ClientTransientGeneration = {
  invocation_id: "invocation-2",
  attempt_id: "attempt-3",
  ownership_id: "ownership-3",
  lease_epoch: "1",
};

/** 构造一条权威代际基线。 */
function baselineOf(
  entries: ReadonlyArray<readonly [string, ClientTransientGeneration | null]>,
  sequence = 10,
): ClientGenerationBaseline {
  return {
    thread_id: "thread-1",
    baseline_sequence: sequence,
    issued_revision: 1,
    generations: entries.map(([turnId, generation]) => ({ turn_id: turnId, generation })),
  };
}

/** 构造一条 transient delta。 */
function deltaOf(
  transientId: string,
  turnId: string,
  generation: ClientTransientGeneration,
  delta: string,
  seq: number,
): ClientTransientDelta {
  return {
    transient_id: transientId,
    thread_id: "thread-1",
    turn_id: turnId,
    generation,
    occurred_at: `2026-07-21T00:00:0${seq}.000Z`,
    delta,
  };
}

describe("threadProjectionReducer", () => {
  it("user_action.resolved 只更新匹配 request 的卡片，重放幂等且保留新待处理卡片", () => {
    const item = makeItem({
      item_type: "user_action",
      item_state: "pending",
      content: { request_id: "request-1", prompt: "请提供日期" },
    });
    const nextItem = makeItem({
      id: "item-2",
      item_sequence: 2,
      item_type: "user_action",
      item_state: "pending",
      content: { request_id: "request-2" },
    });
    const state = loadedState([item, nextItem], null);
    const event = makeEvent({
      event_type: "user_action.resolved",
      item_id: item.id,
      payload: { request_id: "request-1", resolution: "submit" },
    });
    const next = threadProjectionReducer(state, { type: "event.received", event });
    expect(next.items[0]).toEqual({
      ...item,
      item_state: "completed",
      content: { ...(item.content as object), state: "resolved", resolution: "submit" },
    });
    expect(next.items[1]).toBe(nextItem);
    expect(threadProjectionReducer(next, { type: "event.received", event })).toBe(next);
  });

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

  describe("stream.delta（A11 执行代际隔离）", () => {
    const withBaseline = (
      state: ThreadProjectionState,
      baseline: ClientGenerationBaseline,
    ): ThreadProjectionState =>
      threadProjectionReducer(state, { type: "stream.generation", baseline });

    const applyDelta = (
      state: ThreadProjectionState,
      delta: ClientTransientDelta,
    ): ThreadProjectionState =>
      threadProjectionReducer(state, { type: "stream.delta", event: delta });

    /** 某一 Turn 当前全部临时正文（按 items 顺序拼接）。 */
    const transientText = (state: ThreadProjectionState, turnId: string): string =>
      state.items
        .filter((item) => item.turn_id === turnId && item.id.startsWith("stream-"))
        .map((item) => ((item.content as { text?: string }).text ?? "") as string)
        .join("");

    it("A11-T02：与权威 tuple 完全相同的 delta 幂等拼接；旧代际迟到 delta 不进入正文", () => {
      const initial = loadedState(
        [makeItem({ id: "user-1", turn_id: TURN, content: { text: "你好" } })],
        { sequence: 2, event_id: "evt-2" },
      );
      const withGen = withBaseline(initial, baselineOf([[TURN, GEN_A]]));

      const first = applyDelta(withGen, deltaOf("t-1", TURN, GEN_A, "你", 1));
      const second = applyDelta(first, deltaOf("t-2", TURN, GEN_A, "好", 2));
      expect(transientText(second, TURN)).toBe("你好");
      expect(second.lastAppliedEventSequence).toBe(2);

      // 幂等：同一 transient_id 重放不改变正文（仅瞬时 id 去重是不够的，见下一个断言）。
      expect(applyDelta(second, deltaOf("t-2", TURN, GEN_A, "好", 3))).toBe(second);

      // 同 Invocation 的旧 epoch 迟到：不得改变当前临时正文。
      const staleEpoch = {
        ...GEN_A,
        attempt_id: "attempt-0",
        ownership_id: "ownership-0",
        lease_epoch: "0",
      };
      expect(applyDelta(second, deltaOf("t-3", TURN, staleEpoch, "旧", 4))).toBe(second);
      expect(transientText(second, TURN)).toBe("你好");
    });

    it("A11-T04：同 Turn 换 Invocation 不以 epoch 大小判定，旧 Invocation 不得混入", () => {
      // 旧 I1 的 epoch 数值更大（100），新活动 I2 的 epoch 更小（1）——不能按数字比大小。
      const oldInvocation: ClientTransientGeneration = {
        invocation_id: "invocation-1",
        attempt_id: "attempt-old",
        ownership_id: "ownership-old",
        lease_epoch: "100",
      };
      const newInvocation: ClientTransientGeneration = {
        invocation_id: "invocation-2",
        attempt_id: "attempt-new",
        ownership_id: "ownership-new",
        lease_epoch: "1",
      };
      const initial = loadedState([], null);

      // 权威事实先接纳 I1，输出一段正文。
      const firstGen = withBaseline(initial, baselineOf([[TURN, oldInvocation]]));
      const withOldText = applyDelta(
        firstGen,
        deltaOf("t-old", TURN, oldInvocation, "旧代正文", 1),
      );
      expect(transientText(withOldText, TURN)).toBe("旧代正文");

      // 换代：权威活动执行变为 I2 → 旧代临时正文被移除，I2 不因 epoch 更小而失效。
      const secondGen = withBaseline(withOldText, baselineOf([[TURN, newInvocation]], 11));
      expect(transientText(secondGen, TURN)).toBe("");
      const withNewText = applyDelta(
        secondGen,
        deltaOf("t-new", TURN, newInvocation, "新代正文", 2),
      );
      expect(transientText(withNewText, TURN)).toBe("新代正文");

      // 旧 I1 的迟到 delta 不得混入新代正文（即使它的 epoch 数值更大）。
      expect(
        applyDelta(withNewText, deltaOf("t-old-late", TURN, oldInvocation, "旧代残留", 3)),
      ).toBe(withNewText);
      expect(transientText(withNewText, TURN)).toBe("新代正文");
      // 两代正文不共享 item（key 含完整 tuple）。
      expect(withNewText.items.filter((item) => item.id.startsWith("stream-"))).toHaveLength(1);
    });

    it("A11-T06：正式终态成立后迟到 delta 不复活临时 Item，且不删除正式消息", () => {
      const official = makeItem({
        id: "agent-1",
        turn_id: TURN,
        item_type: "assistant_message",
        content: { text: "正式回复" },
      });
      const state = withBaseline(loadedState([official], null), baselineOf([[TURN, GEN_A]]));

      // 同代际与旧代际的迟到 delta 都不得复活临时正文。
      expect(applyDelta(state, deltaOf("late-1", TURN, GEN_A, "迟到", 1))).toBe(state);
      expect(applyDelta(state, deltaOf("late-2", TURN, GEN_A2, "旧代", 2))).toBe(state);
      // 正式消息原样保留。
      expect(state.items).toHaveLength(1);
      expect((state.items[0]?.content as { text: string }).text).toBe("正式回复");
    });

    it("A11-T08：快照与换代通知乱序——旧 snapshot 合并不得带回旧代临时前缀", () => {
      const initial = loadedState([], null);
      // 旧代已显示一段临时正文。
      const oldGen = withBaseline(initial, baselineOf([[TURN, GEN_A]]));
      const withOldText = applyDelta(oldGen, deltaOf("t-old", TURN, GEN_A, "旧代正文", 1));
      expect(transientText(withOldText, TURN)).toBe("旧代正文");

      // 先到换代通知（新代 I2），再到"快照返回"（服务端不含任何临时正文）。
      const newGen = withBaseline(withOldText, baselineOf([[TURN, GEN_B]], 12));
      const afterSnapshot = threadProjectionReducer(newGen, {
        type: "snapshot.loaded",
        items: [],
        latestEventCursor: { sequence: 12, event_id: null },
      });
      // 旧代临时前缀不被 snapshot 合并带回。
      expect(transientText(afterSnapshot, TURN)).toBe("");

      // 新代的 delta 正常显示。
      const withNewText = applyDelta(afterSnapshot, deltaOf("t-new", TURN, GEN_B, "新代正文", 3));
      expect(transientText(withNewText, TURN)).toBe("新代正文");
    });

    it("A11：权威基线未覆盖的 Turn 只暂存，不拼进旧正文；基线证明换代后重放", () => {
      const initial = loadedState([], null);
      // 基线覆盖 turn-1，但不覆盖 turn-2（连接建立后才创建的 Turn）。
      const withGen = withBaseline(initial, baselineOf([[TURN, GEN_A]]));
      const otherTurnDelta = deltaOf("t-other", "turn-2", GEN_A, "新 Turn 正文", 1);
      const staged = applyDelta(withGen, otherTurnDelta);

      // 未确认的新 tuple：有界暂存，不自作主张拼进任何正文。
      expect(staged.items).toHaveLength(0);
      expect(staged.pendingTransients["turn-2"]).toEqual([otherTurnDelta]);

      // 权威快照覆盖该 Turn 后按 exact tuple 重放。
      const covered = withBaseline(
        staged,
        baselineOf(
          [
            [TURN, GEN_A],
            ["turn-2", GEN_A],
          ],
          13,
        ),
      );
      expect(transientText(covered, "turn-2")).toBe("新 Turn 正文");
      expect(covered.pendingTransients["turn-2"]).toBeUndefined();
    });

    it("A11：基线明确该 Turn 无活动执行 → 迟到 delta 丢弃，暂存整桶清除", () => {
      const initial = loadedState([], null);
      const withGen = withBaseline(initial, baselineOf([[TURN, null]]));
      expect(applyDelta(withGen, deltaOf("t-1", TURN, GEN_A, "迟到", 1))).toBe(withGen);

      // 暂存中的桶在权威判定"无活动执行"后清除（不复活）。
      const stagedState = applyDelta(
        withBaseline(initial, baselineOf([])),
        deltaOf("t-2", TURN, GEN_A, "暂存", 1),
      );
      expect(stagedState.pendingTransients[TURN]).toHaveLength(1);
      const resolved = withBaseline(
        {
          ...stagedState,
          generationBaseline: { ...stagedState.generationBaseline!, baseline_sequence: 1 },
        },
        baselineOf([[TURN, null]], 2),
      );
      expect(resolved.pendingTransients[TURN]).toBeUndefined();
      expect(resolved.items).toHaveLength(0);
    });

    it("A11：同 epoch 换 Owner/Attempt 判为协议冲突（epoch 精确比较，大 epoch 不因精度丢判）", () => {
      const big = "9007199254740993";
      const adjacent = "9007199254740992";
      const authoritative: ClientTransientGeneration = {
        invocation_id: "invocation-1",
        attempt_id: "attempt-1",
        ownership_id: "ownership-1",
        lease_epoch: big,
      };
      const baseline = baselineOf([[TURN, authoritative]]);
      // 同 Invocation、同 epoch，但换了 Ownership/Attempt → 协议冲突。
      expect(
        classifyTransientDelta(baseline, {
          ...deltaOf("d1", TURN, { ...authoritative, ownership_id: "ownership-x" }, "冲突", 1),
        }),
      ).toBe("conflict");
      // 相邻 epoch（Number 无法区分）是正确的"旧代际" → drop，而不是被误判成冲突。
      expect(
        classifyTransientDelta(
          baseline,
          deltaOf("d2", TURN, { ...authoritative, lease_epoch: adjacent }, "旧", 2),
        ),
      ).toBe("drop");
      // 冲突的 delta 不改变正文。
      const state = withBaseline(loadedState([], null), baseline);
      expect(
        applyDelta(
          state,
          deltaOf("d3", TURN, { ...authoritative, attempt_id: "attempt-x" }, "冲突", 3),
        ),
      ).toBe(state);
    });

    it("A11：迟到的旧基线不被采用（先持久游标、再进程内发号）", () => {
      const state = withBaseline(loadedState([], null), baselineOf([[TURN, GEN_A]], 10));
      const older = { ...baselineOf([[TURN, GEN_B]], 9), issued_revision: 99 };
      expect(withBaseline(state, older)).toBe(state);
      // 同游标但发号更小 → 也拒绝。
      const sameSeqLowerRevision = { ...baselineOf([[TURN, GEN_B]], 10), issued_revision: 0 };
      expect(withBaseline(state, sameSeqLowerRevision)).toBe(state);
      // 同游标且发号更大 → 采用（接管不一定新增持久事件）。
      const sameSeqHigherRevision = { ...baselineOf([[TURN, GEN_B]], 10), issued_revision: 2 };
      expect(
        withBaseline(state, sameSeqHigherRevision).generationBaseline?.generations[0]?.generation,
      ).toEqual(GEN_B);
    });

    it("A11：新连接重置比较基准，但已显示的临时正文等新基线证明换代后才移除", () => {
      const oldGen = withBaseline(loadedState([], null), baselineOf([[TURN, GEN_A]]));
      const withOldText = applyDelta(oldGen, deltaOf("t-old", TURN, GEN_A, "旧代正文", 1));

      const reset = threadProjectionReducer(withOldText, { type: "stream.generation_reset" });
      expect(reset.generationBaseline).toBeNull();
      // 不预先删除：换代与否由新基线证明。
      expect(transientText(reset, TURN)).toBe("旧代正文");
      // 基准重置后，delta 只能暂存（无法判定）。
      const afterResetDelta = applyDelta(reset, deltaOf("t-x", TURN, GEN_A, "X", 2));
      expect(afterResetDelta.pendingTransients[TURN]).toHaveLength(1);

      // 新基线证明确实换代 → 旧正文移除，暂存按新基线处理。
      const newBaseline = withBaseline(afterResetDelta, baselineOf([[TURN, GEN_B]], 20));
      expect(transientText(newBaseline, TURN)).toBe("");
      expect(newBaseline.pendingTransients[TURN]).toBeUndefined();
    });

    it("A11：已持有正式回复的 Turn 不产生临时正文（终态清理）", () => {
      const state = withBaseline(
        loadedState(
          [
            makeItem({
              id: "agent-1",
              turn_id: TURN,
              item_type: "assistant_message",
              content: { text: "正式回复" },
            }),
          ],
          null,
        ),
        baselineOf([[TURN, GEN_A]]),
      );
      expect(applyDelta(state, deltaOf("t-1", TURN, GEN_A, "重放", 1))).toBe(state);
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
