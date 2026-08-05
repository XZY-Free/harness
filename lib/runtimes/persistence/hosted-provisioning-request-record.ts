/**
 * HostedProvisioningRequest 的 Drizzle 表定义。
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  datetime,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const PROVISIONING_STATES = [
  "pending",
  "running",
  "waiting_external_evidence",
  "waiting_conformance",
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
    agentId: varchar("agentId", { length: 36 }).notNull(),
    agentRevisionId: varchar("agentRevisionId", { length: 36 }).notNull(),
    routeScopeKey: varchar("routeScopeKey", { length: 64 }).notNull(),
    desiredRuntimeKey: varchar("desiredRuntimeKey", { length: 64 }).notNull(),
    state: mysqlEnum("state", [...PROVISIONING_STATES]).notNull().default("pending"),
    currentStep: varchar("currentStep", { length: 64 }),
    attemptCount: int("attemptCount").notNull().default(0),
    nextAttemptAt: datetime("nextAttemptAt", { mode: "date", fsp: 3 }),
    leaseOwner: varchar("leaseOwner", { length: 128 }),
    leaseExpiresAt: datetime("leaseExpiresAt", { mode: "date", fsp: 3 }),
    lastError: varchar("lastError", { length: 512 }),
    lastAttemptAt: datetime("lastAttemptAt", { mode: "date", fsp: 3 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 }).notNull(),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 }).notNull(),

    // ─── §6.2: Step Checkpoint 字段 ────────────────────────
    stepAgentRevisionId: varchar("stepAgentRevisionId", { length: 36 }),
    stepAgentPublicationRecordId: varchar("stepAgentPublicationRecordId", { length: 36 }),
    stepAgentAttestationId: varchar("stepAgentAttestationId", { length: 36 }),
    stepRuntimeRevisionId: varchar("stepRuntimeRevisionId", { length: 36 }),
    stepRuntimePublicationRecordId: varchar("stepRuntimePublicationRecordId", { length: 36 }),
    stepRuntimeAttestationId: varchar("stepRuntimeAttestationId", { length: 36 }),
    stepConformanceRunId: varchar("stepConformanceRunId", { length: 36 }),
    stepRouteSetId: varchar("stepRouteSetId", { length: 36 }),
    stepRouteSetVersionNo: int("stepRouteSetVersionNo"),
    stepRouteRevisionId: varchar("stepRouteRevisionId", { length: 36 }),
    stepRouteActivationId: varchar("stepRouteActivationId", { length: 36 }),
    /** §6.3: 工作流版本标识。 */
    workflowVersion: varchar("workflowVersion", { length: 16 }).notNull().default("2.0"),
    /** §6.2: 最近完成的步骤名称。 */
    lastCompletedStep: varchar("lastCompletedStep", { length: 64 }),
  },
  (table) => ({
    /** 同一 AgentRevision + RouteScope + RuntimeKey 只能有一个活跃请求。 */
    activeRequestUq: uniqueIndex("HostedProvisioningRequest_active_uq").on(
      table.tenantId,
      table.agentRevisionId,
      table.routeScopeKey,
      table.desiredRuntimeKey,
    ),
    tenantIdx: index("HostedProvisioningRequest_tenantId_idx").on(table.tenantId),
    agentIdx: index("HostedProvisioningRequest_agentId_idx").on(table.agentId),
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
export type NewHostedProvisioningRequestRow = InferInsertModel<typeof hostedProvisioningRequestTable>;
