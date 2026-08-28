/**
 * RouteEligibilityProjection — 路由资格投影表。
 *
 * 这是可重建的读取投影，不是权威事实源。
 * 权威事实源为 RouteRevision, RouteActivation, PublicationRecord 等原表。
 *
 * Resolver 从此表一次查询候选，纯内存选择。
 * Binding 仍需对权威事实做最终 Fail-closed 校验。
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const routeEligibilityProjection = mysqlTable(
  "RouteEligibilityProjection",
  {
    /** 路由 ID（与 DeploymentRoute.id 对应，业务主键）。 */
    routeId: varchar("routeId", { length: 36 }).primaryKey().notNull(),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    /** 显式目标类型 — runtime 或 agent（专题01 冻结架构，禁止隐式 null 猜测）。 */
    targetKind: mysqlEnum("targetKind", ["runtime", "agent"]).notNull().default("runtime"),
    /**
     * 归属 Agent ID。
     * runtime 时 null；agent 时非空。Resolver 按 target 命中此列 IS NULL / =agentId。
     */
    agentId: varchar("agentId", { length: 36 }),
    routeSetId: varchar("routeSetId", { length: 36 }).notNull(),
    routeScopeKey: varchar("routeScopeKey", { length: 128 }).notNull(),

    // ─── Route 版本快照 ────────────────────────────
    routeSetVersionNo: bigint("routeSetVersionNo", { mode: "number", unsigned: true }).notNull(),
    routeRevisionId: varchar("routeRevisionId", { length: 36 }).notNull(),
    routeRevisionNo: bigint("routeRevisionNo", { mode: "number", unsigned: true }).notNull(),
    routeActivationId: varchar("routeActivationId", { length: 36 }).notNull(),
    routeActivationSequence: bigint("routeActivationSequence", {
      mode: "number",
      unsigned: true,
    }).notNull(),
    activationState: mysqlEnum("activationState", ["active", "disabled"]).notNull(),

    // ─── 路由选择属性 ──────────────────────────────
    routeGroupId: varchar("routeGroupId", { length: 128 }).notNull(),
    selectorDigest: varchar("selectorDigest", { length: 71 }).notNull(),
    eligibilityConditionsJson: json("eligibilityConditionsJson").notNull(),
    specificity: int("specificity").notNull(),
    priorityNo: int("priorityNo").notNull(),
    trafficWeight: int("trafficWeight").notNull(),
    effectiveFrom: datetime("effectiveFrom", { mode: "date", fsp: 3 }),
    effectiveUntil: datetime("effectiveUntil", { mode: "date", fsp: 3 }),

    // ─── Agent 侧资格 ─────────────────────────────
    /**
     * 绑定的 AgentRevision ID。
     * null = 基础 Harness Route（无 Agent 资产约束），Agent Evidence 为 not_applicable。
     */
    agentRevisionId: varchar("agentRevisionId", { length: 36 }),
    agentRevisionState: varchar("agentRevisionState", { length: 32 }).notNull(),
    agentLifecycleState: varchar("agentLifecycleState", { length: 32 }).notNull(),
    /** 1=Publication活跃, 0=否。 */
    agentPublicationActive: int("agentPublicationActive").notNull(),
    /** 1=证据有效, 0=否。 */
    agentEvidenceValid: int("agentEvidenceValid").notNull(),

    // ─── Runtime 侧资格 ────────────────────────────
    runtimeRevisionId: varchar("runtimeRevisionId", { length: 36 }).notNull(),
    runtimeRevisionState: varchar("runtimeRevisionState", { length: 32 }).notNull(),
    runtimeLifecycleState: varchar("runtimeLifecycleState", { length: 32 }).notNull(),
    /** 1=Publication活跃, 0=否。 */
    runtimePublicationActive: int("runtimePublicationActive").notNull(),
    /** 1=证据有效, 0=否。 */
    runtimeEvidenceValid: int("runtimeEvidenceValid").notNull(),
    /** 1=Conformance通过, 0=否。 */
    runtimeConformanceValid: int("runtimeConformanceValid").notNull(),
    /** Runtime 证据种类 — hosted 要求 artifact 全集；external 无 artifact（03 §3）。 */
    runtimeEvidenceKind: mysqlEnum("runtimeEvidenceKind", [
      "hosted_artifact",
      "external_endpoint",
    ]).notNull(),

    // ─── Policy ───────────────────────────────────
    policyRevisionId: varchar("policyRevisionId", { length: 36 }),
    policyRevisionState: varchar("policyRevisionState", { length: 32 }),

    // ─── : 完整执行证据 ID（不可填空字符串）────────
    agentPublicationRecordId: varchar("agentPublicationRecordId", { length: 36 }),
    runtimePublicationRecordId: varchar("runtimePublicationRecordId", { length: 36 }),
    runtimeAttestationIds: json("runtimeAttestationIds").$type<string[]>(),
    conformanceRunId: varchar("conformanceRunId", { length: 36 }),
    runtimeArtifactId: varchar("runtimeArtifactId", { length: 36 }),
    sourceEventId: varchar("sourceEventId", { length: 36 }),
    sourceAggregateVersion: int("sourceAggregateVersion"),
    invalidReason: varchar("invalidReason", { length: 255 }),

    // ─── 证据摘要（用于 Binding 快速校验）────────
    /** 兼容性摘要 — 由 computeCapabilityCompatibilityDigest 计算。 */
    capabilityCompatibilityDigest: varchar("capabilityCompatibilityDigest", {
      length: 71,
    }).notNull(),
    // ─── : Agent Contract 证据（Agent Route 必填，base route 为 null — 05 §5）────
    agentContractSnapshotId: varchar("agentContractSnapshotId", { length: 36 }),
    agentContractDigest: varchar("agentContractDigest", { length: 71 }),
    agentContextDigest: varchar("agentContextDigest", { length: 71 }),
    runtimeArtifactDigest: varchar("runtimeArtifactDigest", { length: 71 }),
    runtimeConfigDigest: varchar("runtimeConfigDigest", { length: 71 }),
    /** Runtime 目标摘要 — 发布证据权威（03 §6）。 */
    runtimeTargetDigest: varchar("runtimeTargetDigest", { length: 71 }),
    /** Route 内容摘要 — 冻结到 Binding。 */
    routeContentDigest: varchar("routeContentDigest", { length: 71 }).notNull(),

    // ─── 投影状态 ─────────────────────────────────
    eligibilityState: mysqlEnum("eligibilityState", [
      "eligible",
      "ineligible",
      "pending_rebuild",
    ]).notNull(),

    /** 投影内容摘要 — 用于幂等版本判断。 */
    projectionContentDigest: varchar("projectionContentDigest", {
      length: 71,
    }).notNull(),
    /** 投影版本号 — digest 变化时递增，相同 digest 不增加。 */
    projectionVersionNo: bigint("projectionVersionNo", {
      mode: "number",
      unsigned: true,
    }).notNull(),
    lastRebuiltAt: datetime("lastRebuiltAt", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => ({
    // 唯一索引：RouteRevision + RouteActivation 对应唯一投影
    revisionActivationUq: uniqueIndex("RouteEligibilityProjection_revision_activation_uq").on(
      table.routeRevisionId,
      table.routeActivationId,
    ),
    // Resolver 查询索引：按 tenantId + agentId + routeScopeKey + eligibilityState 一次命中
    tenantAgentScopeIdx: index("RouteEligibilityProjection_tenant_agent_scope_idx").on(
      table.tenantId,
      table.agentId,
      table.routeScopeKey,
      table.eligibilityState,
    ),
    // RouteSet 版本索引
    routeSetVersionIdx: index("RouteEligibilityProjection_routeSet_version_idx").on(
      table.routeSetId,
      table.routeSetVersionNo,
    ),
    // 选择属性索引：Group + Selector + Priority
    groupSelectorPriorityIdx: index("RouteEligibilityProjection_group_selector_priority_idx").on(
      table.routeGroupId,
      table.selectorDigest,
      table.priorityNo,
    ),
    // 租户索引
    tenantIdx: index("RouteEligibilityProjection_tenant_idx").on(table.tenantId),
  }),
);

export type RouteEligibilityProjectionRecord = InferSelectModel<typeof routeEligibilityProjection>;
export type NewRouteEligibilityProjectionRecord = InferInsertModel<
  typeof routeEligibilityProjection
>;
