/**
 * §3.3: ControlPlaneEventDelivery — 多消费者 Delivery 模型。
 *
 * 每个消费者独立跟踪事件投递状态。
 * ControlPlaneOutboxEvent 保持不可变事件事实。
 * 不再用一个全局 publishedAt 表示所有消费者完成。
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  datetime,
  index,
  int,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/** Delivery 状态。 */
export type DeliveryState = "pending" | "running" | "completed" | "dead_lettered";

export const controlPlaneEventDelivery = mysqlTable(
  "ControlPlaneEventDelivery",
  {
    /** 行 ID（UUID）。 */
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    /** 关联的 Outbox 事件 ID。 */
    eventId: varchar("eventId", { length: 36 }).notNull(),
    /** 消费者名称（如 "route_projection", "cache_invalidation"）。 */
    consumerName: varchar("consumerName", { length: 128 }).notNull(),
    /** 投递状态。 */
    state: varchar("state", { length: 32 }).notNull().default("pending"),
    /** 尝试次数。 */
    attemptCount: int("attemptCount").notNull().default(0),
    /** 下次重试时间。 */
    nextAttemptAt: datetime("nextAttemptAt", { mode: "date", fsp: 3 }),
    /** 当前持有租约的 Worker ID。 */
    lockedBy: varchar("lockedBy", { length: 128 }),
    /** 租约过期时间。 */
    lockExpiresAt: datetime("lockExpiresAt", { mode: "date", fsp: 3 }),
    /** 最近一次错误码。 */
    lastErrorCode: varchar("lastErrorCode", { length: 64 }),
    /** 最近一次错误描述。 */
    lastErrorSummary: text("lastErrorSummary"),
    /** 完成时间。 */
    completedAt: datetime("completedAt", { mode: "date", fsp: 3 }),
    /** 死信标记时间。 */
    deadLetteredAt: datetime("deadLetteredAt", { mode: "date", fsp: 3 }),
    /** 创建时间。 */
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => ({
    /** 每个 (eventId, consumerName) 组合唯一。 */
    eventConsumerUq: uniqueIndex("ControlPlaneEventDelivery_event_consumer_uq").on(
      table.eventId,
      table.consumerName,
    ),
    /** 领取索引：pending/running + 未过期 + 可尝试。 */
    claimableIdx: index("ControlPlaneEventDelivery_claimable_idx").on(
      table.state,
      table.consumerName,
      table.nextAttemptAt,
      table.lockExpiresAt,
    ),
  }),
);

export type ControlPlaneEventDelivery = InferSelectModel<typeof controlPlaneEventDelivery>;
export type NewControlPlaneEventDelivery = InferInsertModel<typeof controlPlaneEventDelivery>;
