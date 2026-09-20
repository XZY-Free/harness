/**
 * 员工端 Thread 投影 Reducer。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md （恢复规则）
 * - docs/architecture/product-surfaces-and-admin.md S10-W01
 *
 * 核心职责（S10-W01）：
 * - 以 Thread snapshot 为基线、ThreadEvent sequence 为增量维护客户端状态。
 * - 相同 event_id、重复 SSE、旧 sequence、snapshot 重载不会重复插入消息或倒退状态。
 *
 * 幂等 / 顺序规则：
 * - snapshot.loaded 完全替换 items 并把 lastAppliedEventSequence 重置为 latest_event_cursor.sequence。
 * 同时清空 appliedEventIds（snapshot 之后只接受 cursor 之后的事件）。
 * - event.received 按 event_id 去重；sequence <= lastAppliedEventSequence 视为旧事件直接丢弃；
 * sequence > lastAppliedEventSequence + 1 视为 gap，触发 EVENT_SEQUENCE_GAP 客户端本地错误。
 * - item.created / item.updated 事件按 event.payload.item 投影；item_id 已存在则替换，否则按
 * item_sequence 插入到正确位置（保证 items 始终升序）。
 * - item.superseded 事件把旧 Item 状态标记为 superseded（不删除，保持后台可追溯）。
 * - turn.* / thread.* 事件只更新 lastAppliedEventSequence，不直接投影到 items
 * （Item 是唯一渲染源；Turn 状态由后续 W02 工作包消费）。
 *
 * response.delta 通过独立 stream.delta action 投影为 pending Agent Item，不推进持久 sequence；
 * 其余 Runtime 私有 transient 事件不进入会话投影。
 *
 * A11（执行代际隔离）：
 * - 临时 Item 的 id 至少包含**完整代际 tuple**（Invocation/Attempt/Ownership/epoch），不再只有
 *   Turn。同一个 Turn 被后续代际继续使用时，两代正文不可能落进同一条临时正文。
 * - 分类只用服务端权威基线（`Turn.activeInvocationId` → 当前 active Ownership）：**不**比较
 *   不同 Invocation 的 epoch 大小（各自从自己的计数开始，数字大小无意义）。
 * - 基线未覆盖的 Turn → 有界暂存等下一次权威基线；基线明确"无活动执行" → 丢弃。
 * - 权威换代 → 旧代临时正文随基线变更被移除；snapshot 合并同样只保留与基线一致的临时正文。
 */
import {
  type ThreadGenerationBaseline,
  type ThreadTransientGeneration,
  compareLeaseEpoch,
  findAuthoritativeGeneration,
  isNewerGenerationBaseline,
  sameThreadGeneration,
  threadGenerationKey,
} from "@/lib/runtime/thread-generation";
import { mergeActionEntries, projectActivityEvent } from "./activity-projection";
import { makeLocalVisibleError } from "./error-messages";
import { SSE_DEFAULT_MAX_RETRIES } from "./sse-client";
import type {
  ClientEvent,
  ClientGenerationBaseline,
  ClientItem,
  ClientTransientDelta,
  ClientTransientGeneration,
  ThreadProjectionAction,
  ThreadProjectionState,
} from "./types";

/** A11：单个 Turn 的暂存增量上限（有界暂存，防止基线长期不来时无限堆积）。 */
export const MAX_PENDING_TRANSIENT_PER_TURN = 64;

/** A11：本地临时正文的 Item id 前缀（snapshot 合并据此识别"非服务端 Item"）。 */
const TRANSIENT_ITEM_PREFIX = "stream-";

/** 线上代际（snake_case）→ 契约代际（camelCase）。 */
function toContractGeneration(generation: ClientTransientGeneration): ThreadTransientGeneration {
  return {
    invocationId: generation.invocation_id,
    attemptId: generation.attempt_id,
    ownershipId: generation.ownership_id,
    leaseEpoch: generation.lease_epoch,
  };
}

/** 线上基线 → 契约基线（供共用判定函数使用）。 */
function toContractBaseline(baseline: ClientGenerationBaseline): ThreadGenerationBaseline {
  return {
    threadId: baseline.thread_id,
    baselineSequence: baseline.baseline_sequence,
    issuedRevision: baseline.issued_revision,
    generations: baseline.generations.map((entry) => ({
      turnId: entry.turn_id,
      generation: entry.generation ? toContractGeneration(entry.generation) : null,
    })),
  };
}

/** 可空版本：`isNewerGenerationBaseline` 第二参数本身接受 null。 */
function toNullableContractBaseline(
  baseline: ClientGenerationBaseline | null,
): ThreadGenerationBaseline | null {
  return baseline ? toContractBaseline(baseline) : null;
}

/**
 * A11 决策表的唯一实现：一条 transient 相对当前权威基线应当如何处置。
 *
 * | 情形 | 结果 |
 * |---|---|
 * | 无基线 / 基线未覆盖该 Turn | `stage`（有界暂存，不自作主张拼旧正文） |
 * | 基线明确该 Turn 无活动执行 | `drop`（迟到 delta 不复活） |
 * | 与权威 tuple 完全相同 | `apply`（幂等去重后追加到本 tuple 的临时正文） |
 * | 同 Invocation 同 epoch 但 Owner/Attempt 不同 | `conflict`（协议冲突，停止应用并刷新权威事实） |
 * | 其余（含同 Invocation 的旧 epoch、同 Turn 的不同 Invocation） | `drop` |
 */
export type TransientDeltaDisposition = "apply" | "stage" | "drop" | "conflict";

export function classifyTransientDelta(
  baseline: ClientGenerationBaseline | null,
  delta: ClientTransientDelta,
): TransientDeltaDisposition {
  const contract = toNullableContractBaseline(baseline);
  const authoritative = findAuthoritativeGeneration(contract, delta.turn_id);
  // 未覆盖（含尚未收到基线）：有界暂存，绝不拼进旧正文。
  if (authoritative === undefined) return "stage";
  if (authoritative === null) return "drop";
  const incoming = toContractGeneration(delta.generation);
  if (sameThreadGeneration(authoritative, incoming)) return "apply";
  if (authoritative.invocationId === incoming.invocationId) {
    // 同一 Invocation 内 epoch 可比：epoch 相同却换了 Ownership/Attempt 属协议冲突。
    if (compareLeaseEpoch(authoritative.leaseEpoch, incoming.leaseEpoch) === 0) return "conflict";
    // 同 Invocation 的旧 epoch：迟到重放，丢弃。
    return "drop";
  }
  // 同 Turn 的不同 Invocation：由权威活动执行事实判定，绝不比较二者 epoch 大小。
  return "drop";
}

/** 临时正文的 Item id：包含完整代际 tuple（不再只有 turn_id）。 */
export function transientItemId(turnId: string, generation: ClientTransientGeneration): string {
  return `${TRANSIENT_ITEM_PREFIX}${turnId}:${threadGenerationKey(toContractGeneration(generation))}`;
}

/** 读回临时 Item 携带的代际；非临时 Item 或结构不合法返回 null。 */
export function readTransientGeneration(item: ClientItem): ClientTransientGeneration | null {
  if (!item.id.startsWith(TRANSIENT_ITEM_PREFIX)) return null;
  if (typeof item.content !== "object" || item.content === null) return null;
  const raw = (item.content as Record<string, unknown>).generation;
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const { invocation_id: invocationId, attempt_id: attemptId, ownership_id: ownershipId } = record;
  const leaseEpoch = record.lease_epoch;
  if (typeof invocationId !== "string" || typeof attemptId !== "string") return null;
  if (typeof ownershipId !== "string" || typeof leaseEpoch !== "string") return null;
  return {
    invocation_id: invocationId,
    attempt_id: attemptId,
    ownership_id: ownershipId,
    lease_epoch: leaseEpoch,
  };
}

/** 该 Turn 是否已有正式（非 pending）assistant_message —— 终态成立后临时正文必须退出。 */
function hasCompletedReplyForTurn(items: readonly ClientItem[], turnId: string): boolean {
  return items.some(
    (item) =>
      item.turn_id === turnId &&
      item.item_type === "assistant_message" &&
      item.item_state !== "pending",
  );
}

/**
 * 应用一条**已确认**的同代际增量：追加到该 tuple 自己的临时正文（幂等按 transient_id 去重）。
 *
 * 返回原数组表示无变化（重复 transient_id / 无正文 / 已有正式回复）。
 */
function applyTransientDelta(
  items: readonly ClientItem[],
  delta: ClientTransientDelta,
): readonly ClientItem[] {
  if (!delta.delta) return items;
  if (hasCompletedReplyForTurn(items, delta.turn_id)) return items;

  const transientId = transientItemId(delta.turn_id, delta.generation);
  const existing = items.find((candidate) => candidate.id === transientId);
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
  if (appliedTransientIds.includes(delta.transient_id)) return items;

  const item: ClientItem = {
    id: transientId,
    turn_id: delta.turn_id,
    item_sequence:
      existing?.item_sequence ??
      items.reduce((max, candidate) => Math.max(max, candidate.item_sequence), 0) + 1,
    item_type: "assistant_message",
    item_state: "pending",
    content: {
      text: `${existingText}${delta.delta}`,
      generation: { ...delta.generation },
      transient_ids: [...appliedTransientIds, delta.transient_id],
    },
    created_at: existing?.created_at ?? delta.occurred_at,
  };
  return insertItemSorted(items, item);
}

/** 有界暂存：追加一条未确认增量（超上限丢最旧，保持到达顺序）。 */
function stageTransient(
  pending: Readonly<Record<string, readonly ClientTransientDelta[]>>,
  delta: ClientTransientDelta,
): Readonly<Record<string, readonly ClientTransientDelta[]>> {
  const current = pending[delta.turn_id] ?? [];
  const next = [...current, delta];
  return {
    ...pending,
    [delta.turn_id]:
      next.length > MAX_PENDING_TRANSIENT_PER_TURN
        ? next.slice(next.length - MAX_PENDING_TRANSIENT_PER_TURN)
        : next,
  };
}

/** 该临时 Item 是否仍属于基线认定的当前代际（基线缺失时保留，换代由新基线证明）。 */
function isCurrentTransientItem(
  item: ClientItem,
  baseline: ClientGenerationBaseline | null,
): boolean {
  const generation = readTransientGeneration(item);
  if (!generation) return false;
  if (!baseline) return true;
  const authoritative = baseline.generations.find((entry) => entry.turn_id === item.turn_id);
  if (!authoritative) return false;
  if (!authoritative.generation) return false;
  return sameThreadGeneration(
    toContractGeneration(authoritative.generation),
    toContractGeneration(generation),
  );
}

/** 创建初始空状态。 */
export function createInitialState(threadId: string): ThreadProjectionState {
  return {
    threadId,
    activity: [],
    items: [],
    itemsById: {},
    lastAppliedEventSequence: 0,
    appliedEventIds: new Set(),
    latestEventCursor: null,
    hasAppliedEventSinceSnapshot: false,
    streamStatus: "idle",
    reconnectAttempt: 0,
    reconnectMax: SSE_DEFAULT_MAX_RETRIES,
    visibleError: null,
    snapshotStatus: "idle",
    generationBaseline: null,
    pendingTransients: {},
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
 * - 保留仍然**属于当前权威代际**的 transient items（id 以 `stream-` 开头），它们不在服务端
 *   snapshot 中。A11：换代后旧代的临时正文不得被 snapshot 合并带回来，因此由调用方传入
 *   `keepTransient` 判定（基线未到时保留，基线证明换代后移除）。
 * - 如果 snapshot 中已有同 turn_id 的 assistant_message（AI 回复已完成），
 * 移除对应的 transient item，避免重复显示。
 * - 对 snapshot 中的 item，如果与现有 item 投影等价，保留旧引用。
 * - 新增或变化的 item 用新引用。
 * - 结果按 item_sequence 升序。
 */
function mergeSnapshotItems(
  snapshotItems: readonly ClientItem[],
  prevItems: readonly ClientItem[],
  keepTransient: (item: ClientItem) => boolean,
): readonly ClientItem[] {
  const prevById: Record<string, ClientItem> = {};
  for (const item of prevItems) {
    prevById[item.id] = item;
  }

  // 收集 snapshot 中已完成的 assistant_message 的 turn_id，
  // 用于移除对应的 transient item（stream-{turn_id}）
  const completedTurnIds = new Set<string>();
  for (const snapItem of snapshotItems) {
    if (snapItem.item_type === "assistant_message" && snapItem.item_state !== "pending") {
      completedTurnIds.add(snapItem.turn_id);
    }
  }

  // 保留 transient items（stream-xxx），它们是前端 stream.delta 投影的 pending assistant_message。
  // 如果 snapshot 中已有同 turn_id 的完成 assistant_message，移除 transient item 避免重复。
  const transientItems = prevItems.filter(
    (item) =>
      item.id.startsWith(TRANSIENT_ITEM_PREFIX) &&
      !completedTurnIds.has(item.turn_id) &&
      keepTransient(item),
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
    case "user_action.resolved": {
      const payload = event.payload as Record<string, unknown> | null;
      const item = event.item_id ? state.itemsById[event.item_id] : undefined;
      if (
        !item ||
        item.item_type !== "user_action" ||
        !payload ||
        typeof item.content !== "object" ||
        item.content === null ||
        !("request_id" in item.content) ||
        item.content.request_id !== payload.request_id ||
        !["approve", "deny", "submit", "cancel"].includes(String(payload.resolution))
      )
        return null;
      return insertItemSorted(state.items, {
        ...item,
        item_state: "completed",
        content: { ...item.content, state: "resolved", resolution: payload.resolution },
      });
    }
    case "item.created":
    case "item.updated": {
      const item = extractItemFromPayload(event.payload);
      if (!item) return null;
      // A11：正式 assistant_message 成立 → 该 Turn 的**所有代际**临时正文一并退出
      // （临时 Item 现在按完整 tuple 分键，不能再只删 `stream-${turn_id}` 这一个键）。
      const withoutTransient =
        item.item_type === "assistant_message"
          ? state.items.filter(
              (candidate) =>
                candidate.turn_id !== item.turn_id || readTransientGeneration(candidate) === null,
            )
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
      // A11：临时正文还必须仍属于当前权威代际 —— 换代后旧代临时前缀不得被 snapshot 带回。
      const sortedSnapshot = [...action.items].sort((a, b) => a.item_sequence - b.item_sequence);
      const items = mergeSnapshotItems(sortedSnapshot, state.items, (item) =>
        isCurrentTransientItem(item, state.generationBaseline),
      );
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
        // 历史过程由 items(progress) + 按需 activity 端点重建；live ring 重置
        activity: [],
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
      // 之后的每条事件必须 sequence = lastApplied + 1，否则视为 gap。
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

      // 过程透明 live ring：动作事件投影入 activity；completed 结果合并回 proposed 行块
      let activity = state.activity;
      const entry = projectActivityEvent(event);
      if (entry) {
        activity = mergeActionEntries([...activity, entry]);
        if (activity.length > 300) activity = activity.slice(activity.length - 300);
      }

      return {
        ...state,
        activity,
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
      const delta = action.event;
      if (delta.thread_id !== state.threadId) return state;
      switch (classifyTransientDelta(state.generationBaseline, delta)) {
        case "apply": {
          const items = applyTransientDelta(state.items, delta);
          if (items === state.items) return state;
          return { ...state, items, itemsById: buildItemsById(items) };
        }
        case "stage":
          return { ...state, pendingTransients: stageTransient(state.pendingTransients, delta) };
        // drop：迟到旧代际 / 权威判定无活动执行 → 不改变任何正文。
        // conflict：同 epoch 换 Owner/Attempt → 停止应用（有界权威刷新由客户端发起）。
        default:
          return state;
      }
    }

    case "stream.generation": {
      const baseline = action.baseline;
      // 同一条连接上迟到的旧基线不采用（先持久游标、再进程内发号）。
      if (
        !isNewerGenerationBaseline(
          toContractBaseline(baseline),
          toNullableContractBaseline(state.generationBaseline),
        )
      ) {
        return state;
      }
      // 1. 旧代际临时正文随权威换代移除；缺失代际/结构不合法的**临时** Item 一并清除。
      //    正式 Item（id 不以 stream- 开头）永远不在这里被删。
      let items: readonly ClientItem[] = state.items.filter(
        (item) => readTransientGeneration(item) === null || isCurrentTransientItem(item, baseline),
      );
      // 2. 重放暂存：只保留仍需等待权威事实的桶，其余按新基线分类处理。
      const remaining: Record<string, readonly ClientTransientDelta[]> = {};
      for (const [, deltas] of Object.entries(state.pendingTransients)) {
        for (const delta of deltas) {
          const disposition = classifyTransientDelta(baseline, delta);
          if (disposition === "apply") {
            items = applyTransientDelta(items, delta);
          } else if (disposition === "stage") {
            remaining[delta.turn_id] = [...(remaining[delta.turn_id] ?? []), delta];
          }
          // drop / conflict → 丢弃
        }
      }
      const itemsChanged = items !== state.items;
      return {
        ...state,
        items: itemsChanged ? items : state.items,
        itemsById: itemsChanged ? buildItemsById(items) : state.itemsById,
        generationBaseline: baseline,
        pendingTransients: remaining,
      };
    }

    case "stream.generation_reset": {
      // 新连接：比较基准失效（服务端发号只保证单进程单调，跨连接不可比）。
      // 只清判定依据与暂存；已显示的临时正文等本连接第一条基线来证明换代。
      if (state.generationBaseline === null && Object.keys(state.pendingTransients).length === 0) {
        return state;
      }
      return { ...state, generationBaseline: null, pendingTransients: {} };
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
