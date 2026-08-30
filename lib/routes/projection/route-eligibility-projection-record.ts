/**
 * RouteEligibilityProjection — 路由资格投影表。
 *
 * 这是可重建的读取投影，不是权威事实源。
 * 权威事实源为 RouteRevision, RouteActivation, PublicationRecord 等原表。
 *
 * Resolver 从此表一次查询候选，纯内存选择。
 * Binding 仍需对权威事实做最终 Fail-closed 校验。
 *
 * 专题01 冻结架构（01 §4.D）：单一投影必须显式携带 targetKind + targetIdentity。
 * Agent target 与 Runtime target 证据组互斥：target 不相关的一组必须全 NULL，
 * 禁止 "not_applicable"/"hosted_artifact"/0/空串 placeholder。
 */

import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  check,
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
    /** 显式目标类型 — runtime 或 agent（冻结架构，禁止隐式 null 猜测，无默认）。 */
    targetKind: mysqlEnum("targetKind", ["runtime", "agent"]).notNull(),
    /**
     * 目标唯一身份（非空、非空串）：
     * - runtime：固定 "runtime"。
     * - agent：= agentId。
     * 与 targetKind/agentId 一起被 CHECK 约束强制一致。
     */
    targetIdentity: varchar("targetIdentity", { length: 36 }).notNull(),
    /**
     * 归属 Agent ID。
     * runtime 时 null；agent 时非空且 = targetIdentity。一致性由 CHECK 保证。
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

    // ─── Agent 侧资格（agent target 可有；runtime target 必须全 NULL）──
    agentRevisionId: varchar("agentRevisionId", { length: 36 }),
    // Agent Route 生产调用事实。
    agentEndpointRef: varchar("agentEndpointRef", { length: 512 }),
    agentIdentityMode: mysqlEnum("agentIdentityMode", ["none", "bearer"]),
    agentCredentialRefId: varchar("agentCredentialRefId", { length: 36 }),
    agentNetworkZone: varchar("agentNetworkZone", { length: 32 }),
    agentRevisionState: varchar("agentRevisionState", { length: 32 }),
    agentLifecycleState: varchar("agentLifecycleState", { length: 32 }),
    /** 1=Publication活跃, 0=否；agent target 可有，runtime target NULL。 */
    agentPublicationActive: int("agentPublicationActive"),
    /** 1=证据有效, 0=否；agent target 可有，runtime target NULL。 */
    agentEvidenceValid: int("agentEvidenceValid"),
    agentPublicationRecordId: varchar("agentPublicationRecordId", { length: 36 }),
    agentContractSnapshotId: varchar("agentContractSnapshotId", { length: 36 }),
    agentContractDigest: varchar("agentContractDigest", { length: 71 }),
    agentContextDigest: varchar("agentContextDigest", { length: 71 }),

    // ─── Runtime 侧资格（runtime target 可有；agent target 必须全 NULL）──
    runtimeRevisionId: varchar("runtimeRevisionId", { length: 36 }),
    runtimeRevisionState: varchar("runtimeRevisionState", { length: 32 }),
    runtimeLifecycleState: varchar("runtimeLifecycleState", { length: 32 }),
    /** 1=Publication活跃, 0=否；runtime target 可有，agent target NULL。 */
    runtimePublicationActive: int("runtimePublicationActive"),
    /** 1=证据有效, 0=否；runtime target 可有，agent target NULL。 */
    runtimeEvidenceValid: int("runtimeEvidenceValid"),
    /** 1=Conformance通过, 0=否；runtime target 可有，agent target NULL。 */
    runtimeConformanceValid: int("runtimeConformanceValid"),
    /** Runtime 证据种类 — hosted/external；agent target NULL。 */
    runtimeEvidenceKind: mysqlEnum("runtimeEvidenceKind", ["hosted_artifact", "external_endpoint"]),
    runtimePublicationRecordId: varchar("runtimePublicationRecordId", { length: 36 }),
    runtimeAttestationIds: json("runtimeAttestationIds").$type<string[]>(),
    conformanceRunId: varchar("conformanceRunId", { length: 36 }),
    runtimeArtifactId: varchar("runtimeArtifactId", { length: 36 }),
    runtimeArtifactDigest: varchar("runtimeArtifactDigest", { length: 71 }),
    runtimeConfigDigest: varchar("runtimeConfigDigest", { length: 71 }),
    /** Runtime 目标摘要 — 发布证据权威（03 §6）。 */
    runtimeTargetDigest: varchar("runtimeTargetDigest", { length: 71 }),
    /** 兼容性摘要 — 仅 runtime target 计算；agent target NULL。 */
    capabilityCompatibilityDigest: varchar("capabilityCompatibilityDigest", { length: 71 }),

    // ─── Policy（公共语义，两 target 皆可有）─────
    policyRevisionId: varchar("policyRevisionId", { length: 36 }),
    policyRevisionState: varchar("policyRevisionState", { length: 32 }),

    // ─── 证据摘要与状态 ───────────────────────────
    sourceEventId: varchar("sourceEventId", { length: 36 }),
    sourceAggregateVersion: int("sourceAggregateVersion"),
    invalidReason: varchar("invalidReason", { length: 255 }),
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

    // ─── 冻结架构约束 ─────────────────────────────
    // targetIdentity 非空。
    targetIdentityCheck: check(
      "RouteEligibilityProjection_target_identity_check",
      sql`TRIM(\`targetIdentity\`) <> ''`,
    ),
    // targetKind/targetIdentity/agentId 一致（判别联合）。
    targetConsistencyCheck: check(
      "RouteEligibilityProjection_target_consistency_check",
      sql`(
        (\`targetKind\` = 'runtime' AND \`targetIdentity\` = 'runtime' AND \`agentId\` IS NULL)
        OR
        (\`targetKind\` = 'agent' AND \`targetIdentity\` = \`agentId\`
          AND \`agentId\` IS NOT NULL AND TRIM(\`agentId\`) <> '')
      )`,
    ),
    // 两组 exact-one 互斥：agent target 时 runtime 组全 NULL；runtime target 时 agent 组全 NULL。
    targetGroupExclusionCheck: check(
      "RouteEligibilityProjection_target_group_exclusion_check",
      sql`(
        (\`targetKind\` = 'agent'
          AND \`agentRevisionId\` IS NOT NULL AND TRIM(\`agentRevisionId\`) <> ''
          AND \`runtimeRevisionId\` IS NULL
          AND \`runtimeRevisionState\` IS NULL
          AND \`runtimeLifecycleState\` IS NULL
          AND \`runtimePublicationActive\` IS NULL
          AND \`runtimeEvidenceValid\` IS NULL
          AND \`runtimeConformanceValid\` IS NULL
          AND \`runtimeEvidenceKind\` IS NULL
          AND \`runtimePublicationRecordId\` IS NULL
          AND \`runtimeAttestationIds\` IS NULL
          AND \`conformanceRunId\` IS NULL
          AND \`runtimeArtifactId\` IS NULL
          AND \`runtimeArtifactDigest\` IS NULL
          AND \`runtimeConfigDigest\` IS NULL
          AND \`runtimeTargetDigest\` IS NULL
          AND \`capabilityCompatibilityDigest\` IS NULL)
        OR
        (\`targetKind\` = 'runtime'
          AND \`runtimeRevisionId\` IS NOT NULL AND TRIM(\`runtimeRevisionId\`) <> ''
          AND \`agentRevisionId\` IS NULL
          AND \`agentEndpointRef\` IS NULL
          AND \`agentIdentityMode\` IS NULL
          AND \`agentCredentialRefId\` IS NULL
          AND \`agentNetworkZone\` IS NULL
          AND \`agentRevisionState\` IS NULL
          AND \`agentLifecycleState\` IS NULL
          AND \`agentPublicationActive\` IS NULL
          AND \`agentEvidenceValid\` IS NULL
          AND \`agentPublicationRecordId\` IS NULL
          AND \`agentContractSnapshotId\` IS NULL
          AND \`agentContractDigest\` IS NULL
          AND \`agentContextDigest\` IS NULL)
      )`,
    ),
  }),
);

export type RouteEligibilityProjectionRecord = InferSelectModel<typeof routeEligibilityProjection>;
export type NewRouteEligibilityProjectionRecord = InferInsertModel<
  typeof routeEligibilityProjection
>;
