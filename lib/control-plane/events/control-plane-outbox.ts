/**
 * ControlPlaneOutboxEvent — 不可变事件事实表。
 *
 * §06.4: 消费状态字段（publishedAt, lockedBy, lockExpiresAt, attemptCount,
 * nextAttemptAt, lastErrorCode, lastErrorSummary, deadLetteredAt, maxAttempts）
 * 已移至 ControlPlaneEventDelivery 表。Outbox 表只保留不可变事件事实。
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  datetime,
  index,
  int,
  json,
  mysqlTable,
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
    /** §06.4: availableAt 保留 — 事件可用时间（延迟投递）。 */
    availableAt: datetime("availableAt", { mode: "date", fsp: 3 }),
  },
  (table) => ({
    eventKeyUq: uniqueIndex("ControlPlaneOutboxEvent_eventKey_uq").on(table.eventKey),
    aggregateIdx: index("ControlPlaneOutboxEvent_aggregate_idx").on(
      table.aggregateType,
      table.aggregateId,
      table.occurredAt,
    ),
  }),
);

export type ControlPlaneOutboxEvent = InferSelectModel<typeof controlPlaneOutboxEvent>;
export type NewControlPlaneOutboxEvent = InferInsertModel<typeof controlPlaneOutboxEvent>;
