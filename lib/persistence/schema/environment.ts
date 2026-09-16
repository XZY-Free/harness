/** Environment identity, immutable revisions, leases, and future-selection requests. */
import { randomUUID } from "node:crypto";
import { threadTable } from "@/lib/persistence/schema/conversation";
import { invocationAttemptTable, invocationTable } from "@/lib/persistence/schema/executions";
import { tenant } from "@/lib/persistence/schema/identity";
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
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const ENVIRONMENT_TYPES = ["desktop", "cloud", "remote", "sandbox"] as const;
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

export const ENVIRONMENT_DEFINITION_LIFECYCLE_STATES = ["active", "archived", "deleted"] as const;
export type EnvironmentDefinitionLifecycleState =
  (typeof ENVIRONMENT_DEFINITION_LIFECYCLE_STATES)[number];

export const ENVIRONMENT_LEASE_STATES = [
  "allocated",
  "active",
  "releasing",
  "released",
  "expired",
  "lost",
] as const;
export type EnvironmentLeaseState = (typeof ENVIRONMENT_LEASE_STATES)[number];
export const ENVIRONMENT_LEASE_TERMINAL_STATES: readonly EnvironmentLeaseState[] = [
  "released",
  "expired",
  "lost",
];

export const ENVIRONMENT_READINESS_STATES = [
  "unresolved",
  "preparing",
  "prepared",
  "activating",
  "ready",
  "blocked",
] as const;
export type EnvironmentReadinessState = (typeof ENVIRONMENT_READINESS_STATES)[number];

export const ENVIRONMENT_CHANGE_REQUEST_STATES = [
  "pending",
  "accepted_for_next_invocation",
  "applied",
  "rejected",
  "expired",
] as const;
export type EnvironmentChangeRequestState = (typeof ENVIRONMENT_CHANGE_REQUEST_STATES)[number];
export const ENVIRONMENT_CHANGE_REQUEST_TERMINAL_STATES: readonly EnvironmentChangeRequestState[] =
  ["rejected", "expired"];

const ascii = (name: string, length: number) => varchar(name, { length }).$type<string>();
const timestamp = (name: string) => datetime(name, { mode: "date", fsp: 6 });
const unsignedBigint = (name: string) => bigint(name, { mode: "number", unsigned: true });
const currentTimestamp = () => sql`CURRENT_TIMESTAMP(6)`;

export const environmentDefinitionTable = mysqlTable(
  "EnvironmentDefinition",
  {
    id: ascii("id", 36)
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: ascii("tenantId", 36)
      .notNull()
      .references(() => tenant.id),
    environmentKey: ascii("environmentKey", 128).notNull(),
    displayName: varchar("displayName", { length: 256 }).notNull(),
    description: text("description"),
    lifecycleState: ascii("lifecycleState", 32).notNull().default("active"),
    currentRevisionId: ascii("currentRevisionId", 36),
    lastRevisionNo: unsignedBigint("lastRevisionNo").notNull().default(0),
    versionNo: unsignedBigint("versionNo").notNull().default(1),
    createdAt: timestamp("createdAt").notNull().default(currentTimestamp()),
    updatedAt: timestamp("updatedAt").notNull().default(currentTimestamp()),
    deletedAt: timestamp("deletedAt"),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("EnvironmentDefinition_tenant_id_uq").on(t.tenantId, t.id),
    tenantKeyUq: uniqueIndex("EnvironmentDefinition_tenant_key_uq").on(
      t.tenantId,
      t.environmentKey,
    ),
    tenantLifecycleUpdatedIdx: index("EnvironmentDefinition_tenant_lifecycle_updated_idx").on(
      t.tenantId,
      t.lifecycleState,
      t.updatedAt,
    ),
    lifecycleAllowed: check(
      "EnvironmentDefinition_lifecycle_allowed",
      sql`\`lifecycleState\` IN ('active', 'archived', 'deleted')`,
    ),
    currentRevisionShape: check(
      "EnvironmentDefinition_current_revision_shape",
      sql`\`lifecycleState\` <> 'active' OR \`currentRevisionId\` IS NOT NULL OR \`lastRevisionNo\` = 0`,
    ),
  }),
);

export type EnvironmentDefinition = InferSelectModel<typeof environmentDefinitionTable>;
export type EnvironmentDefinitionInsert = InferInsertModel<typeof environmentDefinitionTable>;

export const environmentLeaseTable = mysqlTable(
  "EnvironmentLease",
  {
    id: ascii("id", 36)
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: ascii("tenantId", 36)
      .notNull()
      .references(() => tenant.id),
    invocationId: ascii("invocationId", 36)
      .notNull()
      .references(() => invocationTable.id),
    attemptId: ascii("attemptId", 36).notNull(),
    environmentDefinitionRevisionId: ascii("environmentDefinitionRevisionId", 36).notNull(),
    deviceId: ascii("deviceId", 36),
    workerRef: varchar("workerRef", { length: 512 }),
    hostIdentity: varchar("hostIdentity", { length: 512 }),
    storageIdentity: ascii("storageIdentity", 71),
    leaseState: ascii("leaseState", 32).notNull().default("allocated"),
    readinessState: ascii("readinessState", 32).notNull().default("unresolved"),
    capabilitiesJson: json("capabilitiesJson"),
    complianceEvidence: json("complianceEvidence"),
    complianceDigest: ascii("complianceDigest", 71),
    preparedEvidence: json("preparedEvidence"),
    preparedDigest: ascii("preparedDigest", 71),
    preparedAt: timestamp("preparedAt"),
    activationOwnershipId: ascii("activationOwnershipId", 36),
    resourceManifest: json("resourceManifest").notNull(),
    cleanupLeaseOwner: ascii("cleanupLeaseOwner", 128),
    cleanupLeaseExpiresAt: timestamp("cleanupLeaseExpiresAt"),
    nextCleanupAt: timestamp("nextCleanupAt"),
    cleanupCount: int("cleanupCount", { unsigned: true }).notNull().default(0),
    lastErrorCode: ascii("lastErrorCode", 64),
    allocatedAt: timestamp("allocatedAt").notNull(),
    lastHeartbeatAt: timestamp("lastHeartbeatAt"),
    expiresAt: timestamp("expiresAt").notNull(),
    releasedAt: timestamp("releasedAt"),
    versionNo: unsignedBigint("versionNo").notNull().default(1),
    createdAt: timestamp("createdAt").notNull().default(currentTimestamp()),
    updatedAt: timestamp("updatedAt").notNull().default(currentTimestamp()),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("EnvironmentLease_tenant_id_uq").on(t.tenantId, t.id),
    invocationAttemptUq: uniqueIndex("EnvironmentLease_invocation_attempt_uq").on(
      t.tenantId,
      t.invocationId,
      t.attemptId,
    ),
    cleanupIdx: index("EnvironmentLease_cleanup_idx").on(
      t.leaseState,
      t.nextCleanupAt,
      t.cleanupLeaseExpiresAt,
    ),
    revisionIdx: index("EnvironmentLease_revision_idx").on(
      t.tenantId,
      t.environmentDefinitionRevisionId,
    ),
    leaseStateAllowed: check(
      "EnvironmentLease_lease_state_allowed",
      sql`\`leaseState\` IN ('allocated', 'active', 'releasing', 'released', 'expired', 'lost')`,
    ),
    readinessStateAllowed: check(
      "EnvironmentLease_readiness_state_allowed",
      sql`\`readinessState\` IN ('unresolved', 'preparing', 'prepared', 'activating', 'ready', 'blocked')`,
    ),
    attemptIdentityFk: foreignKey({
      name: "EnvironmentLease_tenant_invocation_attempt_fk",
      columns: [t.tenantId, t.invocationId, t.attemptId],
      foreignColumns: [
        invocationAttemptTable.tenantId,
        invocationAttemptTable.invocationId,
        invocationAttemptTable.id,
      ],
    }),
    activationShape: check(
      "EnvironmentLease_activation_shape",
      sql`(\`readinessState\` = 'ready' AND \`leaseState\` = 'active' AND \`activationOwnershipId\` IS NOT NULL) OR \`readinessState\` <> 'ready'`,
    ),
    complianceShape: check(
      "EnvironmentLease_compliance_shape",
      sql`\`readinessState\` NOT IN ('prepared', 'ready') OR (\`capabilitiesJson\` IS NOT NULL AND \`complianceEvidence\` IS NOT NULL AND \`complianceDigest\` IS NOT NULL AND \`preparedEvidence\` IS NOT NULL AND \`preparedDigest\` IS NOT NULL AND \`preparedAt\` IS NOT NULL)`,
    ),
  }),
);

export type EnvironmentLease = InferSelectModel<typeof environmentLeaseTable>;
export type EnvironmentLeaseInsert = InferInsertModel<typeof environmentLeaseTable>;

export const environmentChangeRequestTable = mysqlTable(
  "EnvironmentChangeRequest",
  {
    id: ascii("id", 36)
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: ascii("tenantId", 36)
      .notNull()
      .references(() => tenant.id),
    threadId: ascii("threadId", 36)
      .notNull()
      .references(() => threadTable.id),
    selectionSequence: unsignedBigint("selectionSequence").notNull(),
    requestedRevisionId: ascii("requestedRevisionId", 36).notNull(),
    requestState: ascii("requestState", 32).notNull().default("pending"),
    requestedBy: ascii("requestedBy", 128).notNull(),
    reasonCode: ascii("reasonCode", 64),
    firstAppliedInvocationId: ascii("firstAppliedInvocationId", 36),
    expiresAt: timestamp("expiresAt"),
    versionNo: unsignedBigint("versionNo").notNull().default(1),
    createdAt: timestamp("createdAt").notNull().default(currentTimestamp()),
    updatedAt: timestamp("updatedAt").notNull().default(currentTimestamp()),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("EnvironmentChangeRequest_tenant_id_uq").on(t.tenantId, t.id),
    selectionUq: uniqueIndex("EnvironmentChangeRequest_tenant_thread_sequence_uq").on(
      t.tenantId,
      t.threadId,
      t.selectionSequence,
    ),
    stateIdx: index("EnvironmentChangeRequest_tenant_thread_state_idx").on(
      t.tenantId,
      t.threadId,
      t.requestState,
      t.selectionSequence,
    ),
    stateAllowed: check(
      "EnvironmentChangeRequest_state_allowed",
      sql`\`requestState\` IN ('pending', 'accepted_for_next_invocation', 'applied', 'rejected', 'expired')`,
    ),
    appliedShape: check(
      "EnvironmentChangeRequest_applied_shape",
      sql`\`requestState\` <> 'applied' OR \`firstAppliedInvocationId\` IS NOT NULL`,
    ),
    revisionReferenceShape: check(
      "EnvironmentChangeRequest_revision_reference_shape",
      sql`\`requestedRevisionId\` IS NOT NULL`,
    ),
    threadFk: foreignKey({
      name: "EnvironmentChangeRequest_tenant_thread_fk",
      columns: [t.tenantId, t.threadId],
      foreignColumns: [threadTable.tenantId, threadTable.id],
    }),
    appliedInvocationFk: foreignKey({
      name: "EnvironmentChangeRequest_tenant_invocation_fk",
      columns: [t.tenantId, t.firstAppliedInvocationId],
      foreignColumns: [invocationTable.tenantId, invocationTable.id],
    }),
  }),
);

export type EnvironmentChangeRequest = InferSelectModel<typeof environmentChangeRequestTable>;
export type EnvironmentChangeRequestInsert = InferInsertModel<typeof environmentChangeRequestTable>;
