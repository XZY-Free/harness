import { EventCursorExpiredError } from "@/lib/conversations/errors";
/**
 * 投影检查点与交付失败仓储。
 *
 * 事实源：
 * - docs/architecture/persistence.md （projection_checkpoint/event_delivery_failure/event_stream_floor）、（Outbox + checkpoint 协议）
 * - docs/architecture/security.md （投影消费协议七条规则）
 * - docs/architecture/api-and-events.md （顺序与去重）
 *
 * 职责：
 * - getProjectionCheckpoint / upsertProjectionCheckpoint / advanceProjectionCheckpoint：checkpoint 前移协议（同事务）。
 * - recordDeliveryFailure / updateDeliveryFailureState / getDeliveryFailure：失败记录与隔离。
 * - getEventStreamFloor / initEventStreamFloor / updateEventStreamFloor：SSE cursor_expired 判断依据。
 *
 * 关键约束（规则 3）：
 * - 投影写入成功后才前移 checkpoint；同数据库使用同一事务。
 * - 不允许在投影失败前移（§0 README ProjectionCheckpoint 域对象）。
 */
import { db } from "@/lib/db/client";
import {
 type DeliveryFailureState,
 type EventDeliveryFailure,
 type EventStreamFloor,
 type ProjectionCheckpoint,
 type StreamType,
 eventDeliveryFailureTable,
 eventStreamFloorTable,
 projectionCheckpointTable,
} from "@/lib/persistence/schema/projection";
import { and, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ─── Projection Checkpoint ─────────────────────────────────

/** 获取投影检查点（不存在返回 null）。 */
export async function getProjectionCheckpoint(
 consumerName: string,
 streamType: StreamType,
 shardKey: string,
): Promise<ProjectionCheckpoint | null> {
 const [row] = await db
 .select()
 .from(projectionCheckpointTable)
 .where(
 and(
 eq(projectionCheckpointTable.consumerName, consumerName),
 eq(projectionCheckpointTable.streamType, streamType),
 eq(projectionCheckpointTable.shardKey, shardKey),
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
): Promise<ProjectionCheckpoint | null> {
 const [row] = await tx
 .select()
 .from(projectionCheckpointTable)
 .where(
 and(
 eq(projectionCheckpointTable.consumerName, consumerName),
 eq(projectionCheckpointTable.streamType, streamType),
 eq(projectionCheckpointTable.shardKey, shardKey),
 ),
 )
 .limit(1);
 return row ?? null;
}

/**
 * 初始化投影检查点（若不存在）。
 *
 * 事实源：规则 3（checkpoint 在首次投影时创建）。
 */
export async function ensureProjectionCheckpoint(
 tx: Tx,
 consumerName: string,
 streamType: StreamType,
 shardKey: string,
): Promise<ProjectionCheckpoint> {
 const existing = await getProjectionCheckpointTx(tx, consumerName, streamType, shardKey);
 if (existing) return existing;

 await tx.insert(projectionCheckpointTable).values({
 consumerName,
 streamType,
 shardKey,
 lastSequence: 0,
 lastEventId: null,
 versionNo: 1,
 });

 const [row] = await tx
 .select()
 .from(projectionCheckpointTable)
 .where(
 and(
 eq(projectionCheckpointTable.consumerName, consumerName),
 eq(projectionCheckpointTable.streamType, streamType),
 eq(projectionCheckpointTable.shardKey, shardKey),
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
 * 事实源：规则 3（投影写入成功后才前移）、行 639。
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
 await tx.insert(projectionCheckpointTable).values({
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
 .update(projectionCheckpointTable)
 .set({
 lastSequence: newLastSequence,
 lastEventId: newLastEventId,
 updatedAt: new Date(),
 versionNo: current.versionNo + 1,
 })
 .where(
 and(
 eq(projectionCheckpointTable.consumerName, consumerName),
 eq(projectionCheckpointTable.streamType, streamType),
 eq(projectionCheckpointTable.shardKey, shardKey),
 eq(projectionCheckpointTable.versionNo, current.versionNo),
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
}): Promise<EventDeliveryFailure> {
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
 .update(eventDeliveryFailureTable)
 .set({
 attemptCount: existing.attemptCount + 1,
 failureState: "retrying",
 nextRetryAt,
 lastErrorCode: params.lastErrorCode ?? existing.lastErrorCode,
 lastErrorDetailJson: params.lastErrorDetail ?? existing.lastErrorDetailJson,
 updatedAt: now,
 })
 .where(eq(eventDeliveryFailureTable.id, existing.id));
 if (result[0].affectedRows === 0) {
 return existing;
 }
 const [row] = await db
 .select()
 .from(eventDeliveryFailureTable)
 .where(eq(eventDeliveryFailureTable.id, existing.id))
 .limit(1);
 if (!row) {
 throw new Error(`recordDeliveryFailure: 行未找到（eventId=${params.eventId}）`);
 }
 return row;
 }

 // 首次记录
 await db.insert(eventDeliveryFailureTable).values({
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
 .from(eventDeliveryFailureTable)
 .where(
 and(
 eq(eventDeliveryFailureTable.consumerName, params.consumerName),
 eq(eventDeliveryFailureTable.streamType, params.streamType),
 eq(eventDeliveryFailureTable.streamId, params.streamId),
 eq(eventDeliveryFailureTable.eventId, params.eventId),
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
): Promise<EventDeliveryFailure | null> {
 const now = new Date();
 await db
 .update(eventDeliveryFailureTable)
 .set({
 failureState: state,
 attemptCount: options?.attemptCount ?? undefined,
 nextRetryAt: options?.nextRetryAt !== undefined ? options.nextRetryAt : undefined,
 lastErrorCode: options?.lastErrorCode ?? undefined,
 lastErrorDetailJson: options?.lastErrorDetail ?? undefined,
 resolvedAt: state === "resolved" ? now : undefined,
 updatedAt: now,
 })
 .where(eq(eventDeliveryFailureTable.id, failureId));

 const [row] = await db
 .select()
 .from(eventDeliveryFailureTable)
 .where(eq(eventDeliveryFailureTable.id, failureId))
 .limit(1);
 return row ?? null;
}

/** 获取交付失败记录。 */
export async function getDeliveryFailure(
 consumerName: string,
 streamType: StreamType,
 streamId: string,
 eventId: string,
): Promise<EventDeliveryFailure | null> {
 const [row] = await db
 .select()
 .from(eventDeliveryFailureTable)
 .where(
 and(
 eq(eventDeliveryFailureTable.consumerName, consumerName),
 eq(eventDeliveryFailureTable.streamType, streamType),
 eq(eventDeliveryFailureTable.streamId, streamId),
 eq(eventDeliveryFailureTable.eventId, eventId),
 ),
 )
 .limit(1);
 return row ?? null;
}

// ─── Event Stream Floor ────────────────────────────────────

/**
 * 初始化事件流最低水位（创建 Thread 时调用）。
 *
 * 事实源：行 590、行 639。
 * - earliestAvailableSequence 默认 1（Thread 创建时第一个 event sequence）。
 * - latestSequence 初始为 0（创建时尚无 event，createThread 后更新为 1）。
 */
export async function initEventStreamFloor(params: {
 streamType: StreamType;
 streamId: string;
 tenantId: string;
 latestSequence?: number;
}): Promise<EventStreamFloor> {
 await db
 .insert(eventStreamFloorTable)
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
 .from(eventStreamFloorTable)
 .where(
 and(
 eq(eventStreamFloorTable.streamType, params.streamType),
 eq(eventStreamFloorTable.streamId, params.streamId),
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
 * 注意：earliestAvailableSequence 只由保留任务在删除历史 Event 时更新（行 639）。
 */
export async function updateEventStreamFloorLatest(
 streamType: StreamType,
 streamId: string,
 latestSequence: number,
): Promise<void> {
 await db
 .update(eventStreamFloorTable)
 .set({
 latestSequence,
 updatedAt: new Date(),
 })
 .where(
 and(
 eq(eventStreamFloorTable.streamType, streamType),
 eq(eventStreamFloorTable.streamId, streamId),
 ),
 );
}

/**
 * 更新事件流最早可读 sequence（保留任务删除历史 Event 时调用）。
 *
 * 事实源：行 639（event_stream_floor 由保留任务在删除历史 Event 的同一批次更新）。
 */
export async function updateEventStreamFloorEarliest(
 streamType: StreamType,
 streamId: string,
 earliestAvailableSequence: number,
): Promise<void> {
 await db
 .update(eventStreamFloorTable)
 .set({
 earliestAvailableSequence,
 updatedAt: new Date(),
 })
 .where(
 and(
 eq(eventStreamFloorTable.streamType, streamType),
 eq(eventStreamFloorTable.streamId, streamId),
 ),
 );
}

/** 获取事件流最低水位。 */
export async function getEventStreamFloor(
 streamType: StreamType,
 streamId: string,
): Promise<EventStreamFloor | null> {
 const [row] = await db
 .select()
 .from(eventStreamFloorTable)
 .where(
 and(
 eq(eventStreamFloorTable.streamType, streamType),
 eq(eventStreamFloorTable.streamId, streamId),
 ),
 )
 .limit(1);
 return row ?? null;
}

/**
 * 校验 SSE 游标是否有效，无效抛 EventCursorExpiredError。
 *
 * 事实源：§11 行 330、§14 行 42。
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
