import {
  PUBLICATION_ACTOR_TYPES,
  PUBLICATION_SUBJECT_TYPES,
} from "@/lib/publications/domain/publication-record";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  datetime,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const publicationRecord = mysqlTable(
  "PublicationRecord",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    subjectType: mysqlEnum("subjectType", PUBLICATION_SUBJECT_TYPES).notNull(),
    subjectRevisionId: varchar("subjectRevisionId", { length: 36 }).notNull(),
    publicationSequence: bigint("publicationSequence", { mode: "number", unsigned: true })
      .autoincrement()
      .notNull(),
    evidenceSetDigest: varchar("evidenceSetDigest", { length: 71 }).notNull(),
    attestationIds: json("attestationIds").$type<string[]>().notNull(),
    conformanceRunId: varchar("conformanceRunId", { length: 36 }),
    approvals: json("approvals").$type<unknown[]>().notNull(),
    /**
     * Agent Descriptor 证据（Batch 2：Agent Publication 权威是外部合同快照，不是 source Artifact）。
     * 仅 agent_revision 发布填充；runtime_revision 发布为 null。
     */
    agentDescriptorSnapshotId: varchar("agentDescriptorSnapshotId", { length: 36 }),
    agentProviderDescriptorDigest: varchar("agentProviderDescriptorDigest", { length: 71 }),
    agentCapabilityManifestDigest: varchar("agentCapabilityManifestDigest", { length: 71 }),
    agentInvocationContextContractDigest: varchar("agentInvocationContextContractDigest", {
      length: 71,
    }),
    publishedByType: mysqlEnum("publishedByType", PUBLICATION_ACTOR_TYPES).notNull(),
    publishedBy: varchar("publishedBy", { length: 128 }).notNull(),
    publishedAt: datetime("publishedAt", { mode: "date", fsp: 3 }).notNull(),
    idempotencyKey: varchar("idempotencyKey", { length: 255 }).notNull(),
    idempotencyRecordId: varchar("idempotencyRecordId", { length: 36 }),
  },
  (table) => ({
    subjectUq: uniqueIndex("PublicationRecord_subject_uq").on(
      table.subjectType,
      table.subjectRevisionId,
    ),
    sequenceUq: uniqueIndex("PublicationRecord_sequence_uq").on(table.publicationSequence),
    idempotencyRecordUq: uniqueIndex("PublicationRecord_idempotencyRecord_uq").on(
      table.idempotencyRecordId,
    ),
    tenantPublishedIdx: index("PublicationRecord_tenant_published_idx").on(
      table.tenantId,
      table.publishedAt,
    ),
  }),
);

export const withdrawalRecord = mysqlTable(
  "WithdrawalRecord",
  {
    id: varchar("id", { length: 36 }).primaryKey().notNull(),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    publicationRecordId: varchar("publicationRecordId", { length: 36 })
      .notNull()
      .references(() => publicationRecord.id),
    subjectType: mysqlEnum("subjectType", PUBLICATION_SUBJECT_TYPES).notNull(),
    subjectRevisionId: varchar("subjectRevisionId", { length: 36 }).notNull(),
    reasonCode: varchar("reasonCode", { length: 64 }).notNull(),
    reason: text("reason").notNull(),
    withdrawnByType: mysqlEnum("withdrawnByType", PUBLICATION_ACTOR_TYPES).notNull(),
    withdrawnBy: varchar("withdrawnBy", { length: 128 }).notNull(),
    withdrawnAt: datetime("withdrawnAt", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => ({
    subjectUq: uniqueIndex("WithdrawalRecord_subject_uq").on(
      table.subjectType,
      table.subjectRevisionId,
    ),
    publicationRecordUq: uniqueIndex("WithdrawalRecord_publicationRecord_uq").on(
      table.publicationRecordId,
    ),
    tenantWithdrawnIdx: index("WithdrawalRecord_tenant_withdrawn_idx").on(
      table.tenantId,
      table.withdrawnAt,
    ),
  }),
);

export type PublicationRecord = InferSelectModel<typeof publicationRecord>;
export type NewPublicationRecord = InferInsertModel<typeof publicationRecord>;
export type WithdrawalRecord = InferSelectModel<typeof withdrawalRecord>;
export type NewWithdrawalRecord = InferInsertModel<typeof withdrawalRecord>;
