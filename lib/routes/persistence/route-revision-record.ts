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
    /** Route 稳定身份键 — 派生冗余列，始终 = 对应 DeploymentRoute.routeKey。 */
    routeKey: varchar("routeKey", { length: 128 }).notNull(),
    revisionNo: bigint("revisionNo", { mode: "number", unsigned: true }).notNull(),
    /**
     * 绑定的 AgentRevision ID。
     * null = 基础 Harness Route（无 Agent 资产约束）；有值 = Agent Route。
     */
    agentRevisionId: varchar("agentRevisionId", { length: 36 }),
    runtimeRevisionId: varchar("runtimeRevisionId", { length: 36 }).notNull(),
    // ─── Agent Route 生产调用事实（专题01 Batch4 补漏，02 §12.2/12.3）──
    // Agent Route 冻结 endpoint/identity/credential/network；基础 Harness Route 为 null。
    agentEndpointRef: varchar("agentEndpointRef", { length: 512 }),
    agentIdentityMode: mysqlEnum("agentIdentityMode", ["none", "bearer"]),
    agentCredentialRefId: varchar("agentCredentialRefId", { length: 36 }),
    agentNetworkZone: varchar("agentNetworkZone", { length: 32 }),
    policyRevisionId: varchar("policyRevisionId", { length: 36 }),
    modelPolicyRevisionId: varchar("modelPolicyRevisionId", { length: 36 }),
    toolsetRevisionId: varchar("toolsetRevisionId", { length: 36 }),
    trafficAllocationJson: json("trafficAllocationJson").notNull(),
    /** Route Group 标识 — 同 Group 成员必须相同 eligibilityConditions、priorityNo、specificity、effectiveFrom、effectiveUntil。 */
    routeGroupId: varchar("routeGroupId", { length: 128 }).notNull().default("primary"),
    /** Selector Digest — 由 RouteSelector.computeSelectorDigest 计算，含算法版本。 */
    selectorDigest: varchar("selectorDigest", { length: 71 }).notNull(),
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
    routeSetGroupIdPriorityIdx: index("RouteRevision_routeSetId_routeGroupId_priorityNo_idx").on(
      table.routeSetId,
      table.routeGroupId,
      table.priorityNo,
    ),
    routeSetSelectorDigestPriorityIdx: index(
      "RouteRevision_routeSetId_selectorDigest_priorityNo_idx",
    ).on(table.routeSetId, table.selectorDigest, table.priorityNo),
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
    routeSetId: varchar("routeSetId", { length: 36 }).notNull(),
    activationSequence: bigint("activationSequence", { mode: "number", unsigned: true }).notNull(),
    activationState: mysqlEnum("activationState", ["active", "disabled"]).notNull(),
    previousRouteRevisionId: varchar("previousRouteRevisionId", { length: 36 }),
    /** 前一个 RouteActivation ID — 完整 Activation 历史链路。 */
    previousRouteActivationId: varchar("previousRouteActivationId", { length: 36 }),
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
    // RouteSet 聚合更新按 routeSetId + idempotencyKey 保证幂等。
    routeSetIdempotencyUq: uniqueIndex("RouteActivation_routeSet_idempotency_uq").on(
      table.routeSetId,
      table.idempotencyKey,
    ),
    revisionActivatedIdx: index("RouteActivation_revision_activated_idx").on(
      table.routeRevisionId,
      table.activatedAt,
    ),
    routeSetVersionIdx: index("RouteActivation_routeSetId_routeSetVersionNo_idx").on(
      table.routeSetId,
      table.routeSetVersionNo,
    ),
  }),
);

export type RouteRevisionRecord = InferSelectModel<typeof routeRevision>;
export type NewRouteRevisionRecord = InferInsertModel<typeof routeRevision>;
export type RouteActivationRecord = InferSelectModel<typeof routeActivation>;
export type NewRouteActivationRecord = InferInsertModel<typeof routeActivation>;
