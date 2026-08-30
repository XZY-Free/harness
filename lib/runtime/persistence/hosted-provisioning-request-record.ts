/**
 * HostedProvisioningRequest 的 Drizzle 表定义。
 *
 * Runtime-only Authority：只供应 tenant 内 builtin Harness Runtime。
 * - 身份权威 (tenantId, routeScopeKey)，唯一键恰好为该两列；非空 requesterId 供首次
 *   创建 Runtime 记录 owner。
 * - 删除 agentId / agentRevisionId / desiredRuntimeKey（Agent 黑盒、可选 Runtime key）。
 * - 删除 Agent publication checkpoint（stepAgentRevisionId / stepAgentPublicationRecordId）。
 * 删除 waiting_external_evidence / waiting_conformance 状态。
 * 保留 runtime/route checkpoint 字段。
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/** 只保留 6 个有效状态。 */
export const PROVISIONING_STATES = [
  "pending",
  "running",
  "ready",
  "retryable_failed",
  "permanent_failed",
  "cancelled",
] as const;

export const hostedProvisioningRequestTable = mysqlTable(
  "HostedProvisioningRequest",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    /** 首次创建请求的 actor（首次创建 Runtime 记录 owner）。非空。 */
    requesterId: varchar("requesterId", { length: 36 }).notNull(),
    routeScopeKey: varchar("routeScopeKey", { length: 64 }).notNull(),
    state: mysqlEnum("state", [...PROVISIONING_STATES])
      .notNull()
      .default("pending"),
    currentStep: varchar("currentStep", { length: 64 }),
    attemptCount: int("attemptCount").notNull().default(0),
    nextAttemptAt: datetime("nextAttemptAt", { mode: "date", fsp: 3 }),
    leaseOwner: varchar("leaseOwner", { length: 128 }),
    leaseExpiresAt: datetime("leaseExpiresAt", { mode: "date", fsp: 3 }),
    lastError: varchar("lastError", { length: 512 }),
    lastAttemptAt: datetime("lastAttemptAt", { mode: "date", fsp: 3 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 }).notNull(),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 }).notNull(),

    // ─── : Step Checkpoint 字段（runtime/route；不含 Agent）────────
    stepRuntimeId: varchar("stepRuntimeId", { length: 36 }),
    stepRuntimeRevisionId: varchar("stepRuntimeRevisionId", { length: 36 }),
    stepRuntimeArtifactId: varchar("stepRuntimeArtifactId", { length: 36 }),
    /** JSON array of attestation IDs。 */
    stepRuntimeAttestationIds: json("stepRuntimeAttestationIds").$type<string[] | null>(),
    stepRuntimePublicationRecordId: varchar("stepRuntimePublicationRecordId", { length: 36 }),
    stepConformanceRunId: varchar("stepConformanceRunId", { length: 36 }),
    stepRouteSetId: varchar("stepRouteSetId", { length: 36 }),
    stepRouteSetVersionNo: int("stepRouteSetVersionNo"),
    stepRouteId: varchar("stepRouteId", { length: 36 }),
    stepRouteRevisionId: varchar("stepRouteRevisionId", { length: 36 }),
    stepRouteActivationId: varchar("stepRouteActivationId", { length: 36 }),
    stepProjectionVersionNo: int("stepProjectionVersionNo"),
    /** 工作流版本标识。 */
    workflowVersion: varchar("workflowVersion", { length: 16 }).notNull().default("3.0"),
    /** 最近完成的步骤名称。 */
    lastCompletedStep: varchar("lastCompletedStep", { length: 64 }),
  },
  (table) => ({
    /** 同 (tenantId, routeScopeKey) 只能有一个供应请求。 */
    activeRequestUq: uniqueIndex("HostedProvisioningRequest_active_uq").on(
      table.tenantId,
      table.routeScopeKey,
    ),
    tenantIdx: index("HostedProvisioningRequest_tenantId_idx").on(table.tenantId),
    stateIdx: index("HostedProvisioningRequest_state_idx").on(table.state),
    /** Worker 领取索引：按状态+下次尝试+租约到期扫描。 */
    claimableIdx: index("HostedProvisioningRequest_claimable_idx").on(
      table.state,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
  }),
);

export type HostedProvisioningRequestRow = InferSelectModel<typeof hostedProvisioningRequestTable>;
export type NewHostedProvisioningRequestRow = InferInsertModel<
  typeof hostedProvisioningRequestTable
>;
