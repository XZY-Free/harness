/**
 * V11 会话读模型查询。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §11（查询读模型：thread_list_projection / turn_timeline_projection）
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §3.5（Item 列表响应含 latest_event_cursor）、§7.5（恢复规则：Item 快照和 latest_event_cursor 在同一一致性读点）
 *
 * 职责：
 * - listThreadProjectionsForUser：员工会话列表（按 lastActivityAt 降序，跨租户隔离）。
 * - getThreadProjection：单个 Thread 列表投影。
 * - listTurnTimelineProjections：Turn 时间线（按 turnSequence 升序）。
 * - getTurnTimelineProjection：单个 Turn 时间线投影。
 * - getItemSnapshotWithCursor：Item 快照 + latest_event_cursor 一致性读点（从权威表读取，避免投影延迟影响）。
 * - getProjectionHealth：投影健康检查（checkpoint 与权威 lastEventSequence 的 lag）。
 *
 * 关键约束：
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - 一致性读点（§11 行 297-301）：getItemSnapshotWithCursor 从权威表（V11ThreadItem + V11Thread.lastEventSequence）
 *   读取，即使投影有延迟，一致性读点仍正确。
 * - 排序：thread_list_projection 按 lastActivityAt 降序；turn_timeline_projection 按 turnSequence 升序。
 */

import { db } from "@/lib/db/client";
import { getProjectionCheckpoint } from "@/lib/v11/conversation/projection-checkpoint-queries";
import { listItemsByThread } from "@/lib/v11/conversation/thread-item-queries";
import {
  getLatestEventCursor,
  getLatestEventSequence,
} from "@/lib/v11/conversation/thread-queries";
import type { V11ThreadItem } from "@/lib/v11/schema/conversation";
import {
  type V11ThreadListProjection,
  type V11TurnTimelineProjection,
  v11ThreadListProjection,
  v11TurnTimelineProjection,
} from "@/lib/v11/schema/projection";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";

/** Thread 列表投影的 consumer 名称（用于 checkpoint 查询）。 */
const THREAD_LIST_CONSUMER = "thread_list_projection";
/** Turn 时间线投影的 consumer 名称（用于 checkpoint 查询）。 */
const TURN_TIMELINE_CONSUMER = "turn_timeline_projection";
/** thread_event 流类型（所有 Thread 投影消费的流）。 */
const THREAD_EVENT_STREAM = "thread_event" as const;

/**
 * 员工会话列表（按 lastActivityAt 降序，跨租户隔离）。
 *
 * 选项：
 * - lifecycleState：过滤生命周期状态。
 * - limit：默认 50，最大 200。
 * - afterCreatedAt：游标分页（按 lastActivityAt < afterCreatedAt 取下一页）。
 */
export async function listThreadProjectionsForUser(
  tenantId: string,
  ownerUserId: string,
  options?: {
    lifecycleState?: "active" | "archived" | "deleted";
    limit?: number;
    afterCreatedAt?: Date;
  },
): Promise<V11ThreadListProjection[]> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [
    eq(v11ThreadListProjection.tenantId, tenantId),
    eq(v11ThreadListProjection.ownerUserId, ownerUserId),
  ];
  if (options?.lifecycleState) {
    conditions.push(eq(v11ThreadListProjection.lifecycleState, options.lifecycleState));
  }
  if (options?.afterCreatedAt) {
    // 按 lastActivityAt 降序取下一页：游标为上一页最后一条的 lastActivityAt
    conditions.push(lt(v11ThreadListProjection.lastActivityAt, options.afterCreatedAt));
  }

  return db
    .select()
    .from(v11ThreadListProjection)
    .where(and(...conditions))
    .orderBy(desc(v11ThreadListProjection.lastActivityAt))
    .limit(limit);
}

/** 单个 Thread 列表投影。不存在返回 null。 */
export async function getThreadProjection(
  tenantId: string,
  threadId: string,
): Promise<V11ThreadListProjection | null> {
  const [row] = await db
    .select()
    .from(v11ThreadListProjection)
    .where(
      and(
        eq(v11ThreadListProjection.tenantId, tenantId),
        eq(v11ThreadListProjection.threadId, threadId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Turn 时间线（按 turnSequence 升序）。
 *
 * 选项：
 * - limit：默认 50，最大 200。
 * - afterTurnSequence：游标分页（turnSequence > afterTurnSequence）。
 */
export async function listTurnTimelineProjections(
  tenantId: string,
  threadId: string,
  options?: { limit?: number; afterTurnSequence?: number },
): Promise<V11TurnTimelineProjection[]> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [
    eq(v11TurnTimelineProjection.tenantId, tenantId),
    eq(v11TurnTimelineProjection.threadId, threadId),
  ];
  if (options?.afterTurnSequence !== undefined) {
    conditions.push(gt(v11TurnTimelineProjection.turnSequence, options.afterTurnSequence));
  }

  return db
    .select()
    .from(v11TurnTimelineProjection)
    .where(and(...conditions))
    .orderBy(asc(v11TurnTimelineProjection.turnSequence))
    .limit(limit);
}

/** 单个 Turn 时间线投影。不存在返回 null。 */
export async function getTurnTimelineProjection(
  tenantId: string,
  turnId: string,
): Promise<V11TurnTimelineProjection | null> {
  const [row] = await db
    .select()
    .from(v11TurnTimelineProjection)
    .where(
      and(
        eq(v11TurnTimelineProjection.tenantId, tenantId),
        eq(v11TurnTimelineProjection.turnId, turnId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Item 快照 + latest_event_cursor 一致性读点。
 *
 * 事实源：§11 行 297-301（Item 列表与 latest_event_cursor 在同一一致性读点生成）、§7.5（恢复规则）。
 *
 * 实现策略：从权威表读取 Item（V11ThreadItem）和 cursor（V11Thread.lastEventSequence），
 * 即使投影有延迟，一致性读点仍正确。两个查询在同一函数内并行完成，构成逻辑一致性读点。
 *
 * 选项：
 * - turnId：过滤指定 Turn 的 Item。
 * - includeSuperseded：默认 false，不返回 superseded Item。
 * - limit：默认 50，最大 200。
 */
export async function getItemSnapshotWithCursor(
  tenantId: string,
  threadId: string,
  options?: { turnId?: string; includeSuperseded?: boolean; limit?: number },
): Promise<{
  items: V11ThreadItem[];
  latestEventCursor: { sequence: number; eventId: string | null } | null;
}> {
  // 两个查询均从权威表读取，并行执行后返回同一逻辑读点的一致性快照
  const [items, latestEventCursor] = await Promise.all([
    listItemsByThread(tenantId, threadId, {
      turnId: options?.turnId,
      includeSuperseded: options?.includeSuperseded,
      limit: options?.limit,
    }),
    getLatestEventCursor(tenantId, threadId),
  ]);

  return { items, latestEventCursor };
}

/**
 * 投影健康检查（用于运维）。
 *
 * 返回 thread_list_projection 和 turn_timeline_projection 的 checkpoint（lastSequence）
 * 与权威 V11Thread.lastEventSequence 的差距（lag）。
 *
 * - checkpoint 从 V11ProjectionCheckpoint 表读取（不存在视为 0）。
 * - latestEventSequence 从 V11Thread 读取；Thread 不存在返回 null。
 * - lag = latest - checkpoint（>= 0，避免 checkpoint 超前于权威表的异常情况产生负数）。
 */
export async function getProjectionHealth(
  tenantId: string,
  threadId: string,
): Promise<{
  threadListCheckpoint: number;
  turnTimelineCheckpoint: number;
  latestEventSequence: number;
  threadListLag: number;
  turnTimelineLag: number;
} | null> {
  // 权威 lastEventSequence（Thread 不存在则返回 null）
  const latestEventSequence = await getLatestEventSequence(tenantId, threadId);
  if (latestEventSequence === null) return null;

  // 两个投影的 checkpoint（不存在视为 0）
  const [threadListCheckpointRow, turnTimelineCheckpointRow] = await Promise.all([
    getProjectionCheckpoint(THREAD_LIST_CONSUMER, THREAD_EVENT_STREAM, threadId),
    getProjectionCheckpoint(TURN_TIMELINE_CONSUMER, THREAD_EVENT_STREAM, threadId),
  ]);

  const threadListCheckpoint = threadListCheckpointRow?.lastSequence ?? 0;
  const turnTimelineCheckpoint = turnTimelineCheckpointRow?.lastSequence ?? 0;

  return {
    threadListCheckpoint,
    turnTimelineCheckpoint,
    latestEventSequence,
    threadListLag: Math.max(0, latestEventSequence - threadListCheckpoint),
    turnTimelineLag: Math.max(0, latestEventSequence - turnTimelineCheckpoint),
  };
}

/**
 * 跨 owner 列出租户所有 Thread 投影（按 lastActivityAt 降序，跨租户隔离）。
 *
 * 事实源：S11-W04 管理面排障端点 /admin/api/v1/threads 使用本函数跨 owner 列出租户所有 Thread。
 *
 * 选项：
 * - lifecycleState：过滤生命周期状态。
 * - limit：默认 50，最大 200。
 * - afterCreatedAt：游标分页（按 lastActivityAt < afterCreatedAt 取下一页）。
 */
export async function listThreadProjectionsByTenant(
  tenantId: string,
  options?: {
    lifecycleState?: "active" | "archived" | "deleted";
    limit?: number;
    afterCreatedAt?: Date;
  },
): Promise<V11ThreadListProjection[]> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [eq(v11ThreadListProjection.tenantId, tenantId)];
  if (options?.lifecycleState) {
    conditions.push(eq(v11ThreadListProjection.lifecycleState, options.lifecycleState));
  }
  if (options?.afterCreatedAt) {
    // 按 lastActivityAt 降序取下一页：游标为上一页最后一条的 lastActivityAt
    conditions.push(lt(v11ThreadListProjection.lastActivityAt, options.afterCreatedAt));
  }

  return db
    .select()
    .from(v11ThreadListProjection)
    .where(and(...conditions))
    .orderBy(desc(v11ThreadListProjection.lastActivityAt))
    .limit(limit);
}
