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

export const routeRevision = mysqlTable(
  "RouteRevision",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    routeId: varchar("routeId", { length: 36 }).notNull(),
    routeSetId: varchar("routeSetId", { length: 36 }).notNull(),
    revisionNo: bigint("revisionNo", { mode: "number", unsigned: true }).notNull(),
    agentRevisionId: varchar("agentRevisionId", { length: 36 }).notNull(),
    runtimeRevisionId: varchar("runtimeRevisionId", { length: 36 }).notNull(),
    policyRevisionId: varchar("policyRevisionId", { length: 36 }),
    modelPolicyRevisionId: varchar("modelPolicyRevisionId", { length: 36 }),
    toolsetRevisionId: varchar("toolsetRevisionId", { length: 36 }),
    trafficAllocationJson: json("trafficAllocationJson").notNull(),
    /** Route Group 标识 — 同 Group 成员必须相同 eligibilityConditions、priorityNo、specificity、effectiveFrom、effectiveUntil。 */
    routeGroupId: varchar("routeGroupId", { length: 128 }),
    /** Selector Digest — 由 RouteSelector.computeSelectorDigest 计算，含算法版本。 */
    selectorDigest: varchar("selectorDigest", { length: 71 }),
    trafficWeight: int("trafficWeight").notNull(),
    priorityNo: int("priorityNo").notNull(),
    effectiveFrom: datetime("effectiveFrom", { mode: "date", fsp: 3 }),
    effectiveUntil: datetime("effectiveUntil", { mode: "date", fsp: 3 }),
    eligibilityConditionsJson: json("eligibilityConditionsJson").notNull(),
    contentDigest: varchar("contentDigest", { length: 71 }).notNull(),
    createdByType: mysqlEnum("createdByType", ["user", "service", "workload", "system"]).notNull(),
    createdBy: varchar("createdBy", { length: 128 }).notNull(),
    validatedAt: datetime("validatedAt", { mode: "date", fsp: 3 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => ({
    routeRevisionNoUq: uniqueIndex("RouteRevision_route_revisionNo_uq").on(
      table.routeId,
      table.revisionNo,
    ),
    routeContentUq: uniqueIndex("RouteRevision_route_content_uq").on(
      table.routeId,
      table.contentDigest,
    ),
    routeSetIdx: index("RouteRevision_routeSet_idx").on(table.routeSetId, table.createdAt),
    routeSetGroupIdTmpIdx: index("RouteRevision_routeSetId_routeGroupId_tmp_idx").on(
      table.routeSetId,
      table.routeGroupId,
    ),
    routeSetSelectorDigestTmpIdx: index("RouteRevision_routeSetId_selectorDigest_tmp_idx").on(
      table.routeSetId,
      table.selectorDigest,
    ),
  }),
);

export const routeActivation = mysqlTable(
  "RouteActivation",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    routeId: varchar("routeId", { length: 36 }).notNull(),
    routeRevisionId: varchar("routeRevisionId", { length: 36 }).notNull(),
    /** 派生冗余列 — 始终 = 对应 RouteRevision.routeSetId，写入服务负责派生和断言。 */
    routeSetId: varchar("routeSetId", { length: 36 }),
    activationSequence: bigint("activationSequence", { mode: "number", unsigned: true }).notNull(),
    activationState: mysqlEnum("activationState", ["active", "disabled"]).notNull(),
    previousRouteRevisionId: varchar("previousRouteRevisionId", { length: 36 }),
    routeSetVersionNo: bigint("routeSetVersionNo", { mode: "number", unsigned: true }).notNull(),
    activatedByType: mysqlEnum("activatedByType", [
      "user",
      "service",
      "workload",
      "system",
    ]).notNull(),
    activatedBy: varchar("activatedBy", { length: 128 }).notNull(),
    reason: text("reason").notNull(),
    requestId: varchar("requestId", { length: 64 }).notNull(),
    idempotencyKey: varchar("idempotencyKey", { length: 256 }).notNull(),
    activatedAt: datetime("activatedAt", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => ({
    routeSequenceUq: uniqueIndex("RouteActivation_route_sequence_uq").on(
      table.routeId,
      table.activationSequence,
    ),
    routeIdempotencyUq: uniqueIndex("RouteActivation_route_idempotency_uq").on(
      table.routeId,
      table.idempotencyKey,
    ),
    revisionActivatedIdx: index("RouteActivation_revision_activated_idx").on(
      table.routeRevisionId,
      table.activatedAt,
    ),
    routeSetIdTmpIdx: index("RouteActivation_routeSetId_tmp_idx").on(table.routeSetId),
  }),
);

export type RouteRevisionRecord = InferSelectModel<typeof routeRevision>;
export type NewRouteRevisionRecord = InferInsertModel<typeof routeRevision>;
export type RouteActivationRecord = InferSelectModel<typeof routeActivation>;
export type NewRouteActivationRecord = InferInsertModel<typeof routeActivation>;
