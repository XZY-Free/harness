/**
 * 投影与交付 schema。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md （projection_checkpoint/event_delivery_failure/event_stream_floor）、（Outbox + checkpoint 协议）、§11（查询读模型）
 * - ../v11-agentkit-platform/14-production-operations-security-and-retention.md （投影消费协议七条规则）、（SSE 背压与 cursor_expired）
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md （顺序与去重）、（恢复规则）
 *
 * 关键约束：
 * - projection_checkpoint：PRIMARY KEY(consumer_name, stream_type, shard_key)；只在投影写入成功的同一事务后前移。
 * - event_delivery_failure：UNIQUE(consumer_name, stream_type, stream_id, event_id)；state 为 retrying/quarantined/resolved。
 * - event_stream_floor：由保留任务在删除历史 Event 的同一批次更新，SSE 据此判断 cursor_expired。
 * - thread_list_projection / turn_timeline_projection：可重建的查询读模型，非权威写表；投影器按 event sequence 幂等更新。
 *
 * 幂等键至少包含 consumer、event_id 和 projection target（规则 2）。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
 bigint,
 datetime,
 index,
 int,
 json,
 mysqlEnum,
 mysqlTable,
 text,
 uniqueIndex,
 varchar,
} from "drizzle-orm/mysql-core";

// ─── Stream Type ───────────────────────────────────────────

/**
 * 事件流类型。
 * - thread_event：Thread 内事件流（shard_key = threadId）。
 * - job_event：Job 内事件流（shard_key = jobId）。
 */
export const STREAM_TYPES = ["thread_event", "job_event"] as const;
export type StreamType = (typeof STREAM_TYPES)[number];

// ─── Delivery Failure State ────────────────────────────────

/**
 * 事件交付失败状态。
 * - retrying：可重试，按指数退避。
 * - quarantined：达到重试上限隔离，后续同流事件不得越序生效。
 * - resolved：已修复（replay 或 skip）。
 */
export const DELIVERY_FAILURE_STATES = ["retrying", "quarantined", "resolved"] as const;
export type DeliveryFailureState = (typeof DELIVERY_FAILURE_STATES)[number];

// ─── Projection Checkpoint ─────────────────────────────────

/**
 * 投影检查点：记录消费者已完成的流内位置。
 *
 * 事实源：行 584-586、行 639。
 * - PRIMARY KEY(consumer_name, stream_type, shard_key)。
 * - 只在投影写入成功的同一事务后前移（规则 3）。
 * - 不允许在投影失败前移（§0 README ProjectionCheckpoint 域对象）。
 */
export const projectionCheckpointTable = mysqlTable(
 "ProjectionCheckpoint",
 {
 /** 消费者名称（如 thread_list_projection、turn_timeline_projection）。 */
 consumerName: varchar("consumerName", { length: 128 }).notNull(),
 streamType: mysqlEnum("streamType", STREAM_TYPES).notNull(),
 /** 流分片键：thread_event 流为 threadId，job_event 流为 jobId。 */
 shardKey: varchar("shardKey", { length: 36 }).notNull(),
 /** 已消费到的最大 sequence。 */
 lastSequence: bigint("lastSequence", { mode: "number" }).notNull().default(0),
 /** 已消费的最后一个 event id（幂等键组成部分）。 */
 lastEventId: varchar("lastEventId", { length: 36 }),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 /** 乐观并发版本号（CAS 前移用）。 */
 versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
 },
 (t) => ({
 // 复合主键在迁移 SQL 中显式声明（drizzle mysqlTable 复合主键通过 SQL 迁移保证）
 consumerStreamShardIdx: uniqueIndex("ProjectionCheckpoint_consumer_stream_shard_uq").on(
 t.consumerName,
 t.streamType,
 t.shardKey,
 ),
 }),
);

export type ProjectionCheckpoint = InferSelectModel<typeof projectionCheckpointTable>;
export type NewProjectionCheckpoint = InferInsertModel<typeof projectionCheckpointTable>;

// ─── Event Delivery Failure ────────────────────────────────

/**
 * 事件交付失败记录。
 *
 * 事实源：行 587-589、规则 5-7。
 * - UNIQUE(consumer_name, stream_type, stream_id, event_id)。
 * - state 为 retrying/quarantined/resolved。
 * - 达到重试上限进入 quarantined，后续同流事件不得越序生效（行 592）。
 */
export const eventDeliveryFailureTable = mysqlTable(
 "EventDeliveryFailure",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 consumerName: varchar("consumerName", { length: 128 }).notNull(),
 streamType: mysqlEnum("streamType", STREAM_TYPES).notNull(),
 /** 流标识（通常等于 shardKey）。 */
 streamId: varchar("streamId", { length: 36 }).notNull(),
 /** 失败的 event id。 */
 eventId: varchar("eventId", { length: 36 }).notNull(),
 eventSequence: bigint("eventSequence", { mode: "number" }).notNull(),
 /** payload hash，用于幂等和冲突检测。 */
 payloadHash: varchar("payloadHash", { length: 128 }),
 /** 失败类别（schema_unsupported/payload_hash_conflict/projection_constraint/unknown）。 */
 failureClass: varchar("failureClass", { length: 64 }).notNull(),
 failureState: mysqlEnum("failureState", DELIVERY_FAILURE_STATES).notNull().default("retrying"),
 attemptCount: int("attemptCount").notNull().default(0),
 nextRetryAt: datetime("nextRetryAt", { mode: "date", fsp: 3 }),
 lastErrorCode: varchar("lastErrorCode", { length: 128 }),
 /** 失败详情（脱敏后）。 */
 lastErrorDetailJson: json("lastErrorDetailJson"),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 /** resolved 时间，用于审计。 */
 resolvedAt: datetime("resolvedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 consumerStreamEventUq: uniqueIndex("EventDeliveryFailure_consumer_stream_event_uq").on(
 t.consumerName,
 t.streamType,
 t.streamId,
 t.eventId,
 ),
 consumerStreamSequenceIdx: index("EventDeliveryFailure_consumer_stream_sequence_idx").on(
 t.consumerName,
 t.streamType,
 t.streamId,
 t.eventSequence,
 ),
 stateRetryIdx: index("EventDeliveryFailure_state_retry_idx").on(t.failureState, t.nextRetryAt),
 }),
);

export type EventDeliveryFailure = InferSelectModel<typeof eventDeliveryFailureTable>;
export type NewEventDeliveryFailure = InferInsertModel<typeof eventDeliveryFailureTable>;

// ─── Event Stream Floor ────────────────────────────────────

/**
 * 事件流最低水位：SSE 判断 cursor_expired 的依据。
 *
 * 事实源：行 590、行 639。
 * - 由保留任务在删除历史 Event 的同一批次更新，保证 floor 与实际可读 Event 一致。
 * - Last-Event-ID < earliest_available_sequence 返回 EVENT_CURSOR_EXPIRED（行 42）。
 */
export const eventStreamFloorTable = mysqlTable(
 "EventStreamFloor",
 {
 streamType: mysqlEnum("streamType", STREAM_TYPES).notNull(),
 /** 流标识（threadId 或 jobId）。 */
 streamId: varchar("streamId", { length: 36 }).notNull(),
 tenantId: varchar("tenantId", { length: 36 }).notNull(),
 /** 最早可读 sequence（小于此值视为游标过期）。 */
 earliestAvailableSequence: bigint("earliestAvailableSequence", { mode: "number" })
 .notNull()
 .default(1),
 /** 最新 sequence（用于快速判断 lag）。 */
 latestSequence: bigint("latestSequence", { mode: "number" }).notNull().default(0),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 streamTypeStreamIdUq: uniqueIndex("EventStreamFloor_stream_type_stream_id_uq").on(
 t.streamType,
 t.streamId,
 ),
 tenantIdx: index("EventStreamFloor_tenant_idx").on(t.tenantId),
 }),
);

export type EventStreamFloor = InferSelectModel<typeof eventStreamFloorTable>;
export type NewEventStreamFloor = InferInsertModel<typeof eventStreamFloorTable>;

// ─── Thread List Projection ────────────────────────────────

/**
 * Thread 列表投影：员工会话列表查询读模型。
 *
 * 事实源：§11 行 703（thread + 最近 Item + 未读游标 + 当前 Turn）、§11 行 716 业务例子。
 * - 可重建，非权威写表；投影器按 event sequence 幂等更新。
 * - 员工会话列表不 join 全部 Event，读取本投影（§11 行 716）。
 */
export const threadListProjectionTable = mysqlTable(
 "ThreadListProjection",
 {
 threadId: varchar("threadId", { length: 36 }).primaryKey().notNull(),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 ownerUserId: varchar("ownerUserId", { length: 36 }).notNull(),
 primaryAgentId: varchar("primaryAgentId", { length: 36 }).notNull(),
 title: text("title"),
 lifecycleState: varchar("lifecycleState", { length: 32 }).notNull().default("active"),
 lastActivityAt: datetime("lastActivityAt", { mode: "date", fsp: 3 }).notNull(),
 /** 最近 Item 摘要（用于列表预览）。 */
 lastItemSummary: text("lastItemSummary"),
 lastItemType: varchar("lastItemType", { length: 32 }),
 lastItemSequence: bigint("lastItemSequence", { mode: "number" }),
 lastItemAuthorType: varchar("lastItemAuthorType", { length: 32 }),
 lastItemCreatedAt: datetime("lastItemCreatedAt", { mode: "date", fsp: 3 }),
 /** 当前 Turn 概要。 */
 currentTurnId: varchar("currentTurnId", { length: 36 }),
 currentTurnSequence: bigint("currentTurnSequence", { mode: "number" }),
 currentTurnState: varchar("currentTurnState", { length: 32 }),
 /** 最新 event sequence（latest_event_cursor 的一部分）。 */
 latestEventSequence: bigint("latestEventSequence", { mode: "number" }).notNull().default(0),
 latestEventId: varchar("latestEventId", { length: 36 }),
 /** 是否有未读事件（简化标记，完整未读游标在用户偏好中维护）。 */
 hasUnreadEvents: int("hasUnreadEvents").notNull().default(0),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
 },
 (t) => ({
 tenantOwnerActivityIdx: index("ThreadListProjection_tenant_owner_activity_idx").on(
 t.tenantId,
 t.ownerUserId,
 t.lastActivityAt,
 ),
 tenantAgentActivityIdx: index("ThreadListProjection_tenant_agent_activity_idx").on(
 t.tenantId,
 t.primaryAgentId,
 t.lastActivityAt,
 ),
 tenantLifecycleIdx: index("ThreadListProjection_tenant_lifecycle_idx").on(
 t.tenantId,
 t.lifecycleState,
 ),
 }),
);

export type ThreadListProjection = InferSelectModel<typeof threadListProjectionTable>;
export type NewThreadListProjection = InferInsertModel<typeof threadListProjectionTable>;

// ─── Turn Timeline Projection ──────────────────────────────

/**
 * Turn 时间线投影：员工会话时间线查询读模型。
 *
 * 事实源：§11 行 704（turn + Item + Event + UserActionRequest）。
 * - 每行代表一个 Turn 的当前投影状态，包含触发 Item 和最终 Item 摘要。
 * - 可重建，非权威写表；投影器按 event sequence 幂等更新。
 */
export const turnTimelineProjectionTable = mysqlTable(
 "TurnTimelineProjection",
 {
 turnId: varchar("turnId", { length: 36 }).primaryKey().notNull(),
 threadId: varchar("threadId", { length: 36 }).notNull(),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 turnSequence: bigint("turnSequence", { mode: "number" }).notNull(),
 turnState: varchar("turnState", { length: 32 }).notNull().default("accepted"),
 triggerType: varchar("triggerType", { length: 32 }).notNull(),
 /** 触发 Item（通常是 user_message）。 */
 triggerItemId: varchar("triggerItemId", { length: 36 }),
 triggerItemType: varchar("triggerItemType", { length: 32 }),
 triggerItemSummary: text("triggerItemSummary"),
 triggerItemCreatedAt: datetime("triggerItemCreatedAt", { mode: "date", fsp: 3 }),
 /** 最终 Item（agent_message 或 job_result）。 */
 finalItemId: varchar("finalItemId", { length: 36 }),
 finalItemType: varchar("finalItemType", { length: 32 }),
 finalItemSummary: text("finalItemSummary"),
 finalItemCreatedAt: datetime("finalItemCreatedAt", { mode: "date", fsp: 3 }),
 /** Turn 内 Item 数量。 */
 itemCount: int("itemCount").notNull().default(0),
 /** 最近 Item 摘要（不限触发/最终）。 */
 lastItemSummary: text("lastItemSummary"),
 lastItemType: varchar("lastItemType", { length: 32 }),
 lastItemSequence: bigint("lastItemSequence", { mode: "number" }),
 lastItemCreatedAt: datetime("lastItemCreatedAt", { mode: "date", fsp: 3 }),
 acceptedAt: datetime("acceptedAt", { mode: "date", fsp: 3 }).notNull(),
 startedAt: datetime("startedAt", { mode: "date", fsp: 3 }),
 waitingAt: datetime("waitingAt", { mode: "date", fsp: 3 }),
 finishedAt: datetime("finishedAt", { mode: "date", fsp: 3 }),
 errorCode: varchar("errorCode", { length: 128 }),
 regenerationNo: bigint("regenerationNo", { mode: "number" }).notNull().default(0),
 /** 本 Turn 投影已消费到的最大 event sequence。 */
 latestEventSequence: bigint("latestEventSequence", { mode: "number" }).notNull().default(0),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
 },
 (t) => ({
 threadSequenceUq: uniqueIndex("TurnTimelineProjection_thread_sequence_uq").on(
 t.threadId,
 t.turnSequence,
 ),
 tenantThreadSequenceIdx: index("TurnTimelineProjection_tenant_thread_sequence_idx").on(
 t.tenantId,
 t.threadId,
 t.turnSequence,
 ),
 threadStateIdx: index("TurnTimelineProjection_thread_state_idx").on(t.threadId, t.turnState),
 }),
);

export type TurnTimelineProjection = InferSelectModel<typeof turnTimelineProjectionTable>;
export type NewTurnTimelineProjection = InferInsertModel<typeof turnTimelineProjectionTable>;
