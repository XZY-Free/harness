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
    /** 目标判别：runtime 时非空、agent 时为空。与 Agent 事实组互斥（CHECK）。 */
    runtimeRevisionId: varchar("runtimeRevisionId", { length: 36 }),
    // ─── Agent Route 生产调用事实──
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
    // 恰好一个目标组合法（判别联合）：runtime 组或 agent 组，不允许混合/不完整组。
    exactTargetGroupCheck: check(
      "RouteRevision_exact_target_group_check",
      sql`(
        (\`runtimeRevisionId\` IS NOT NULL AND TRIM(\`runtimeRevisionId\`) <> ''
          AND \`agentRevisionId\` IS NULL
          AND \`agentEndpointRef\` IS NULL
          AND \`agentIdentityMode\` IS NULL
          AND \`agentCredentialRefId\` IS NULL
          AND \`agentNetworkZone\` IS NULL)
        OR
        (\`runtimeRevisionId\` IS NULL
          AND \`agentRevisionId\` IS NOT NULL AND TRIM(\`agentRevisionId\`) <> ''
          AND \`agentEndpointRef\` IS NOT NULL AND TRIM(\`agentEndpointRef\`) <> ''
          AND \`agentIdentityMode\` IN ('none','bearer')
          AND \`agentNetworkZone\` IS NOT NULL AND TRIM(\`agentNetworkZone\`) <> ''
          AND (
            (\`agentIdentityMode\` = 'bearer' AND \`agentCredentialRefId\` IS NOT NULL AND TRIM(\`agentCredentialRefId\`) <> '')
            OR
            (\`agentIdentityMode\` = 'none' AND (\`agentCredentialRefId\` IS NULL OR TRIM(\`agentCredentialRefId\`) <> ''))
          ))
      )`,
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

// ─── Target 分支映射（不改 schema）──────────────────────
// 存储列仍是 nullable target-specific（runtime 组 vs agent 组互斥 CHECK），
// 这里提供唯一权威映射：DB 记录 → domain target 判别联合。
// 仅用于内部把 existing record 转回 domain content，不得回到二义 flat 形状。

import type { RouteRevisionTarget } from "@/lib/routes/domain/route-revision";

/**
 * 从 RouteRevisionRecord 派生其 target 判别联合。
 *
 * 只有完整互斥事实才返回 target；混合、空白、缺字段、非法 identity、bearer 无
 * credential 均返回 null，调用方 fail-closed。不得制造空字符串 / none placeholder。
 *
 * - runtime 分支：runtimeRevisionId 非空，且不携带任何 Agent 事实。
 * - agent 分支：agentRevisionId + endpoint + network 非空、identity 合法，
 *   bearer 必须冻结 credential，none 允许 null 或合法非空。
 */
export function routeRevisionTargetFromRecord(
  record: RouteRevisionRecord,
): RouteRevisionTarget | null {
  const agentRevisionId = record.agentRevisionId;
  const runtimeRevisionId = record.runtimeRevisionId;

  const agentPresent = agentRevisionId !== null && agentRevisionId.trim() !== "";
  const runtimePresent = runtimeRevisionId !== null && runtimeRevisionId.trim() !== "";
  // 恰好一个目标组（互斥）；同时存在 / 同时缺失 → 畸形。
  if (agentPresent === runtimePresent) return null;

  if (runtimePresent) {
    const normalizedRuntimeRevisionId = runtimeRevisionId?.trim();
    if (!normalizedRuntimeRevisionId) return null;
    // runtime 分支不得携带任何 Agent 事实（即便占位）。
    if (
      record.agentRevisionId !== null ||
      record.agentEndpointRef !== null ||
      record.agentIdentityMode !== null ||
      record.agentCredentialRefId !== null ||
      record.agentNetworkZone !== null
    ) {
      return null;
    }
    return { kind: "runtime", runtimeRevisionId: normalizedRuntimeRevisionId };
  }

  // agent 分支：完整冻结 endpoint/identity/credential/network，缺一不可。
  const normalizedAgentRevisionId = agentRevisionId?.trim();
  const endpointRef = record.agentEndpointRef?.trim();
  const networkZone = record.agentNetworkZone?.trim();
  const identityMode = record.agentIdentityMode;
  if (
    !normalizedAgentRevisionId ||
    !endpointRef ||
    !networkZone ||
    (identityMode !== "none" && identityMode !== "bearer")
  ) {
    return null;
  }
  if (identityMode === "bearer") {
    if (!(record.agentCredentialRefId !== null && record.agentCredentialRefId.trim() !== "")) {
      return null;
    }
  } else if (record.agentCredentialRefId !== null && record.agentCredentialRefId.trim() === "") {
    return null;
  }

  return {
    kind: "agent",
    agentRevisionId: normalizedAgentRevisionId,
    agentEndpointRef: endpointRef,
    agentIdentityMode: identityMode,
    agentCredentialRefId:
      record.agentCredentialRefId !== null && record.agentCredentialRefId.trim() !== ""
        ? record.agentCredentialRefId.trim()
        : null,
    agentNetworkZone: networkZone,
  };
}
