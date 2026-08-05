import { makeLocalVisibleError } from "./error-messages";
/**
 * V11 员工端 Thread 投影 Reducer。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform/11-api-and-event-boundaries.md §7.5（恢复规则）
 * - docs/solutions/v11-agentkit-platform-development-plan/10-employee-web-and-desktop-experience.md S10-W01
 *
 * 核心职责（S10-W01）：
 * - 以 Thread snapshot 为基线、ThreadEvent sequence 为增量维护客户端状态。
 * - 相同 event_id、重复 SSE、旧 sequence、snapshot 重载不会重复插入消息或倒退状态。
 *
 * 幂等 / 顺序规则：
 * - snapshot.loaded 完全替换 items 并把 lastAppliedEventSequence 重置为 latest_event_cursor.sequence。
 *   同时清空 appliedEventIds（snapshot 之后只接受 cursor 之后的事件）。
 * - event.received 按 event_id 去重；sequence <= lastAppliedEventSequence 视为旧事件直接丢弃；
 *   sequence > lastAppliedEventSequence + 1 视为 gap，触发 EVENT_SEQUENCE_GAP 客户端本地错误。
 * - item.created / item.updated 事件按 event.payload.item 投影；item_id 已存在则替换，否则按
 *   item_sequence 插入到正确位置（保证 items 始终升序）。
 * - item.superseded 事件把旧 Item 状态标记为 superseded（不删除，保持后台可追溯）。
 * - turn.* / thread.* 事件只更新 lastAppliedEventSequence，不直接投影到 items
 *   （Item 是唯一渲染源；Turn 状态由后续 W02 工作包消费）。
 *
 * response.delta 通过独立 stream.delta action 投影为 pending Agent Item，不推进持久 sequence；
 * 其余 Runtime 私有 transient 事件不进入会话投影。
 */
import { V11_SSE_DEFAULT_MAX_RETRIES } from "./sse-client";
import type {
  ClientEvent,
  ClientItem,
  ThreadProjectionAction,
  ThreadProjectionState,
} from "./types";

/** 创建初始空状态。 */
export function createInitialState(threadId: string): ThreadProjectionState {
  return {
    threadId,
    items: [],
    itemsById: {},
    lastAppliedEventSequence: 0,
    appliedEventIds: new Set(),
    latestEventCursor: null,
    hasAppliedEventSinceSnapshot: false,
    streamStatus: "idle",
    reconnectAttempt: 0,
    reconnectMax: V11_SSE_DEFAULT_MAX_RETRIES,
    visibleError: null,
    snapshotStatus: "idle",
  };
}

/**
 * 浅比较两个 Item 是否「投影等价」：id / item_state / item_type / content / created_at 相同。
 * 用于 snapshot.loaded 时保留旧引用，避免不必要的 React 重绘。
 */
function isItemEqual(a: ClientItem, b: ClientItem): boolean {
  return (
    a.id === b.id &&
    a.item_state === b.item_state &&
    a.item_type === b.item_type &&
    a.created_at === b.created_at &&
    a.content === b.content
  );
}

/**
 * W4-1：合并 snapshot items 与现有 items，最大化引用稳定性。
 *
 * 后端 item.created 事件 payload 不含完整 item（只含 item_type + content_hash），
 * 导致每个 item.created 都触发 resnapshot。如果 snapshot.loaded 直接用新数组替换，
 * 即使内容相同，items 引用变化也会让 ThreadTimeline 整体重绘，视觉上像「刷新了一下」。
 *
 * 合并策略：
 * - 保留现有 transient items（id 以 `stream-` 开头），它们不在服务端 snapshot 中。
 *   但如果 snapshot 中已有同 turn_id 的 agent_message（AI 回复已完成），
 *   移除对应的 transient item，避免重复显示。
 * - 对 snapshot 中的 item，如果与现有 item 投影等价，保留旧引用。
 * - 新增或变化的 item 用新引用。
 * - 结果按 item_sequence 升序。
 */
function mergeSnapshotItems(
  snapshotItems: readonly ClientItem[],
  prevItems: readonly ClientItem[],
): readonly ClientItem[] {
  const prevById: Record<string, ClientItem> = {};
  for (const item of prevItems) {
    prevById[item.id] = item;
  }

  // 收集 snapshot 中已完成的 agent_message 的 turn_id，
  // 用于移除对应的 transient item（stream-{turn_id}）
  const completedTurnIds = new Set<string>();
  for (const snapItem of snapshotItems) {
    if (snapItem.item_type === "agent_message" && snapItem.item_state !== "pending") {
      completedTurnIds.add(snapItem.turn_id);
    }
  }

  // 保留 transient items（stream-xxx），它们是前端 stream.delta 投影的 pending agent_message。
  // 如果 snapshot 中已有同 turn_id 的完成 agent_message，移除 transient item 避免重复。
  const transientItems = prevItems.filter(
    (item) => item.id.startsWith("stream-") && !completedTurnIds.has(item.turn_id),
  );

  const merged: ClientItem[] = [];
  for (const snapItem of snapshotItems) {
    const prev = prevById[snapItem.id];
    merged.push(prev && isItemEqual(prev, snapItem) ? prev : snapItem);
  }
  // transient items 追加到末尾（item_sequence 为本地分配的最大值 +1，排在最后）
  merged.push(...transientItems);
  merged.sort((a, b) => a.item_sequence - b.item_sequence);

  // 如果合并后与 prevItems 完全相同（同序同引用），直接返回 prevItems 保持引用稳定
  if (merged.length === prevItems.length) {
    let allSame = true;
    for (let i = 0; i < merged.length; i++) {
      if (merged[i] !== prevItems[i]) {
        allSame = false;
        break;
      }
    }
    if (allSame) return prevItems;
  }
  return merged;
}

/** 把 Item 数组重建为 itemsById 映射。 */
function buildItemsById(items: readonly ClientItem[]): Readonly<Record<string, ClientItem>> {
  const map: Record<string, ClientItem> = {};
  for (const item of items) {
    map[item.id] = item;
  }
  return map;
}

/** 把 Item 按 item_sequence 插入到已升序数组的正确位置。 */
function insertItemSorted(items: readonly ClientItem[], item: ClientItem): readonly ClientItem[] {
  // 已存在则替换
  const existingIdx = items.findIndex((it) => it.id === item.id);
  if (existingIdx >= 0) {
    const next = [...items];
    next[existingIdx] = item;
    return next;
  }
  // 二分查找插入点
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midItem = items[mid];
    if (!midItem) break;
    if (midItem.item_sequence < item.item_sequence) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return [...items.slice(0, lo), item, ...items.slice(lo)];
}

/** 把 Item 标记为 superseded。 */
function markItemSuperseded(
  items: readonly ClientItem[],
  itemId: string,
  supersededByItemId: string | null,
): readonly ClientItem[] {
  return items.map((it) =>
    it.id === itemId
      ? {
          ...it,
          item_state: "superseded",
          content: {
            ...(typeof it.content === "object" && it.content !== null ? it.content : {}),
            superseded_by_item_id: supersededByItemId,
          },
        }
      : it,
  );
}

/** 从事件 payload 提取 Item。payload 不符合预期返回 null（事件被忽略）。 */
function extractItemFromPayload(payload: unknown): ClientItem | null {
  if (typeof payload !== "object" || payload === null) return null;
  const item = (payload as Record<string, unknown>).item;
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  // 宽松校验必需字段
  if (
    typeof record.id !== "string" ||
    typeof record.turn_id !== "string" ||
    typeof record.item_sequence !== "number" ||
    typeof record.item_type !== "string" ||
    typeof record.item_state !== "string" ||
    typeof record.created_at !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    turn_id: record.turn_id,
    item_sequence: record.item_sequence,
    item_type: record.item_type as ClientItem["item_type"],
    item_state: record.item_state as ClientItem["item_state"],
    content: record.content,
    created_at: record.created_at,
  };
}

/**
 * 应用单个事件到状态（仅 sequence 检查通过、event_id 未重复的）。
 *
 * 返回 null 表示该事件不影响 Item 投影（只更新 sequence）。
 */
function applyEventToItems(
  state: ThreadProjectionState,
  event: ClientEvent,
): readonly ClientItem[] | null {
  switch (event.event_type) {
    case "item.created":
    case "item.updated": {
      const item = extractItemFromPayload(event.payload);
      if (!item) return null;
      const withoutTransient =
        item.item_type === "agent_message"
          ? state.items.filter((candidate) => candidate.id !== `stream-${item.turn_id}`)
          : state.items;
      return insertItemSorted(withoutTransient, item);
    }
    case "item.superseded": {
      if (!event.item_id) return null;
      const payload = event.payload as Record<string, unknown> | null;
      const supersededByItemId =
        payload && typeof payload.superseded_by_item_id === "string"
          ? payload.superseded_by_item_id
          : null;
      return markItemSuperseded(state.items, event.item_id, supersededByItemId);
    }
    default:
      return null;
  }
}

/** Reducer：接收 action，返回新状态。纯函数，无副作用。 */
export function threadProjectionReducer(
  state: ThreadProjectionState,
  action: ThreadProjectionAction,
): ThreadProjectionState {
  switch (action.type) {
    case "snapshot.loading": {
      // W4-1：已有 items 时的 resnapshot 不改 snapshotStatus，避免 UI 显示全屏 spinner。
      // 后端 item.created 事件 payload 不含完整 item → 触发 resnapshot → snapshot.loading。
      // 如果此时把 snapshotStatus 改成 "loading"，UI 会显示全屏 spinner，
      // 即使 items 仍保留在 store 中。已有内容时保持 "ready"，静默刷新。
      // 如果 visibleError 已是 null，返回原 state 避免不必要的 re-render。
      if (state.items.length > 0) {
        if (state.visibleError === null) return state;
        return {
          ...state,
          visibleError: null,
        };
      }
      return {
        ...state,
        snapshotStatus: "loading",
        visibleError: null,
      };
    }

    case "snapshot.loaded": {
      // W4-1：用 mergeSnapshotItems 合并而非完全替换，保留未变化的 item 引用 +
      // transient items（stream-xxx），避免 resnapshot 导致 ThreadTimeline 整体重绘。
      const sortedSnapshot = [...action.items].sort((a, b) => a.item_sequence - b.item_sequence);
      const items = mergeSnapshotItems(sortedSnapshot, state.items);
      const cursorSequence = action.latestEventCursor?.sequence ?? 0;
      return {
        ...state,
        items,
        itemsById: buildItemsById(items),
        // snapshot 后只接受 cursor 之后的事件；appliedEventIds 重置为只含 cursor event_id
        lastAppliedEventSequence: cursorSequence,
        appliedEventIds: action.latestEventCursor?.event_id
          ? new Set([action.latestEventCursor.event_id])
          : new Set(),
        latestEventCursor: action.latestEventCursor,
        hasAppliedEventSinceSnapshot: false,
        snapshotStatus: "ready",
        visibleError: null,
        // snapshot 加载成功后，由客户端把 streamStatus 切到 connecting/open
      };
    }

    case "snapshot.failed": {
      return {
        ...state,
        snapshotStatus: "failed",
        visibleError: action.error,
      };
    }

    case "event.received": {
      const event = action.event;

      // stream.resumed 等流控制事件：只更新状态，不影响投影
      if (event.event_type === "stream.resumed") {
        return state;
      }

      // 1. event_id 去重（跨重连/重复 SSE）
      if (state.appliedEventIds.has(event.event_id)) {
        return state;
      }

      // 2. 旧 sequence 丢弃（严格单调，防倒退）
      if (event.sequence <= state.lastAppliedEventSequence) {
        return state;
      }

      // 3. sequence gap 检测：snapshot 后第一条事件允许不连续（服务端补发），
      //    之后的每条事件必须 sequence = lastApplied + 1，否则视为 gap。
      if (state.hasAppliedEventSinceSnapshot) {
        const expectedNext = state.lastAppliedEventSequence + 1;
        if (event.sequence !== expectedNext) {
          return {
            ...state,
            streamStatus: "resnapshot",
            visibleError: makeLocalVisibleError({
              code: "EVENT_SEQUENCE_GAP",
              retryable: true,
            }),
          };
        }
      }

      // 4. 应用到 Item 投影
      const newItems = applyEventToItems(state, event);
      const newAppliedEventIds = new Set(state.appliedEventIds);
      newAppliedEventIds.add(event.event_id);

      return {
        ...state,
        items: newItems ?? state.items,
        itemsById: newItems ? buildItemsById(newItems) : state.itemsById,
        lastAppliedEventSequence: event.sequence,
        appliedEventIds: newAppliedEventIds,
        latestEventCursor: {
          sequence: event.sequence,
          event_id: event.event_id,
        },
        hasAppliedEventSinceSnapshot: true,
      };
    }

    case "stream.delta": {
      const event = action.event;
      if (event.thread_id !== state.threadId || !event.delta) return state;
      const hasCompletedReply = state.items.some(
        (item) =>
          item.turn_id === event.turn_id &&
          item.item_type === "agent_message" &&
          item.item_state !== "pending",
      );
      if (hasCompletedReply) return state;

      const transientId = `stream-${event.turn_id}`;
      const existing = state.itemsById[transientId];
      const existingText =
        existing &&
        typeof existing.content === "object" &&
        existing.content !== null &&
        typeof (existing.content as Record<string, unknown>).text === "string"
          ? ((existing.content as Record<string, unknown>).text as string)
          : "";
      const appliedTransientIds =
        existing &&
        typeof existing.content === "object" &&
        existing.content !== null &&
        Array.isArray((existing.content as Record<string, unknown>).transient_ids)
          ? ((existing.content as Record<string, unknown>).transient_ids as string[])
          : [];
      if (appliedTransientIds.includes(event.transient_id)) return state;
      const item: ClientItem = {
        id: transientId,
        turn_id: event.turn_id,
        item_sequence:
          existing?.item_sequence ??
          state.items.reduce((max, candidate) => Math.max(max, candidate.item_sequence), 0) + 1,
        item_type: "agent_message",
        item_state: "pending",
        content: {
          text: `${existingText}${event.delta}`,
          transient_ids: [...appliedTransientIds, event.transient_id],
        },
        created_at: existing?.created_at ?? event.occurred_at,
      };
      const items = insertItemSorted(state.items, item);
      return {
        ...state,
        items,
        itemsById: buildItemsById(items),
      };
    }

    case "stream.status": {
      // 连接恢复（open）时清零重连计数，避免下次中断从旧计数继续累加。
      const attempt =
        action.status === "reconnecting" ? (action.reconnectAttempt ?? state.reconnectAttempt) : 0;
      return {
        ...state,
        streamStatus: action.status,
        reconnectAttempt: attempt,
        reconnectMax: action.reconnectMax ?? state.reconnectMax,
      };
    }

    case "stream.cursor_expired": {
      return {
        ...state,
        streamStatus: "resnapshot",
        visibleError: action.error,
      };
    }

    case "stream.failed": {
      return {
        ...state,
        streamStatus: "failed",
        visibleError: action.error,
      };
    }

    default:
      return state;
  }
}
