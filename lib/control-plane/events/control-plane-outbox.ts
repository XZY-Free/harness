/**
 * ControlPlaneOutboxEvent — 扩展后的 Outbox 事件表。
 *
 * 第三批增加：领取（SKIP LOCKED）、租约、退避、死信模型。
 * 提供「至少一次投递 + 幂等消费者」语义。
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  datetime,
  index,
  int,
  json,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const controlPlaneOutboxEvent = mysqlTable(
  "ControlPlaneOutboxEvent",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    /** §3.1: 事件合同 Schema 版本（固定 "1.0"）。 */
    schemaVersion: varchar("schemaVersion", { length: 8 }).notNull().default("1.0"),
    eventKey: varchar("eventKey", { length: 256 }).notNull(),
    eventType: varchar("eventType", { length: 128 }).notNull(),
    aggregateType: varchar("aggregateType", { length: 64 }).notNull(),
    aggregateId: varchar("aggregateId", { length: 128 }).notNull(),
    /** §3.1: 聚合版本号（乐观锁，用于事件排序与去重）。 */
    aggregateVersion: int("aggregateVersion").notNull().default(0),
    payloadJson: json("payloadJson").notNull(),
    occurredAt: datetime("occurredAt", { mode: "date", fsp: 3 }).notNull(),
    publishedAt: datetime("publishedAt", { mode: "date", fsp: 3 }),
    attemptCount: int("attemptCount").notNull().default(0),

    // ─── 第三批新增字段 ──────────────────────────
    /** 事件可用时间（可用于延迟投递）。 */
    availableAt: datetime("availableAt", { mode: "date", fsp: 3 }),
    /** 下次重试时间。 */
    nextAttemptAt: datetime("nextAttemptAt", { mode: "date", fsp: 3 }),
    /** 当前持有租约的 Worker ID。 */
    lockedBy: varchar("lockedBy", { length: 128 }),
    /** 租约过期时间。 */
    lockExpiresAt: datetime("lockExpiresAt", { mode: "date", fsp: 3 }),
    /** 最近一次尝试时间。 */
    lastAttemptAt: datetime("lastAttemptAt", { mode: "date", fsp: 3 }),
    /** 最近一次错误码。 */
    lastErrorCode: varchar("lastErrorCode", { length: 64 }),
    /** 最近一次错误描述。 */
    lastErrorSummary: text("lastErrorSummary"),
    /** 死信标记时间 — 非null表示已进入死信。 */
    deadLetteredAt: datetime("deadLetteredAt", { mode: "date", fsp: 3 }),
    /** 最大尝试次数（默认从 Worker 配置继承）。 */
    maxAttempts: int("maxAttempts"),
  },
  (table) => ({
    eventKeyUq: uniqueIndex("ControlPlaneOutboxEvent_eventKey_uq").on(table.eventKey),
    // 领取索引：未发布 + 未死信 + 可尝试 + 可领取
    claimableIdx: index("ControlPlaneOutboxEvent_claimable_idx").on(
      table.publishedAt,
      table.deadLetteredAt,
      table.nextAttemptAt,
      table.lockExpiresAt,
    ),
    aggregateIdx: index("ControlPlaneOutboxEvent_aggregate_idx").on(
      table.aggregateType,
      table.aggregateId,
      table.occurredAt,
    ),
  }),
);

export type ControlPlaneOutboxEvent = InferSelectModel<typeof controlPlaneOutboxEvent>;
export type NewControlPlaneOutboxEvent = InferInsertModel<typeof controlPlaneOutboxEvent>;
