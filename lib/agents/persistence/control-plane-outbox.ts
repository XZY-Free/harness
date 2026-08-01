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
    eventKey: varchar("eventKey", { length: 256 }).notNull(),
    eventType: varchar("eventType", { length: 128 }).notNull(),
    aggregateType: varchar("aggregateType", { length: 64 }).notNull(),
    aggregateId: varchar("aggregateId", { length: 128 }).notNull(),
    payloadJson: json("payloadJson").notNull(),
    occurredAt: datetime("occurredAt", { mode: "date", fsp: 3 }).notNull(),
    publishedAt: datetime("publishedAt", { mode: "date", fsp: 3 }),
    attemptCount: int("attemptCount").notNull().default(0),
  },
  (table) => ({
    eventKeyUq: uniqueIndex("ControlPlaneOutboxEvent_eventKey_uq").on(table.eventKey),
    unpublishedIdx: index("ControlPlaneOutboxEvent_unpublished_idx").on(
      table.publishedAt,
      table.occurredAt,
    ),
    aggregateIdx: index("ControlPlaneOutboxEvent_aggregate_idx").on(
      table.aggregateType,
      table.aggregateId,
    ),
  }),
);

export type ControlPlaneOutboxEvent = InferSelectModel<typeof controlPlaneOutboxEvent>;
export type NewControlPlaneOutboxEvent = InferInsertModel<typeof controlPlaneOutboxEvent>;
