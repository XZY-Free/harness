/**
 * V11 投影检查点与交付失败仓储。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §8.1（projection_checkpoint/event_delivery_failure/event_stream_floor）、§9.2（Outbox + checkpoint 协议）
 * - ../v11-agentkit-platform/14-production-operations-security-and-retention.md §2.1（投影消费协议七条规则）
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §7.4（顺序与去重）
 *
 * 职责：
 * - getProjectionCheckpoint / upsertProjectionCheckpoint / advanceProjectionCheckpoint：checkpoint 前移协议（同事务）。
 * - recordDeliveryFailure / updateDeliveryFailureState / getDeliveryFailure：失败记录与隔离。
 * - getEventStreamFloor / initEventStreamFloor / updateEventStreamFloor：SSE cursor_expired 判断依据。
 *
 * 关键约束（§2.1 规则 3）：
 * - 投影写入成功后才前移 checkpoint；同数据库使用同一事务。
 * - 不允许在投影失败前移（§0 README ProjectionCheckpoint 域对象）。
 */
import { db } from "@/lib/db/client";
import { EventCursorExpiredError } from "@/lib/v11/conversation/errors";
import {
  type DeliveryFailureState,
  type StreamType,
  type V11EventDeliveryFailure,
  type V11EventStreamFloor,
  type V11ProjectionCheckpoint,
  v11EventDeliveryFailure,
  v11EventStreamFloor,
  v11ProjectionCheckpoint,
} from "@/lib/v11/schema/projection";
import { and, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ─── Projection Checkpoint ─────────────────────────────────

/** 获取投影检查点（不存在返回 null）。 */
export async function getProjectionCheckpoint(
  consumerName: string,
  streamType: StreamType,
  shardKey: string,
): Promise<V11ProjectionCheckpoint | null> {
  const [row] = await db
    .select()
    .from(v11ProjectionCheckpoint)
    .where(
      and(
        eq(v11ProjectionCheckpoint.consumerName, consumerName),
        eq(v11ProjectionCheckpoint.streamType, streamType),
        eq(v11ProjectionCheckpoint.shardKey, shardKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 获取投影检查点（事务内）。 */
export async function getProjectionCheckpointTx(
  tx: Tx,
  consumerName: string,
  streamType: StreamType,
  shardKey: string,
): Promise<V11ProjectionCheckpoint | null> {
  const [row] = await tx
    .select()
    .from(v11ProjectionCheckpoint)
    .where(
      and(
        eq(v11ProjectionCheckpoint.consumerName, consumerName),
        eq(v11ProjectionCheckpoint.streamType, streamType),
        eq(v11ProjectionCheckpoint.shardKey, shardKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 初始化投影检查点（若不存在）。
 *
 * 事实源：§2.1 规则 3（checkpoint 在首次投影时创建）。
 */
export async function ensureProjectionCheckpoint(
  tx: Tx,
  consumerName: string,
  streamType: StreamType,
  shardKey: string,
): Promise<V11ProjectionCheckpoint> {
  const existing = await getProjectionCheckpointTx(tx, consumerName, streamType, shardKey);
  if (existing) return existing;

  await tx.insert(v11ProjectionCheckpoint).values({
    consumerName,
    streamType,
    shardKey,
    lastSequence: 0,
    lastEventId: null,
    versionNo: 1,
  });

  const [row] = await tx
    .select()
    .from(v11ProjectionCheckpoint)
    .where(
      and(
        eq(v11ProjectionCheckpoint.consumerName, consumerName),
        eq(v11ProjectionCheckpoint.streamType, streamType),
        eq(v11ProjectionCheckpoint.shardKey, shardKey),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error(
      `ensureProjectionCheckpoint: 行未找到（${consumerName}/${streamType}/${shardKey}）`,
    );
  }
  return row;
}

/**
 * 前移投影检查点（同事务，CAS 乐观锁）。
 *
 * 事实源：§2.1 规则 3（投影写入成功后才前移）、§9.2 行 639。
 * - 只在投影写入成功的同一事务后调用。
 * - lastSequence 单调递增，不回退。
 *
 * @returns 是否前移成功（false 表示 sequence 已落后或冲突）
 */
export async function advanceProjectionCheckpoint(
  tx: Tx,
  consumerName: string,
  streamType: StreamType,
  shardKey: string,
  newLastSequence: number,
  newLastEventId: string,
): Promise<boolean> {
  const current = await getProjectionCheckpointTx(tx, consumerName, streamType, shardKey);
  if (!current) {
    // 首次前移 = 初始化 + 设置
    await tx.insert(v11ProjectionCheckpoint).values({
      consumerName,
      streamType,
      shardKey,
      lastSequence: newLastSequence,
      lastEventId: newLastEventId,
      versionNo: 1,
    });
    return true;
  }

  // sequence 已落后或相同 = 幂等，不前移
  if (current.lastSequence >= newLastSequence) {
    return false;
  }

  const result = await tx
    .update(v11ProjectionCheckpoint)
    .set({
      lastSequence: newLastSequence,
      lastEventId: newLastEventId,
      updatedAt: new Date(),
      versionNo: current.versionNo + 1,
    })
    .where(
      and(
        eq(v11ProjectionCheckpoint.consumerName, consumerName),
        eq(v11ProjectionCheckpoint.streamType, streamType),
        eq(v11ProjectionCheckpoint.shardKey, shardKey),
        eq(v11ProjectionCheckpoint.versionNo, current.versionNo),
      ),
    );

  return result[0].affectedRows > 0;
}

// ─── Event Delivery Failure ────────────────────────────────

/** 记录事件交付失败（幂等：同 consumer/stream/event 已存在则递增 attemptCount）。 */
export async function recordDeliveryFailure(params: {
  consumerName: string;
  streamType: StreamType;
  streamId: string;
  eventId: string;
  eventSequence: number;
  payloadHash?: string | null;
  failureClass: string;
  lastErrorCode?: string | null;
  lastErrorDetail?: Record<string, unknown> | null;
}): Promise<V11EventDeliveryFailure> {
  const now = new Date();
  // 指数退避：首次 nextRetryAt = now + 10s
  const nextRetryAt = new Date(now.getTime() + 10_000);

  const existing = await getDeliveryFailure(
    params.consumerName,
    params.streamType,
    params.streamId,
    params.eventId,
  );

  if (existing) {
    // 递增 attemptCount，更新失败信息
    const result = await db
      .update(v11EventDeliveryFailure)
      .set({
        attemptCount: existing.attemptCount + 1,
        failureState: "retrying",
        nextRetryAt,
        lastErrorCode: params.lastErrorCode ?? existing.lastErrorCode,
        lastErrorDetailJson: params.lastErrorDetail ?? existing.lastErrorDetailJson,
        updatedAt: now,
      })
      .where(eq(v11EventDeliveryFailure.id, existing.id));
    if (result[0].affectedRows === 0) {
      return existing;
    }
    const [row] = await db
      .select()
      .from(v11EventDeliveryFailure)
      .where(eq(v11EventDeliveryFailure.id, existing.id))
      .limit(1);
    if (!row) {
      throw new Error(`recordDeliveryFailure: 行未找到（eventId=${params.eventId}）`);
    }
    return row;
  }

  // 首次记录
  await db.insert(v11EventDeliveryFailure).values({
    consumerName: params.consumerName,
    streamType: params.streamType,
    streamId: params.streamId,
    eventId: params.eventId,
    eventSequence: params.eventSequence,
    payloadHash: params.payloadHash ?? null,
    failureClass: params.failureClass,
    failureState: "retrying",
    attemptCount: 1,
    nextRetryAt,
    lastErrorCode: params.lastErrorCode ?? null,
    lastErrorDetailJson: params.lastErrorDetail ?? null,
  });

  const [row] = await db
    .select()
    .from(v11EventDeliveryFailure)
    .where(
      and(
        eq(v11EventDeliveryFailure.consumerName, params.consumerName),
        eq(v11EventDeliveryFailure.streamType, params.streamType),
        eq(v11EventDeliveryFailure.streamId, params.streamId),
        eq(v11EventDeliveryFailure.eventId, params.eventId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error(`recordDeliveryFailure: 行未找到（eventId=${params.eventId}）`);
  }
  return row;
}

// 由于 onDuplicateKeyUpdate 的类型限制，提供一个独立的重试计数更新函数
export async function updateDeliveryFailureState(
  failureId: string,
  state: DeliveryFailureState,
  options?: {
    attemptCount?: number;
    nextRetryAt?: Date | null;
    lastErrorCode?: string | null;
    lastErrorDetail?: Record<string, unknown> | null;
  },
): Promise<V11EventDeliveryFailure | null> {
  const now = new Date();
  await db
    .update(v11EventDeliveryFailure)
    .set({
      failureState: state,
      attemptCount: options?.attemptCount ?? undefined,
      nextRetryAt: options?.nextRetryAt !== undefined ? options.nextRetryAt : undefined,
      lastErrorCode: options?.lastErrorCode ?? undefined,
      lastErrorDetailJson: options?.lastErrorDetail ?? undefined,
      resolvedAt: state === "resolved" ? now : undefined,
      updatedAt: now,
    })
    .where(eq(v11EventDeliveryFailure.id, failureId));

  const [row] = await db
    .select()
    .from(v11EventDeliveryFailure)
    .where(eq(v11EventDeliveryFailure.id, failureId))
    .limit(1);
  return row ?? null;
}

/** 获取交付失败记录。 */
export async function getDeliveryFailure(
  consumerName: string,
  streamType: StreamType,
  streamId: string,
  eventId: string,
): Promise<V11EventDeliveryFailure | null> {
  const [row] = await db
    .select()
    .from(v11EventDeliveryFailure)
    .where(
      and(
        eq(v11EventDeliveryFailure.consumerName, consumerName),
        eq(v11EventDeliveryFailure.streamType, streamType),
        eq(v11EventDeliveryFailure.streamId, streamId),
        eq(v11EventDeliveryFailure.eventId, eventId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ─── Event Stream Floor ────────────────────────────────────

/**
 * 初始化事件流最低水位（创建 Thread 时调用）。
 *
 * 事实源：§8.1 行 590、§9.2 行 639。
 * - earliestAvailableSequence 默认 1（Thread 创建时第一个 event sequence）。
 * - latestSequence 初始为 0（创建时尚无 event，createThread 后更新为 1）。
 */
export async function initEventStreamFloor(params: {
  streamType: StreamType;
  streamId: string;
  tenantId: string;
  latestSequence?: number;
}): Promise<V11EventStreamFloor> {
  await db
    .insert(v11EventStreamFloor)
    .values({
      streamType: params.streamType,
      streamId: params.streamId,
      tenantId: params.tenantId,
      earliestAvailableSequence: 1,
      latestSequence: params.latestSequence ?? 0,
    })
    .onDuplicateKeyUpdate({
      set: {
        latestSequence: params.latestSequence ?? 0,
        updatedAt: new Date(),
      },
    });

  const [row] = await db
    .select()
    .from(v11EventStreamFloor)
    .where(
      and(
        eq(v11EventStreamFloor.streamType, params.streamType),
        eq(v11EventStreamFloor.streamId, params.streamId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error(`initEventStreamFloor: 行未找到（${params.streamType}/${params.streamId}）`);
  }
  return row;
}

/**
 * 更新事件流最新 sequence（写入 Event 后调用）。
 *
 * 注意：earliestAvailableSequence 只由保留任务在删除历史 Event 时更新（§9.2 行 639）。
 */
export async function updateEventStreamFloorLatest(
  streamType: StreamType,
  streamId: string,
  latestSequence: number,
): Promise<void> {
  await db
    .update(v11EventStreamFloor)
    .set({
      latestSequence,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(v11EventStreamFloor.streamType, streamType),
        eq(v11EventStreamFloor.streamId, streamId),
      ),
    );
}

/**
 * 更新事件流最早可读 sequence（保留任务删除历史 Event 时调用）。
 *
 * 事实源：§9.2 行 639（event_stream_floor 由保留任务在删除历史 Event 的同一批次更新）。
 */
export async function updateEventStreamFloorEarliest(
  streamType: StreamType,
  streamId: string,
  earliestAvailableSequence: number,
): Promise<void> {
  await db
    .update(v11EventStreamFloor)
    .set({
      earliestAvailableSequence,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(v11EventStreamFloor.streamType, streamType),
        eq(v11EventStreamFloor.streamId, streamId),
      ),
    );
}

/** 获取事件流最低水位。 */
export async function getEventStreamFloor(
  streamType: StreamType,
  streamId: string,
): Promise<V11EventStreamFloor | null> {
  const [row] = await db
    .select()
    .from(v11EventStreamFloor)
    .where(
      and(
        eq(v11EventStreamFloor.streamType, streamType),
        eq(v11EventStreamFloor.streamId, streamId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 校验 SSE 游标是否有效，无效抛 EventCursorExpiredError。
 *
 * 事实源：§11 行 330、§14 §2.2 行 42。
 * - Last-Event-ID < earliest_available_sequence 返回 EVENT_CURSOR_EXPIRED。
 * - 客户端先取 Item 快照和 latest_event_cursor，再续订。
 */
export async function assertEventCursorValid(
  streamType: StreamType,
  streamId: string,
  lastEventSequence: number,
): Promise<void> {
  const floor = await getEventStreamFloor(streamType, streamId);
  if (!floor) {
    // 流不存在 = 视为游标过期（stream 已清理或从未创建）
    throw new EventCursorExpiredError(streamId, lastEventSequence, 1);
  }
  if (lastEventSequence < floor.earliestAvailableSequence) {
    throw new EventCursorExpiredError(streamId, lastEventSequence, floor.earliestAvailableSequence);
  }
}

export type { Tx };
