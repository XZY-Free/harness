import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  datetime,
  index,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const runtimeConformanceRun = mysqlTable(
  "RuntimeConformanceRun",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    runtimeRevisionId: varchar("runtimeRevisionId", { length: 36 }).notNull(),
    runtimeArtifactDigest: varchar("runtimeArtifactDigest", { length: 71 }).notNull(),
    runtimeConfigDigest: varchar("runtimeConfigDigest", { length: 71 }).notNull(),
    protocolContractRevision: varchar("protocolContractRevision", { length: 128 }).notNull(),
    suiteRevision: varchar("suiteRevision", { length: 128 }).notNull(),
    runnerArtifactDigest: varchar("runnerArtifactDigest", { length: 71 }).notNull(),
    runnerIdentity: varchar("runnerIdentity", { length: 255 }).notNull(),
    testEnvironmentRevision: varchar("testEnvironmentRevision", { length: 128 }).notNull(),
    startedAt: datetime("startedAt", { mode: "date", fsp: 3 }).notNull(),
    completedAt: datetime("completedAt", { mode: "date", fsp: 3 }).notNull(),
    overallResult: mysqlEnum("overallResult", ["passed", "failed", "error", "cancelled"]).notNull(),
    /** Conformance 签名格式 — 第四批新增。过渡?期: legacy_hmac(默认) → standard_dsse(新)。 */
    conformanceFormat: mysqlEnum("conformanceFormat", ["legacy_hmac", "standard_dsse"])
      .notNull()
      .default("legacy_hmac"),
    evidenceManifestDigest: varchar("evidenceManifestDigest", { length: 71 }).notNull(),
    runnerSignature: varchar("runnerSignature", { length: 64 }).notNull(),
    idempotencyKey: varchar("idempotencyKey", { length: 255 }).notNull(),
    requestId: varchar("requestId", { length: 64 }).notNull(),
    recordedAt: datetime("recordedAt", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => ({
    idempotencyUq: uniqueIndex("RuntimeConformanceRun_idempotency_uq").on(
      table.tenantId,
      table.runtimeRevisionId,
      table.idempotencyKey,
    ),
    revisionCompletedIdx: index("RuntimeConformanceRun_revision_completed_idx").on(
      table.runtimeRevisionId,
      table.completedAt,
    ),
    evidenceUq: uniqueIndex("RuntimeConformanceRun_evidence_uq").on(
      table.tenantId,
      table.evidenceManifestDigest,
    ),
  }),
);

export const runtimeConformanceCaseResult = mysqlTable(
  "RuntimeConformanceCaseResult",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    runId: varchar("runId", { length: 36 })
      .notNull()
      .references(() => runtimeConformanceRun.id),
    caseId: varchar("caseId", { length: 128 }).notNull(),
    passed: boolean("passed").notNull(),
    reason: text("reason"),
    evidenceDigest: varchar("evidenceDigest", { length: 71 }).notNull(),
  },
  (table) => ({
    runCaseUq: uniqueIndex("RuntimeConformanceCaseResult_run_case_uq").on(
      table.runId,
      table.caseId,
    ),
  }),
);

export type RuntimeConformanceRunRecord = InferSelectModel<typeof runtimeConformanceRun>;
export type NewRuntimeConformanceRunRecord = InferInsertModel<typeof runtimeConformanceRun>;
export type RuntimeConformanceCaseResultRecord = InferSelectModel<
  typeof runtimeConformanceCaseResult
>;
