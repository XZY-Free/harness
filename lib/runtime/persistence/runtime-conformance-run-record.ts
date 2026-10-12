import type { RuntimeConformanceOverallResult } from "@/lib/runtime/domain/runtime-conformance-run";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  datetime,
  index,
  int,
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
    runtimeTargetDigest: varchar("runtimeTargetDigest", { length: 71 }).notNull(),
    runtimeConfigDigest: varchar("runtimeConfigDigest", { length: 71 }).notNull(),
    protocolContractDigest: varchar("protocolContractDigest", { length: 71 }).notNull(),
    suiteRevision: varchar("suiteRevision", { length: 128 }).notNull(),
    runnerArtifactDigest: varchar("runnerArtifactDigest", { length: 71 }).notNull(),
    runnerIdentity: varchar("runnerIdentity", { length: 256 }).notNull(),
    testEnvironmentRevision: varchar("testEnvironmentRevision", { length: 128 }).notNull(),
    startedAt: datetime("startedAt", { mode: "date", fsp: 6 }).notNull(),
    completedAt: datetime("completedAt", { mode: "date", fsp: 6 }).notNull(),
    overallResult: varchar("overallResult", { length: 32 })
      .$type<RuntimeConformanceOverallResult>()
      .notNull(),
    conformanceFormat: varchar("conformanceFormat", { length: 32 })
      .$type<"standard_dsse">()
      .notNull()
      .default("standard_dsse"),
    evidenceManifestDigest: varchar("evidenceManifestDigest", { length: 71 }).notNull(),
    envelopeDigest: varchar("envelopeDigest", { length: 71 }).notNull(),
    envelopeJson: text("envelopeJson").notNull(),
    payloadDigest: varchar("payloadDigest", { length: 71 }).notNull(),
    signingKeyId: varchar("signingKeyId", { length: 256 }).notNull(),
    verificationEngine: varchar("verificationEngine", { length: 64 }).notNull(),
    verificationEngineVersion: varchar("verificationEngineVersion", { length: 32 }).notNull(),
    predicateType: varchar("predicateType", { length: 256 }).notNull(),
    verifiedAt: datetime("verifiedAt", { mode: "date", fsp: 6 }).notNull(),
    idempotencyKey: varchar("idempotencyKey", { length: 128 }).notNull(),
    protocolVersion: int("protocolVersion", { unsigned: true }).notNull(),
    requestId: varchar("requestId", { length: 64 }).notNull(),
    recordedAt: datetime("recordedAt", { mode: "date", fsp: 6 }).notNull(),
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
    overallResultAllowed: check(
      "RuntimeConformanceRun_overall_result_allowed",
      sql`\`overallResult\` IN ('passed', 'failed', 'error', 'cancelled')`,
    ),
    formatAllowed: check(
      "RuntimeConformanceRun_format_allowed",
      sql`\`conformanceFormat\` = 'standard_dsse'`,
    ),
    protocolVersionAllowed: check(
      "RuntimeConformanceRun_protocol_version_allowed",
      sql`\`protocolVersion\` = 3`,
    ),
  }),
);

export const runtimeConformanceCaseResult = mysqlTable(
  "RuntimeConformanceCaseResult",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
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
      table.tenantId,
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
