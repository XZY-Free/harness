/**
 * CutoverPlan 和 CutoverItem 的 Drizzle 表定义。
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

export const CUTOVER_PLAN_STATES = [
  "draft",
  "inventory_complete",
  "requalifying",
  "ready_to_activate",
  "activated",
  "failed",
  "cancelled",
] as const;

export const CUTOVER_ITEM_STATES = [
  "pending",
  "artifact_pending",
  "attestation_pending",
  "conformance_pending",
  "publication_pending",
  "ready",
  "failed",
  "manual_review",
] as const;

export const CUTOVER_ITEM_SUBJECT_TYPES = [
  "agent_revision",
  "runtime_revision",
] as const;

export const QUALIFICATION_CATEGORIES = [
  "trusted",
  "legacy_projection_only",
  "missing_artifact",
  "missing_attestation",
  "missing_conformance",
  "withdrawn",
  "invalid_digest",
  "manual_review_needed",
] as const;

// ─── CutoverPlan ────────────────────────────────────────────

export const cutoverPlanTable = mysqlTable(
  "CutoverPlan",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    routeSetId: varchar("routeSetId", { length: 36 }).notNull(),
    sourceRouteSetVersionNo: int("sourceRouteSetVersionNo").notNull(),
    targetRouteSetVersionNo: int("targetRouteSetVersionNo"),
    state: mysqlEnum("state", [...CUTOVER_PLAN_STATES]).notNull().default("draft"),
    createdBy: varchar("createdBy", { length: 128 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 }).notNull(),
    startedAt: datetime("startedAt", { mode: "date", fsp: 3 }),
    completedAt: datetime("completedAt", { mode: "date", fsp: 3 }),
    failedAt: datetime("failedAt", { mode: "date", fsp: 3 }),
    failureReason: varchar("failureReason", { length: 512 }),
  },
  (table) => ({
    tenantIdx: index("CutoverPlan_tenantId_idx").on(table.tenantId),
    routeSetIdx: index("CutoverPlan_routeSetId_idx").on(table.routeSetId),
    stateIdx: index("CutoverPlan_state_idx").on(table.state),
  }),
);

// ─── CutoverItem ────────────────────────────────────────────

export const cutoverItemTable = mysqlTable(
  "CutoverItem",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    planId: varchar("planId", { length: 36 }).notNull(),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    subjectType: mysqlEnum("subjectType", [...CUTOVER_ITEM_SUBJECT_TYPES]).notNull(),
    sourceSubjectId: varchar("sourceSubjectId", { length: 36 }).notNull(),
    replacementSubjectId: varchar("replacementSubjectId", { length: 36 }),
    state: mysqlEnum("state", [...CUTOVER_ITEM_STATES]).notNull().default("pending"),
    qualificationCategory: mysqlEnum("qualificationCategory", [...QUALIFICATION_CATEGORIES]).notNull(),
    attemptCount: int("attemptCount").notNull().default(0),
    nextAttemptAt: datetime("nextAttemptAt", { mode: "date", fsp: 3 }),
    leaseOwner: varchar("leaseOwner", { length: 128 }),
    leaseExpiresAt: datetime("leaseExpiresAt", { mode: "date", fsp: 3 }),
    lastError: varchar("lastError", { length: 512 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 }).notNull(),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => ({
    planSubjectUq: uniqueIndex("CutoverItem_planId_subjectType_sourceSubjectId_uq").on(
      table.planId,
      table.subjectType,
      table.sourceSubjectId,
    ),
    planIdx: index("CutoverItem_planId_idx").on(table.planId),
    tenantIdx: index("CutoverItem_tenantId_idx").on(table.tenantId),
    stateIdx: index("CutoverItem_state_idx").on(table.state),
    claimableIdx: index("CutoverItem_claimable_idx").on(
      table.state,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
  }),
);

export type CutoverPlanRow = InferSelectModel<typeof cutoverPlanTable>;
export type NewCutoverPlanRow = InferInsertModel<typeof cutoverPlanTable>;
export type CutoverItemRow = InferSelectModel<typeof cutoverItemTable>;
export type NewCutoverItemRow = InferInsertModel<typeof cutoverItemTable>;
