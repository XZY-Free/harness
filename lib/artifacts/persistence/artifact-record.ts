import { randomUUID } from "node:crypto";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  datetime,
  foreignKey,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { VERIFICATION_STATES } from "../domain/artifact";

export const artifact = mysqlTable(
  "Artifact",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull().$defaultFn(randomUUID),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    kind: varchar("kind", { length: 64 }).notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    mediaType: varchar("mediaType", { length: 255 }),
    size: bigint("size", { mode: "number", unsigned: true }),
    contentRef: varchar("contentRef", { length: 512 }),
    sourceRevision: varchar("sourceRevision", { length: 128 }),
    buildMetadata: json("buildMetadata"),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    tenantDigestUq: uniqueIndex("Artifact_tenant_digest_uq").on(table.tenantId, table.digest),
    tenantKindCreatedIdx: index("Artifact_tenant_kind_created_idx").on(
      table.tenantId,
      table.kind,
      table.createdAt,
    ),
  }),
);

/**
 * 物理表名保持 ArtifactAttestation；正式代码只通过本稳定模块访问。
 * 撤销事实的唯一 Authority 是 AttestationRevocationRecord，本表不承载撤销状态。
 */
export const artifactAttestation = mysqlTable(
  "ArtifactAttestation",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull().$defaultFn(randomUUID),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    artifactId: varchar("artifactId", { length: 36 }).references(() => artifact.id),
    artifactType: varchar("artifactType", { length: 32 }).notNull(),
    artifactRevisionId: varchar("artifactRevisionId", { length: 36 }).notNull(),
    artifactDigest: varchar("artifactDigest", { length: 128 }).notNull(),
    dsseEnvelopeRef: varchar("dsseEnvelopeRef", { length: 512 }),
    sbomRef: varchar("sbomRef", { length: 512 }),
    provenanceRef: varchar("provenanceRef", { length: 512 }),
    builderIdentity: varchar("builderIdentity", { length: 256 }),
    verificationState: mysqlEnum("verificationState", VERIFICATION_STATES).notNull(),
    policyRevisionId: varchar("policyRevisionId", { length: 36 }),
    sourceRevision: varchar("sourceRevision", { length: 128 }),
    buildPipeline: varchar("buildPipeline", { length: 256 }),
    dependencyLockFileHash: varchar("dependencyLockFileHash", { length: 128 }),
    buildTime: datetime("buildTime", { mode: "date", fsp: 3 }),
    scanSummaryJson: json("scanSummaryJson"),
    failureCode: varchar("failureCode", { length: 64 }),
    verifiedAt: datetime("verifiedAt", { mode: "date", fsp: 3 }),

    // ─── DSSE + in-toto 唯一正式协议 ──────
    attestationFormat: mysqlEnum("attestationFormat", ["in_toto_dsse"])
      .notNull()
      .default("in_toto_dsse"),
    statementType: varchar("statementType", { length: 128 }),
    predicateType: varchar("predicateType", { length: 256 }),
    bundleDigest: varchar("bundleDigest", { length: 71 }),
    subjectName: varchar("subjectName", { length: 256 }),
    subjectDigest: varchar("subjectDigest", { length: 71 }),
    verificationEngine: varchar("verificationEngine", { length: 64 }),
    verificationEngineVersion: varchar("verificationEngineVersion", { length: 32 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    tenantTypeRevDigestSigU4Uq: uniqueIndex("ArtifactAttestation_tenant_type_rev_digest_env_uq").on(
      table.tenantId,
      table.artifactType,
      table.artifactRevisionId,
      table.artifactDigest,
      table.dsseEnvelopeRef,
    ),
    artifactIdx: index("ArtifactAttestation_artifact_idx").on(table.artifactId),
    tenantTypeRevStateIdx: index("ArtifactAttestation_tenant_type_rev_state_idx").on(
      table.tenantId,
      table.artifactType,
      table.artifactRevisionId,
      table.verificationState,
    ),
    tenantDigestIdx: index("ArtifactAttestation_tenant_digest_idx").on(
      table.tenantId,
      table.artifactDigest,
    ),
  }),
);

export const ATTESTATION_REVOCATION_ACTOR_TYPES = [
  "user",
  "service",
  "workload",
  "system",
] as const;
export type AttestationRevocationActorType = (typeof ATTESTATION_REVOCATION_ACTOR_TYPES)[number];

export const attestationRevocationRecord = mysqlTable(
  "AttestationRevocationRecord",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull().$defaultFn(randomUUID),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    attestationId: varchar("attestationId", { length: 36 }).notNull(),
    revokedByType: mysqlEnum("revokedByType", ATTESTATION_REVOCATION_ACTOR_TYPES).notNull(),
    revokedBy: varchar("revokedBy", { length: 128 }).notNull(),
    reason: text("reason").notNull(),
    requestId: varchar("requestId", { length: 64 }).notNull(),
    revokedAt: datetime("revokedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    attestationUq: uniqueIndex("AttestationRevocationRecord_attestation_uq").on(
      table.attestationId,
    ),
    tenantRevokedIdx: index("AttestationRevocationRecord_tenant_revoked_idx").on(
      table.tenantId,
      table.revokedAt,
    ),
    // 显式命名 FK（0000 基线中 drizzle 截断生成，<64 字符）。
    attestationFk: foreignKey({
      name: "AttestationRevocationRecord_attestationId_ArtifactAttestatiob0ec",
      columns: [table.attestationId],
      foreignColumns: [artifactAttestation.id],
    }),
  }),
);

export type Artifact = InferSelectModel<typeof artifact>;
export type NewArtifact = InferInsertModel<typeof artifact>;
export type ArtifactAttestation = InferSelectModel<typeof artifactAttestation>;
export type NewArtifactAttestation = InferInsertModel<typeof artifactAttestation>;
export type AttestationRevocationRecord = InferSelectModel<typeof attestationRevocationRecord>;
export type NewAttestationRevocationRecord = InferInsertModel<typeof attestationRevocationRecord>;
