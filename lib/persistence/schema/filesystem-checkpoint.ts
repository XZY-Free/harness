/** Immutable filesystem snapshots and recovery evidence. */
import { randomUUID } from "node:crypto";
import { executionOwnershipTable } from "@/lib/persistence/schema/executions";
import { tenant } from "@/lib/persistence/schema/identity";
import { workspaceBinding } from "@/lib/persistence/schema/workspace";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  datetime,
  foreignKey,
  index,
  int,
  json,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const FILESYSTEM_CHECKPOINT_FORMATS = ["content_manifest"] as const;
export type FilesystemCheckpointFormat = (typeof FILESYSTEM_CHECKPOINT_FORMATS)[number];

export const filesystemCheckpointTable = mysqlTable(
  "FilesystemCheckpoint",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    invocationId: varchar("invocationId", { length: 36 }).notNull(),
    attemptId: varchar("attemptId", { length: 36 }).notNull(),
    ownershipId: varchar("ownershipId", { length: 36 }).notNull(),
    workspaceBindingId: varchar("workspaceBindingId", { length: 36 })
      .notNull()
      .references(() => workspaceBinding.id),
    environmentDefinitionRevisionId: varchar("environmentDefinitionRevisionId", {
      length: 36,
    }).notNull(),
    leaseEpoch: bigint("leaseEpoch", { mode: "bigint", unsigned: true }).notNull(),
    checkpointIntentId: varchar("checkpointIntentId", { length: 36 }).notNull(),
    writerGeneration: bigint("writerGeneration", { mode: "number", unsigned: true }).notNull(),
    recoveryVersion: bigint("recoveryVersion", { mode: "number", unsigned: true }).notNull(),
    producerSequence: bigint("producerSequence", { mode: "bigint", unsigned: true }).notNull(),
    recoveryAnchor: json("recoveryAnchor").notNull(),
    recoveryAnchorDigest: varchar("recoveryAnchorDigest", { length: 71 }).notNull(),
    snapshotFormat: varchar("snapshotFormat", { length: 32 })
      .$type<FilesystemCheckpointFormat>()
      .notNull(),
    manifestRef: varchar("manifestRef", { length: 512 }).notNull(),
    manifestDigest: varchar("manifestDigest", { length: 71 }).notNull(),
    contentRootDigest: varchar("contentRootDigest", { length: 71 }).notNull(),
    fileCount: int("fileCount", { unsigned: true }).notNull(),
    totalBytes: bigint("totalBytes", { mode: "number", unsigned: true }).notNull(),
    filesystemSemantics: json("filesystemSemantics").notNull(),
    storageEvidence: json("storageEvidence").notNull(),
    committedAt: datetime("committedAt", { mode: "date", fsp: 6 }).notNull(),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("FilesystemCheckpoint_tenant_id_uq").on(t.tenantId, t.id),
    invocationIntentUq: uniqueIndex("FilesystemCheckpoint_tenant_invocation_intent_uq").on(
      t.tenantId,
      t.invocationId,
      t.checkpointIntentId,
    ),
    recoveryIdx: index("FilesystemCheckpoint_recovery_idx").on(
      t.tenantId,
      t.invocationId,
      t.recoveryVersion,
      t.committedAt,
    ),
    snapshotFormatAllowed: check(
      "FilesystemCheckpoint_snapshot_format_allowed",
      sql`\`snapshotFormat\` = 'content_manifest'`,
    ),
    sizesNonNegative: check(
      "FilesystemCheckpoint_sizes_non_negative",
      sql`\`fileCount\` >= 0 AND \`totalBytes\` >= 0`,
    ),
    ownershipFk: foreignKey({
      name: "FilesystemCheckpoint_tenant_owner_fk",
      columns: [t.tenantId, t.invocationId, t.attemptId, t.ownershipId, t.leaseEpoch],
      foreignColumns: [
        executionOwnershipTable.tenantId,
        executionOwnershipTable.invocationId,
        executionOwnershipTable.attemptId,
        executionOwnershipTable.id,
        executionOwnershipTable.leaseEpoch,
      ],
    }),
    digestShape: check(
      "FilesystemCheckpoint_digest_shape",
      sql`\`manifestDigest\` REGEXP '^sha256:[0-9a-f]{64}$' AND \`contentRootDigest\` REGEXP '^sha256:[0-9a-f]{64}$' AND \`recoveryAnchorDigest\` REGEXP '^sha256:[0-9a-f]{64}$'`,
    ),
  }),
);

export type FilesystemCheckpoint = InferSelectModel<typeof filesystemCheckpointTable>;
export type NewFilesystemCheckpoint = InferInsertModel<typeof filesystemCheckpointTable>;
