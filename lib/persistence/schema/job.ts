/** Thread-independent Job domain schema. */
import { randomUUID } from "node:crypto";
import { threadItemTable, turnTable } from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/executions";
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

export const JOB_TYPES = [
  "scheduled",
  "batch",
  "deployment",
  "evaluation",
  "knowledge_build",
  "system",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATES = [
  "queued",
  "running",
  "waiting_external",
  "completed",
  "failed",
  "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];
export const JOB_TERMINAL_STATES: readonly JobState[] = ["completed", "failed", "cancelled"];

export const JOB_INPUT_KINDS = ["inline", "reference"] as const;
export type JobInputKind = (typeof JOB_INPUT_KINDS)[number];
export const JOB_COMMAND_TYPES = ["cancel", "retry", "execution_terminal"] as const;
export type JobCommandType = (typeof JOB_COMMAND_TYPES)[number];
export const JOB_COMMAND_STATES = [
  "queued",
  "dispatched",
  "waiting",
  "acknowledged",
  "rejected",
] as const;
export type JobCommandState = (typeof JOB_COMMAND_STATES)[number];
export const JOB_EVENT_ACTOR_TYPES = ["user", "agent", "system", "tool", "service"] as const;
export type JobEventActorType = (typeof JOB_EVENT_ACTOR_TYPES)[number];
export type JobEventType = string;

const ascii = (name: string, length: number) => varchar(name, { length }).$type<string>();
const bigintUnsigned = (name: string) => bigint(name, { mode: "number", unsigned: true });
const timestamp = (name: string) => datetime(name, { mode: "date", fsp: 6 });
const currentTimestamp = () => sql`CURRENT_TIMESTAMP(6)`;

export const jobTable = mysqlTable(
  "Job",
  {
    id: ascii("id", 36)
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: ascii("tenantId", 36)
      .notNull()
      .references(() => tenant.id),
    agentId: ascii("agentId", 36).notNull(),
    jobType: ascii("jobType", 32).$type<JobType>().notNull(),
    triggerRef: varchar("triggerRef", { length: 512 }).notNull(),
    creationKey: ascii("creationKey", 128).notNull(),
    jobState: ascii("jobState", 32).$type<JobState>().notNull().default("queued"),
    replacesJobId: ascii("replacesJobId", 36),
    threadId: ascii("threadId", 36),
    inputKind: ascii("inputKind", 32).$type<JobInputKind>().notNull(),
    inputJson: json("inputJson"),
    inputRef: varchar("inputRef", { length: 512 }),
    inputHash: ascii("inputHash", 71).notNull(),
    completionPolicyJson: json("completionPolicyJson").notNull(),
    lastEventSequence: bigintUnsigned("lastEventSequence").notNull().default(0),
    resultRef: varchar("resultRef", { length: 512 }),
    resultHash: ascii("resultHash", 71),
    errorCode: ascii("errorCode", 64),
    errorSummary: text("errorSummary"),
    createdBy: ascii("createdBy", 128).notNull(),
    startedAt: timestamp("startedAt"),
    finishedAt: timestamp("finishedAt"),
    versionNo: bigintUnsigned("versionNo").notNull().default(1),
    createdAt: timestamp("createdAt").notNull().default(currentTimestamp()),
    updatedAt: timestamp("updatedAt").notNull().default(currentTimestamp()),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("Job_tenant_id_uq").on(t.tenantId, t.id),
    creationKeyUq: uniqueIndex("Job_tenant_creation_key_uq").on(t.tenantId, t.creationKey),
    stateIdx: index("Job_tenant_state_updated_idx").on(t.tenantId, t.jobState, t.updatedAt),
    replacementIdx: index("Job_tenant_replacement_idx").on(t.tenantId, t.replacesJobId),
    jobTypeAllowed: check(
      "Job_type_allowed",
      sql`\`jobType\` IN ('scheduled', 'batch', 'deployment', 'evaluation', 'knowledge_build', 'system')`,
    ),
    stateAllowed: check(
      "Job_state_allowed",
      sql`\`jobState\` IN ('queued', 'running', 'waiting_external', 'completed', 'failed', 'cancelled')`,
    ),
    inputKindAllowed: check(
      "Job_input_kind_allowed",
      sql`\`inputKind\` IN ('inline', 'reference')`,
    ),
    inputShape: check(
      "Job_input_shape",
      sql`(\`inputKind\` = 'inline' AND \`inputJson\` IS NOT NULL AND \`inputRef\` IS NULL) OR (\`inputKind\` = 'reference' AND \`inputJson\` IS NULL AND \`inputRef\` IS NOT NULL)`,
    ),
    terminalShape: check(
      "Job_terminal_shape",
      sql`((\`finishedAt\` IS NULL AND \`jobState\` NOT IN ('completed', 'failed', 'cancelled')) OR (\`finishedAt\` IS NOT NULL AND \`jobState\` IN ('completed', 'failed', 'cancelled')))`,
    ),
    replacementFk: foreignKey({
      name: "Job_tenant_replacement_fk",
      columns: [t.tenantId, t.replacesJobId],
      foreignColumns: [t.tenantId, t.id],
    }),
  }),
);

export type Job = InferSelectModel<typeof jobTable>;
export type NewJob = InferInsertModel<typeof jobTable>;

export const jobEventTable = mysqlTable(
  "JobEvent",
  {
    id: ascii("id", 36)
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: ascii("tenantId", 36)
      .notNull()
      .references(() => tenant.id),
    jobId: ascii("jobId", 36).notNull(),
    eventSequence: bigintUnsigned("eventSequence").notNull(),
    eventType: ascii("eventType", 64).notNull(),
    schemaVersion: int("schemaVersion", { unsigned: true }).notNull().default(1),
    invocationId: ascii("invocationId", 36),
    actorType: ascii("actorType", 16).$type<JobEventActorType>().notNull(),
    actorId: ascii("actorId", 128),
    payloadJson: json("payloadJson").notNull(),
    correlationId: ascii("correlationId", 128),
    causationId: ascii("causationId", 128),
    idempotencyKey: ascii("idempotencyKey", 128),
    occurredAt: timestamp("occurredAt").notNull(),
    ingestedAt: timestamp("ingestedAt").notNull(),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("JobEvent_tenant_id_uq").on(t.tenantId, t.id),
    sequenceUq: uniqueIndex("JobEvent_tenant_job_sequence_uq").on(
      t.tenantId,
      t.jobId,
      t.eventSequence,
    ),
    idempotencyUq: uniqueIndex("JobEvent_tenant_job_idempotency_uq").on(
      t.tenantId,
      t.jobId,
      t.idempotencyKey,
    ),
    jobFk: foreignKey({
      name: "JobEvent_tenant_job_fk",
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobTable.tenantId, jobTable.id],
    }),
    invocationFk: foreignKey({
      name: "JobEvent_tenant_invocation_fk",
      columns: [t.tenantId, t.invocationId],
      foreignColumns: [invocationTable.tenantId, invocationTable.id],
    }),
  }),
);

export type JobEvent = InferSelectModel<typeof jobEventTable>;
export type NewJobEvent = InferInsertModel<typeof jobEventTable>;

export const jobCommandTable = mysqlTable(
  "JobCommand",
  {
    id: ascii("id", 36)
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: ascii("tenantId", 36)
      .notNull()
      .references(() => tenant.id),
    jobId: ascii("jobId", 36).notNull(),
    invocationId: ascii("invocationId", 36),
    commandType: ascii("commandType", 32).$type<JobCommandType>().notNull(),
    commandState: ascii("commandState", 32).$type<JobCommandState>().notNull().default("queued"),
    idempotencyKey: ascii("idempotencyKey", 128).notNull(),
    payloadJson: json("payloadJson").notNull(),
    payloadHash: ascii("payloadHash", 71).notNull(),
    requestedByType: ascii("requestedByType", 16).notNull(),
    requestedById: ascii("requestedById", 128).notNull(),
    leaseOwner: ascii("leaseOwner", 128),
    leaseExpiresAt: timestamp("leaseExpiresAt"),
    deliveryCount: int("deliveryCount", { unsigned: true }).notNull().default(0),
    nextAttemptAt: timestamp("nextAttemptAt").notNull(),
    lastErrorCode: ascii("lastErrorCode", 64),
    resultJson: json("resultJson"),
    completedAt: timestamp("completedAt"),
    versionNo: bigintUnsigned("versionNo").notNull().default(1),
    createdAt: timestamp("createdAt").notNull().default(currentTimestamp()),
    updatedAt: timestamp("updatedAt").notNull().default(currentTimestamp()),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("JobCommand_tenant_id_uq").on(t.tenantId, t.id),
    idempotencyUq: uniqueIndex("JobCommand_tenant_job_idempotency_uq").on(
      t.tenantId,
      t.jobId,
      t.idempotencyKey,
    ),
    dispatchIdx: index("JobCommand_state_next_attempt_lease_idx").on(
      t.commandState,
      t.nextAttemptAt,
      t.leaseExpiresAt,
    ),
    commandTypeAllowed: check(
      "JobCommand_type_allowed",
      sql`\`commandType\` IN ('cancel', 'retry', 'execution_terminal')`,
    ),
    commandStateAllowed: check(
      "JobCommand_state_allowed",
      sql`\`commandState\` IN ('queued', 'dispatched', 'waiting', 'acknowledged', 'rejected')`,
    ),
    jobFk: foreignKey({
      name: "JobCommand_tenant_job_fk",
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobTable.tenantId, jobTable.id],
    }),
    invocationFk: foreignKey({
      name: "JobCommand_tenant_invocation_fk",
      columns: [t.tenantId, t.invocationId],
      foreignColumns: [invocationTable.tenantId, invocationTable.id],
    }),
    terminalCommandShape: check(
      "JobCommand_terminal_shape",
      sql`\`commandType\` <> 'execution_terminal' OR \`invocationId\` IS NOT NULL`,
    ),
  }),
);

export type JobCommand = InferSelectModel<typeof jobCommandTable>;
export type NewJobCommand = InferInsertModel<typeof jobCommandTable>;

/** Existing Job result projection authority; this is not a new execution domain object. */
export const jobResultProjectionTable = mysqlTable(
  "JobResultProjection",
  {
    id: ascii("id", 36)
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: ascii("tenantId", 36)
      .notNull()
      .references(() => tenant.id),
    itemId: ascii("itemId", 36).notNull(),
    jobId: ascii("jobId", 36).notNull(),
    sourceTurnId: ascii("sourceTurnId", 36).notNull(),
    projectionKind: ascii("projectionKind", 32)
      .$type<"existing_source_turn" | "system_triggered_turn">()
      .notNull(),
    resultRef: varchar("resultRef", { length: 512 }).notNull(),
    resultHash: ascii("resultHash", 71).notNull(),
    resultSummaryJson: json("resultSummaryJson"),
    createdBy: ascii("createdBy", 128),
    createdAt: timestamp("createdAt").notNull().default(currentTimestamp()),
  },
  (t) => ({
    itemUq: uniqueIndex("JobResultProjection_item_uq").on(t.itemId),
    tenantIdUq: uniqueIndex("JobResultProjection_tenant_id_uq").on(t.tenantId, t.id),
    tenantJobIdx: index("JobResultProjection_tenant_job_idx").on(t.tenantId, t.jobId),
    tenantSourceTurnIdx: index("JobResultProjection_tenant_source_turn_idx").on(
      t.tenantId,
      t.sourceTurnId,
    ),
    projectionKindAllowed: check(
      "JobResultProjection_kind_allowed",
      sql`\`projectionKind\` IN ('existing_source_turn', 'system_triggered_turn')`,
    ),
    jobFk: foreignKey({
      name: "JobResultProjection_tenant_job_fk",
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobTable.tenantId, jobTable.id],
    }),
    itemFk: foreignKey({
      name: "JobResultProjection_item_fk",
      columns: [t.itemId],
      foreignColumns: [threadItemTable.id],
    }),
    sourceTurnFk: foreignKey({
      name: "JobResultProjection_source_turn_fk",
      columns: [t.sourceTurnId],
      foreignColumns: [turnTable.id],
    }),
  }),
);

export type JobResultProjection = InferSelectModel<typeof jobResultProjectionTable>;
export type NewJobResultProjection = InferInsertModel<typeof jobResultProjectionTable>;
