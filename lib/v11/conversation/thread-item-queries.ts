/**
 * V11 ThreadItem 仓储。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §5.4（ThreadItem 表）、§9.1（事务边界）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §6（Item 当前投影）
 * - ../v11-agentkit-platform-development-plan/04-thread-turn-item-and-event-core.md S04-W03
 *
 * 职责：
 * - getItemById/getItemsByThread/getItemsByTurn：查询（跨租户隔离）。
 * - supersedeItem：标记旧 Item 为 superseded（含环检测）。
 * - updateItemState：Item 状态机转换。
 *
 * 不变量（§5.4 行 287）：
 * - superseded_by_item_id 不得形成环。
 * - 不能无痕覆盖历史；状态变化必须有对应 ThreadEvent。
 */
import { db } from "@/lib/db/client";
import { ItemSupersedeCycleError, ThreadItemNotFoundError } from "@/lib/v11/conversation/errors";
import {
  type ThreadItemState,
  type V11ThreadItem,
  v11Thread,
  v11ThreadItem,
} from "@/lib/v11/schema/conversation";
import { and, asc, eq, isNull } from "drizzle-orm";

/** 按 id 获取 Item（跨租户隔离）。不存在返回 null。 */
export async function getItemById(tenantId: string, itemId: string): Promise<V11ThreadItem | null> {
  const [row] = await db
    .select({ item: v11ThreadItem })
    .from(v11ThreadItem)
    .innerJoin(v11Thread, eq(v11ThreadItem.threadId, v11Thread.id))
    .where(and(eq(v11Thread.tenantId, tenantId), eq(v11ThreadItem.id, itemId)))
    .limit(1);
  return row?.item ?? null;
}

/** 按 id 获取 Item，不存在抛 ThreadItemNotFoundError。 */
export async function requireItem(tenantId: string, itemId: string): Promise<V11ThreadItem> {
  const item = await getItemById(tenantId, itemId);
  if (!item) throw new ThreadItemNotFoundError(itemId);
  return item;
}

/**
 * 列出 Thread 的 Item（按 item_sequence 升序）。
 *
 * 选项：
 * - turnId：过滤指定 Turn。
 * - includeSuperseded：默认 false，不返回 superseded Item。
 * - limit：默认 50，最大 200。
 * - afterSequence：游标分页，返回 item_sequence > afterSequence 的 Item。
 */
export async function listItemsByThread(
  tenantId: string,
  threadId: string,
  options?: {
    turnId?: string;
    includeSuperseded?: boolean;
    limit?: number;
    afterSequence?: number;
  },
): Promise<V11ThreadItem[]> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [eq(v11Thread.tenantId, tenantId), eq(v11ThreadItem.threadId, threadId)];
  if (options?.turnId) {
    conditions.push(eq(v11ThreadItem.turnId, options.turnId));
  }
  if (!options?.includeSuperseded) {
    conditions.push(isNull(v11ThreadItem.supersededByItemId));
  }

  const rows = await db
    .select({ item: v11ThreadItem })
    .from(v11ThreadItem)
    .innerJoin(v11Thread, eq(v11ThreadItem.threadId, v11Thread.id))
    .where(and(...conditions))
    .orderBy(asc(v11ThreadItem.itemSequence))
    .limit(limit);

  return rows.map((r) => r.item);
}

/**
 * 标记旧 Item 为 superseded。
 *
 * 不变量（§5.4 行 287）：superseded_by_item_id 不得形成环。
 * 环检测：遍历 supersededByItemId 链，若遇到 newItemId 则形成环。
 *
 * 注意：本函数不写 item.superseded Event；调用方负责在事务内写。
 */
export async function supersedeItem(
  tenantId: string,
  oldItemId: string,
  newItemId: string,
): Promise<V11ThreadItem | null> {
  if (oldItemId === newItemId) {
    throw new ItemSupersedeCycleError(oldItemId, newItemId);
  }

  // 环检测：从 newItemId 开始遍历 supersededByItemId 链
  // 如果 newItemId 本身也被某个 item supersede，那个 item 不应指向 oldItemId
  // 实际上 supersede 关系是 old.supersededByItem = new
  // 环检测：从 oldItemId 开始，沿着 supersededByItemId 链遍历，如果遇到 newItemId 的后继指向 oldItemId 则成环
  // 简化：只需确保 newItemId 不是 oldItemId 的祖先（即 newItemId.supersededByItemId 链不包含 oldItemId）
  let currentId: string | null = newItemId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    if (currentId === oldItemId) {
      throw new ItemSupersedeCycleError(oldItemId, newItemId);
    }
    const [current] = await db
      .select({ supersededBy: v11ThreadItem.supersededByItemId })
      .from(v11ThreadItem)
      .where(eq(v11ThreadItem.id, currentId))
      .limit(1);
    currentId = current?.supersededBy ?? null;
  }

  const result = await db
    .update(v11ThreadItem)
    .set({
      itemState: "superseded" as ThreadItemState,
      supersededByItemId: newItemId,
      updatedAt: new Date(),
    })
    .where(and(eq(v11ThreadItem.id, oldItemId), isNull(v11ThreadItem.supersededByItemId)));

  if (result[0].affectedRows === 0) return null;
  return getItemById(tenantId, oldItemId);
}

/** 更新 Item 状态。注意：本函数不写 Event；调用方负责。 */
export async function updateItemState(
  tenantId: string,
  itemId: string,
  nextState: ThreadItemState,
): Promise<V11ThreadItem | null> {
  const result = await db
    .update(v11ThreadItem)
    .set({
      itemState: nextState,
      updatedAt: new Date(),
    })
    .where(eq(v11ThreadItem.id, itemId));

  if (result[0].affectedRows === 0) return null;
  return getItemById(tenantId, itemId);
}
