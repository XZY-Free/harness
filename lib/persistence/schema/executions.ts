/** Canonical Invocation execution-control schema. */
import { randomUUID } from "node:crypto";
import { contextCheckpoint } from "@/lib/persistence/schema/context-checkpoint";
import { threadItemTable, threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import { tenant } from "@/lib/persistence/schema/identity";
import type { RuntimeEvidenceKind } from "@/lib/persistence/schema/runtimes";
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
  tinyint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const INVOCATION_SUBJECT_TYPES = ["thread", "job"] as const;
export type InvocationSubjectType = (typeof INVOCATION_SUBJECT_TYPES)[number];
export const INVOCATION_KINDS = ["initial", "regenerate", "job"] as const;
export type InvocationKind = (typeof INVOCATION_KINDS)[number];
export const INVOCATION_EXECUTION_STATES = [
  "queued",
  "running",
  "waiting_user",
  "completed",
  "failed",
  "cancelled",
  "lost",
] as const;
export type InvocationExecutionState = (typeof INVOCATION_EXECUTION_STATES)[number];
export const INVOCATION_TERMINAL_STATES: readonly InvocationExecutionState[] = [
  "completed",
  "failed",
  "cancelled",
  "lost",
];
/**
 * Checkpoint Gate（R05 §5 / R09 §2 步骤 8）。
 *
 * - open：无安全点在途，新决策/新 Action/新 Workspace 写入正常。
 * - quiescing：已登记稳定 intent 与 deadline，拒绝新决策/新 Action/新写入。
 * - frozen：Broker 已冻结文件 Generation，正在持久 Snapshot 与提交。
 * - releasing：Checkpoint 已提交（或候选已放弃），但 Runtime/Backend 的解冻尚未确认。
 *   这是"不能只在 finally 里调用 release 并吞异常"的承载点：解冻是**持久工作**，
 *   在确认完成前 Gate 不放行新执行；进程在解冻途中 Crash 时由维护 lane 按 intentId 续做。
 */
export const INVOCATION_CHECKPOINT_GATES = ["open", "quiescing", "frozen", "releasing"] as const;
export type InvocationCheckpointGate = (typeof INVOCATION_CHECKPOINT_GATES)[number];
/** 仍持有安全点、拒绝新决策/新写入的 Gate（fail-closed 集合）。 */
export const INVOCATION_CHECKPOINT_GATE_HELD: readonly InvocationCheckpointGate[] = [
  "quiescing",
  "frozen",
  "releasing",
];

const ascii = (name: string, length: number) => varchar(name, { length }).$type<string>();
const bigintUnsigned = (name: string) => bigint(name, { mode: "number", unsigned: true });
const timestamp = (name: string) => datetime(name, { mode: "date", fsp: 6 });
const currentTimestamp = () => sql`CURRENT_TIMESTAMP(6)`;

export const invocationTable = mysqlTable(
  "Invocation",
  {
    id: ascii("id", 36)
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: ascii("tenantId", 36)
      .notNull()
      .references(() => tenant.id),
    subjectType: ascii("subjectType", 32).$type<InvocationSubjectType>().notNull(),
    threadId: ascii("threadId", 36).references(() => threadTable.id),
    turnId: ascii("turnId", 36).references(() => turnTable.id),
    jobId: ascii("jobId", 36),
    triggerItemId: ascii("triggerItemId", 36).references(() => threadItemTable.id),
    replacesInvocationId: ascii("replacesInvocationId", 36),
    outputItemId: ascii("outputItemId", 36).references(() => threadItemTable.id),
    invocationSequence: bigintUnsigned("invocationSequence").notNull(),
    invocationKind: ascii("invocationKind", 32).$type<InvocationKind>().notNull(),
    executionState: ascii("executionState", 32)
      .$type<InvocationExecutionState>()
      .notNull()
      .default("queued"),
    inputDigest: ascii("inputDigest", 71).notNull(),
    resultRef: varchar("resultRef", { length: 512 }),
    resultDigest: ascii("resultDigest", 71),
    lastOwnershipEpoch: bigintUnsigned("lastOwnershipEpoch").notNull().default(0),
    lastProducerSequence: bigintUnsigned("lastProducerSequence").notNull().default(0),
    recoveryVersion: bigintUnsigned("recoveryVersion").notNull().default(0),
    checkpointGate: ascii("checkpointGate", 32)
      .$type<InvocationCheckpointGate>()
      .notNull()
      .default("open"),
    checkpointIntentId: ascii("checkpointIntentId", 36),
    checkpointOwnerId: ascii("checkpointOwnerId", 36),
    checkpointDeadline: timestamp("checkpointDeadline"),
    checkpointProducerSequence: bigintUnsigned("checkpointProducerSequence"),
    checkpointRecoveryVersion: bigintUnsigned("checkpointRecoveryVersion"),
    checkpointAnchor: json("checkpointAnchor"),
    checkpointPreparedEvidence: json("checkpointPreparedEvidence"),
    startedAt: timestamp("startedAt"),
    finishedAt: timestamp("finishedAt"),
    errorCode: ascii("errorCode", 64),
    errorSummary: text("errorSummary"),
    versionNo: bigintUnsigned("versionNo").notNull().default(1),
    createdAt: timestamp("createdAt").notNull().default(currentTimestamp()),
    updatedAt: timestamp("updatedAt").notNull().default(currentTimestamp()),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("Invocation_tenant_id_uq").on(t.tenantId, t.id),
    jobUq: uniqueIndex("Invocation_tenant_job_uq").on(t.tenantId, t.jobId),
    turnSequenceUq: uniqueIndex("Invocation_tenant_turn_sequence_uq").on(
      t.tenantId,
      t.turnId,
      t.invocationSequence,
    ),
    stateIdx: index("Invocation_tenant_state_updated_idx").on(
      t.tenantId,
      t.executionState,
      t.updatedAt,
    ),
    checkpointIdx: index("Invocation_checkpoint_gate_deadline_idx").on(
      t.tenantId,
      t.checkpointGate,
      t.checkpointDeadline,
    ),
    subjectAllowed: check("Invocation_subject_allowed", sql`\`subjectType\` IN ('thread', 'job')`),
    kindAllowed: check(
      "Invocation_kind_allowed",
      sql`\`invocationKind\` IN ('initial', 'regenerate', 'job')`,
    ),
    stateAllowed: check(
      "Invocation_state_allowed",
      sql`\`executionState\` IN ('queued', 'running', 'waiting_user', 'completed', 'failed', 'cancelled', 'lost')`,
    ),
    gateAllowed: check(
      "Invocation_checkpoint_gate_allowed",
      sql`\`checkpointGate\` IN ('open', 'quiescing', 'frozen', 'releasing')`,
    ),
    subjectShape: check(
      "Invocation_subject_shape",
      sql`(\`subjectType\` = 'thread' AND \`threadId\` IS NOT NULL AND \`turnId\` IS NOT NULL AND \`triggerItemId\` IS NOT NULL AND \`jobId\` IS NULL) OR (\`subjectType\` = 'job' AND \`jobId\` IS NOT NULL AND \`threadId\` IS NULL AND \`turnId\` IS NULL AND \`triggerItemId\` IS NULL AND \`invocationKind\` = 'job' AND \`invocationSequence\` = 1)`,
    ),
    resultTerminalShape: check(
      "Invocation_result_terminal_shape",
      sql`((\`resultRef\` IS NULL AND \`resultDigest\` IS NULL) OR (\`resultRef\` IS NOT NULL AND \`resultDigest\` IS NOT NULL)) AND ((\`finishedAt\` IS NULL AND \`executionState\` NOT IN ('completed', 'failed', 'cancelled', 'lost')) OR (\`finishedAt\` IS NOT NULL AND \`executionState\` IN ('completed', 'failed', 'cancelled', 'lost')))`,
    ),
    checkpointOwnerShape: check(
      "Invocation_checkpoint_owner_shape",
      sql`\`checkpointGate\` = 'open' OR \`checkpointOwnerId\` IS NOT NULL`,
    ),
    // releasing 必须能定位到"要解冻什么"：intentId（Broker 侧安全点文件）与已持久证据。
    checkpointReleasingShape: check(
      "Invocation_checkpoint_releasing_shape",
      sql`\`checkpointGate\` <> 'releasing' OR (\`checkpointIntentId\` IS NOT NULL AND \`checkpointPreparedEvidence\` IS NOT NULL)`,
    ),
  }),
);
export type Invocation = InferSelectModel<typeof invocationTable>;
export type NewInvocation = InferInsertModel<typeof invocationTable>;
export type InvocationRow = Invocation;
export type NewInvocationRow = NewInvocation;

export const executionBindingTable = mysqlTable(
  "ExecutionBinding",
  {
    invocationId: ascii("invocationId", 36).primaryKey().notNull(),
    tenantId: ascii("tenantId", 36).notNull(),
    runtimeRevisionId: ascii("runtimeRevisionId", 36).notNull(),
    deploymentRouteId: ascii("deploymentRouteId", 36).notNull(),
    routeRevisionId: ascii("routeRevisionId", 36).notNull(),
    routeActivationId: ascii("routeActivationId", 36).notNull(),
    policyRevisionId: ascii("policyRevisionId", 36).notNull(),
    governanceConfigRevisionId: ascii("governanceConfigRevisionId", 36).notNull(),
    runtimePublicationRecordId: ascii("runtimePublicationRecordId", 36).notNull(),
    conformanceRunId: ascii("conformanceRunId", 36).notNull(),
    modelProvider: ascii("modelProvider", 128).notNull(),
    modelId: varchar("modelId", { length: 256 }).notNull(),
    modelRevisionRef: varchar("modelRevisionRef", { length: 512 }),
    policyRulesDigest: ascii("policyRulesDigest", 71).notNull(),
    governanceConfigDigest: ascii("governanceConfigDigest", 71).notNull(),
    routeContentDigest: ascii("routeContentDigest", 71).notNull(),
    runtimeConfigDigest: ascii("runtimeConfigDigest", 71).notNull(),
    runtimeTargetDigest: ascii("runtimeTargetDigest", 71).notNull(),
    capabilityManifestDigest: ascii("capabilityManifestDigest", 71).notNull(),
    resolutionInputDigest: ascii("resolutionInputDigest", 71).notNull(),
    capabilityCatalogDigest: ascii("capabilityCatalogDigest", 71).notNull(),
    configHash: ascii("configHash", 71).notNull(),
    runtimeEvidenceKind: ascii("runtimeEvidenceKind", 32).$type<RuntimeEvidenceKind>().notNull(),
    runtimeArtifactId: ascii("runtimeArtifactId", 36),
    runtimeArtifactDigest: ascii("runtimeArtifactDigest", 71),
    runtimeAttestationIds: json("runtimeAttestationIds").$type<string[]>().notNull(),
    projectionVersionNo: bigintUnsigned("projectionVersionNo").notNull(),
    capabilityCatalogJson: json("capabilityCatalogJson").notNull(),
    capabilityCatalogVersion: ascii("capabilityCatalogVersion", 32).notNull(),
    capabilityCatalogSourceRefs: json("capabilityCatalogSourceRefs").$type<string[]>().notNull(),
    capabilityCatalogCreatedAt: timestamp("capabilityCatalogCreatedAt").notNull(),
    principalType: ascii("principalType", 32).$type<"user" | "service">().notNull(),
    principalId: ascii("principalId", 128).notNull(),
    principalSource: ascii("principalSource", 32)
      .$type<"authenticated_user" | "trusted_service">()
      .notNull(),
    principalFrozenAt: timestamp("principalFrozenAt").notNull(),
    environmentMode: ascii("environmentMode", 32)
      .$type<"MANAGED" | "NO_PLATFORM_ENVIRONMENT">()
      .notNull(),
    environmentDefinitionRevisionId: ascii("environmentDefinitionRevisionId", 36),
    workspaceBindingId: ascii("workspaceBindingId", 36).notNull(),
    /**
     * T33：冻结的初始压缩材料引用（同 tenant 的 ContextCheckpoint.id）。
     *
     * NULL 只代表「Binding 创建时未选择初始压缩材料」，不是「稍后自动挑选最新」。
     * 非 null 一旦绑定即不可运行时替换；失效/损坏/撤权必须显式失败，
     * 需要改变选择只能创建新 Invocation。复合外键保证同 tenant 存在性。
     */
    initialContextCheckpointId: ascii("initialContextCheckpointId", 36),
    boundAt: timestamp("boundAt").notNull().default(currentTimestamp()),
  },
  (t) => ({
    tenantInvocationUq: uniqueIndex("ExecutionBinding_tenant_invocation_uq").on(
      t.tenantId,
      t.invocationId,
    ),
    invocationFk: foreignKey({
      name: "ExecutionBinding_tenant_invocation_fk",
      columns: [t.tenantId, t.invocationId],
      foreignColumns: [invocationTable.tenantId, invocationTable.id],
    }),
    runtimeIdx: index("ExecutionBinding_tenant_runtime_revision_idx").on(
      t.tenantId,
      t.runtimeRevisionId,
    ),
    environmentIdx: index("ExecutionBinding_tenant_environment_revision_idx").on(
      t.tenantId,
      t.environmentDefinitionRevisionId,
    ),
    workspaceIdx: index("ExecutionBinding_tenant_workspace_binding_idx").on(
      t.tenantId,
      t.workspaceBindingId,
    ),
    // T33：同 tenant 引用 ContextCheckpoint(tenantId, id)；跨 tenant 引用在 DB 层失败。
    initialContextCheckpointFk: foreignKey({
      name: "ExecutionBinding_tenant_initial_checkpoint_fk",
      columns: [t.tenantId, t.initialContextCheckpointId],
      foreignColumns: [contextCheckpoint.tenantId, contextCheckpoint.id],
    }),
    initialContextCheckpointIdx: index("ExecutionBinding_tenant_initial_checkpoint_idx").on(
      t.tenantId,
      t.initialContextCheckpointId,
    ),
    evidenceAllowed: check(
      "ExecutionBinding_runtime_evidence_allowed",
      sql`\`runtimeEvidenceKind\` IN ('hosted_artifact', 'external_endpoint')`,
    ),
    principalTypeAllowed: check(
      "ExecutionBinding_principal_type_allowed",
      sql`\`principalType\` IN ('user', 'service')`,
    ),
    principalSourceAllowed: check(
      "ExecutionBinding_principal_source_allowed",
      sql`\`principalSource\` IN ('authenticated_user', 'trusted_service')`,
    ),
    environmentModeAllowed: check(
      "ExecutionBinding_environment_mode_allowed",
      sql`\`environmentMode\` IN ('MANAGED', 'NO_PLATFORM_ENVIRONMENT')`,
    ),
    environmentReferenceShape: check(
      "ExecutionBinding_environment_reference_shape",
      sql`(\`environmentMode\` = 'MANAGED' AND \`environmentDefinitionRevisionId\` IS NOT NULL) OR (\`environmentMode\` = 'NO_PLATFORM_ENVIRONMENT' AND \`environmentDefinitionRevisionId\` IS NULL)`,
    ),
    artifactEvidenceShape: check(
      "ExecutionBinding_artifact_evidence_shape",
      sql`(\`runtimeEvidenceKind\` = 'hosted_artifact' AND \`runtimeArtifactId\` IS NOT NULL AND \`runtimeArtifactDigest\` IS NOT NULL) OR (\`runtimeEvidenceKind\` = 'external_endpoint' AND \`runtimeArtifactId\` IS NULL AND \`runtimeArtifactDigest\` IS NULL)`,
    ),
  }),
);
export type ExecutionBinding = InferSelectModel<typeof executionBindingTable>;
export type NewExecutionBinding = InferInsertModel<typeof executionBindingTable>;
export type ExecutionBindingRow = ExecutionBinding;
export type NewExecutionBindingRow = NewExecutionBinding;

export const INVOCATION_ATTEMPT_STATES = [
  "queued",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled",
  "lost",
] as const;
export type InvocationAttemptState = (typeof INVOCATION_ATTEMPT_STATES)[number];
/** Attempt 终态：该代际已收口，不可再承载任何执行权（唯一实现，避免各处重抄）。 */
export const INVOCATION_ATTEMPT_TERMINAL_STATES: readonly InvocationAttemptState[] = [
  "completed",
  "failed",
  "cancelled",
  "lost",
];
export const INVOCATION_PREPARATION_STATES = [
  "pending",
  "preparing",
  "prepared",
  "failed",
] as const;
export type InvocationPreparationState = (typeof INVOCATION_PREPARATION_STATES)[number];

export const invocationAttemptTable = mysqlTable(
  "InvocationAttempt",
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
    attemptNo: int("attemptNo", { unsigned: true }).notNull(),
    attemptState: ascii("attemptState", 32)
      .$type<InvocationAttemptState>()
      .notNull()
      .default("queued"),
    preparationState: ascii("preparationState", 32)
      .$type<InvocationPreparationState>()
      .notNull()
      .default("pending"),
    preparationEvidence: json("preparationEvidence"),
    preparationDigest: ascii("preparationDigest", 71),
    preparedAt: timestamp("preparedAt"),
    preparationLeaseOwner: ascii("preparationLeaseOwner", 128),
    preparationLeaseExpiresAt: timestamp("preparationLeaseExpiresAt"),
    nextPreparationAt: timestamp("nextPreparationAt"),
    preparationCount: int("preparationCount", { unsigned: true }).notNull().default(0),
    resumeAnchor: json("resumeAnchor"),
    resumeAnchorDigest: ascii("resumeAnchorDigest", 71),
    filesystemCheckpointId: ascii("filesystemCheckpointId", 36),
    retryReasonCode: ascii("retryReasonCode", 64),
    startedAt: timestamp("startedAt"),
    finishedAt: timestamp("finishedAt"),
    errorCode: ascii("errorCode", 64),
    errorSummary: text("errorSummary"),
    versionNo: bigintUnsigned("versionNo").notNull().default(1),
    createdAt: timestamp("createdAt").notNull().default(currentTimestamp()),
    updatedAt: timestamp("updatedAt").notNull().default(currentTimestamp()),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("InvocationAttempt_tenant_id_uq").on(t.tenantId, t.id),
    attemptNoUq: uniqueIndex("InvocationAttempt_tenant_invocation_attempt_no_uq").on(
      t.tenantId,
      t.invocationId,
      t.attemptNo,
    ),
    invocationAttemptIdUq: uniqueIndex("InvocationAttempt_tenant_invocation_id_uq").on(
      t.tenantId,
      t.invocationId,
      t.id,
    ),
    preparationIdx: index("InvocationAttempt_preparation_idx").on(
      t.preparationState,
      t.nextPreparationAt,
      t.preparationLeaseExpiresAt,
    ),
    attemptStateAllowed: check(
      "InvocationAttempt_state_allowed",
      sql`\`attemptState\` IN ('queued', 'running', 'suspended', 'completed', 'failed', 'cancelled', 'lost')`,
    ),
    preparationStateAllowed: check(
      "InvocationAttempt_preparation_state_allowed",
      sql`\`preparationState\` IN ('pending', 'preparing', 'prepared', 'failed')`,
    ),
    attemptNoPositive: check("InvocationAttempt_attempt_no_positive", sql`\`attemptNo\` >= 1`),
    preparationEvidenceShape: check(
      "InvocationAttempt_preparation_evidence_shape",
      sql`(\`preparationState\` = 'prepared' AND \`preparationEvidence\` IS NOT NULL AND \`preparationDigest\` IS NOT NULL AND \`preparedAt\` IS NOT NULL) OR \`preparationState\` <> 'prepared'`,
    ),
    terminalShape: check(
      "InvocationAttempt_terminal_shape",
      sql`((\`finishedAt\` IS NULL AND \`attemptState\` NOT IN ('completed', 'failed', 'cancelled', 'lost')) OR (\`finishedAt\` IS NOT NULL AND \`attemptState\` IN ('completed', 'failed', 'cancelled', 'lost')))`,
    ),
  }),
);
export type InvocationAttempt = InferSelectModel<typeof invocationAttemptTable>;
export type NewInvocationAttempt = InferInsertModel<typeof invocationAttemptTable>;

export const EXECUTION_OWNERSHIP_STATES = ["active", "released", "lost", "revoked"] as const;
export type ExecutionOwnershipState = (typeof EXECUTION_OWNERSHIP_STATES)[number];
export const EXECUTION_PHASES = ["activating", "dispatching", "executing", "suspending"] as const;
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

export const executionOwnershipTable = mysqlTable(
  "ExecutionOwnership",
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
    environmentLeaseId: ascii("environmentLeaseId", 36),
    leaseEpoch: bigintUnsigned("leaseEpoch").notNull(),
    ownershipState: ascii("ownershipState", 32)
      .$type<ExecutionOwnershipState>()
      .notNull()
      .default("active"),
    activeSlot: tinyint("activeSlot").generatedAlwaysAs(
      sql`CASE \`ownershipState\` WHEN 'active' THEN 1 ELSE NULL END`,
      { mode: "stored" },
    ),
    executionPhase: ascii("executionPhase", 32)
      .$type<ExecutionPhase>()
      .notNull()
      .default("activating"),
    acquiredAt: timestamp("acquiredAt").notNull(),
    lastHeartbeatAt: timestamp("lastHeartbeatAt").notNull(),
    leaseExpiresAt: timestamp("leaseExpiresAt").notNull(),
    dispatchDeadline: timestamp("dispatchDeadline").notNull(),
    releasedAt: timestamp("releasedAt"),
    reasonCode: ascii("reasonCode", 64),
    reasonDetail: json("reasonDetail"),
    acquiredByType: ascii("acquiredByType", 32).notNull(),
    acquiredById: ascii("acquiredById", 128).notNull(),
    closedByType: ascii("closedByType", 16),
    closedById: ascii("closedById", 128),
    workspaceWriterGeneration: bigintUnsigned("workspaceWriterGeneration"),
    activationEvidence: json("activationEvidence"),
    activationDigest: ascii("activationDigest", 71),
    activatedAt: timestamp("activatedAt"),
    versionNo: bigintUnsigned("versionNo").notNull().default(1),
    createdAt: timestamp("createdAt").notNull().default(currentTimestamp()),
    updatedAt: timestamp("updatedAt").notNull().default(currentTimestamp()),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("ExecutionOwnership_tenant_id_uq").on(t.tenantId, t.id),
    epochUq: uniqueIndex("ExecutionOwnership_tenant_invocation_epoch_uq").on(
      t.tenantId,
      t.invocationId,
      t.leaseEpoch,
    ),
    activeUq: uniqueIndex("ExecutionOwnership_tenant_invocation_active_slot_uq").on(
      t.tenantId,
      t.invocationId,
      t.activeSlot,
    ),
    stateExpiryIdx: index("ExecutionOwnership_state_expiry_idx").on(
      t.ownershipState,
      t.leaseExpiresAt,
    ),
    attemptEpochIdx: index("ExecutionOwnership_tenant_attempt_epoch_idx").on(
      t.tenantId,
      t.attemptId,
      t.leaseEpoch,
    ),
    stateAllowed: check(
      "ExecutionOwnership_state_allowed",
      sql`\`ownershipState\` IN ('active', 'released', 'lost', 'revoked')`,
    ),
    executionPhaseAllowed: check(
      "ExecutionOwnership_phase_allowed",
      sql`\`executionPhase\` IN ('activating', 'dispatching', 'executing', 'suspending')`,
    ),
    acquiredByAllowed: check(
      "ExecutionOwnership_acquired_by_allowed",
      sql`\`acquiredByType\` IN ('system', 'service')`,
    ),
    epochPositive: check("ExecutionOwnership_epoch_positive", sql`\`leaseEpoch\` >= 1`),
    attemptFk: foreignKey({
      name: "ExecutionOwnership_tenant_invocation_attempt_fk",
      columns: [t.tenantId, t.invocationId, t.attemptId],
      foreignColumns: [
        invocationAttemptTable.tenantId,
        invocationAttemptTable.invocationId,
        invocationAttemptTable.id,
      ],
    }),
    identityUq: uniqueIndex("ExecutionOwnership_tenant_invocation_attempt_id_epoch_uq").on(
      t.tenantId,
      t.invocationId,
      t.attemptId,
      t.id,
      t.leaseEpoch,
    ),
    leaseExpiryShape: check(
      "ExecutionOwnership_lease_expiry_shape",
      sql`\`leaseExpiresAt\` > \`acquiredAt\``,
    ),
    activeShape: check(
      "ExecutionOwnership_active_shape",
      sql`(\`ownershipState\` = 'active' AND \`releasedAt\` IS NULL) OR (\`ownershipState\` <> 'active' AND \`releasedAt\` IS NOT NULL)`,
    ),
    executingActivationShape: check(
      "ExecutionOwnership_executing_activation_shape",
      sql`\`executionPhase\` <> 'executing' OR (\`activatedAt\` IS NOT NULL AND \`activationDigest\` IS NOT NULL)`,
    ),
  }),
);
export type ExecutionOwnership = InferSelectModel<typeof executionOwnershipTable>;
export type NewExecutionOwnership = InferInsertModel<typeof executionOwnershipTable>;

export const RUNTIME_SESSION_BINDING_STATES = [
  "prepared",
  "dispatching",
  "active",
  "closed",
  "lost",
] as const;
export type RuntimeSessionBindingState = (typeof RUNTIME_SESSION_BINDING_STATES)[number];
export const RUNTIME_SESSION_INTENT_TYPES = ["start", "resume"] as const;
export type RuntimeSessionIntentType = (typeof RUNTIME_SESSION_INTENT_TYPES)[number];

export const runtimeSessionBindingTable = mysqlTable(
  "RuntimeSessionBinding",
  {
    id: ascii("id", 36)
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: ascii("tenantId", 36)
      .notNull()
      .references(() => tenant.id),
    invocationId: ascii("invocationId", 36).notNull(),
    attemptId: ascii("attemptId", 36).notNull(),
    ownershipId: ascii("ownershipId", 36).notNull(),
    runtimeRevisionId: ascii("runtimeRevisionId", 36).notNull(),
    leaseEpoch: bigintUnsigned("leaseEpoch").notNull(),
    bindingState: ascii("bindingState", 32)
      .$type<RuntimeSessionBindingState>()
      .notNull()
      .default("prepared"),
    intentType: ascii("intentType", 32).$type<RuntimeSessionIntentType>().notNull(),
    startIntentKey: ascii("startIntentKey", 128).notNull(),
    semanticRequestJson: json("semanticRequestJson"),
    semanticRequestDigest: ascii("semanticRequestDigest", 71),
    intentFrozenAt: timestamp("intentFrozenAt"),
    remoteSessionRef: varchar("remoteSessionRef", { length: 512 }),
    remoteExecutionRef: varchar("remoteExecutionRef", { length: 512 }),
    runtimeCapabilitiesJson: json("runtimeCapabilitiesJson"),
    transportAcknowledgement: json("transportAcknowledgement"),
    acknowledgedAt: timestamp("acknowledgedAt"),
    startedEventId: ascii("startedEventId", 36),
    dispatchCount: int("dispatchCount", { unsigned: true }).notNull().default(0),
    nextDispatchAt: timestamp("nextDispatchAt"),
    dispatchLeaseOwner: ascii("dispatchLeaseOwner", 128),
    dispatchLeaseExpiresAt: timestamp("dispatchLeaseExpiresAt"),
    lastDispatchAt: timestamp("lastDispatchAt"),
    lastErrorCode: ascii("lastErrorCode", 64),
    closedAt: timestamp("closedAt"),
    versionNo: bigintUnsigned("versionNo").notNull().default(1),
    createdAt: timestamp("createdAt").notNull().default(currentTimestamp()),
    updatedAt: timestamp("updatedAt").notNull().default(currentTimestamp()),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("RuntimeSessionBinding_tenant_id_uq").on(t.tenantId, t.id),
    ownershipUq: uniqueIndex("RuntimeSessionBinding_tenant_ownership_uq").on(
      t.tenantId,
      t.ownershipId,
    ),
    intentUq: uniqueIndex("RuntimeSessionBinding_tenant_start_intent_uq").on(
      t.tenantId,
      t.startIntentKey,
    ),
    dispatchIdx: index("RuntimeSessionBinding_state_dispatch_idx").on(
      t.bindingState,
      t.nextDispatchAt,
      t.dispatchLeaseExpiresAt,
    ),
    revisionExecutionIdx: index("RuntimeSessionBinding_tenant_revision_execution_idx").on(
      t.tenantId,
      t.runtimeRevisionId,
      t.remoteExecutionRef,
    ),
    stateAllowed: check(
      "RuntimeSessionBinding_state_allowed",
      sql`\`bindingState\` IN ('prepared', 'dispatching', 'active', 'closed', 'lost')`,
    ),
    intentAllowed: check(
      "RuntimeSessionBinding_intent_allowed",
      sql`\`intentType\` IN ('start', 'resume')`,
    ),
    requestDigestShape: check(
      "RuntimeSessionBinding_request_digest_shape",
      sql`(\`semanticRequestJson\` IS NULL AND \`semanticRequestDigest\` IS NULL) OR (\`semanticRequestJson\` IS NOT NULL AND \`semanticRequestDigest\` IS NOT NULL)`,
    ),
    activeStartedShape: check(
      "RuntimeSessionBinding_active_started_shape",
      sql`\`bindingState\` <> 'active' OR \`startedEventId\` IS NOT NULL`,
    ),
    ownershipFk: foreignKey({
      name: "RuntimeSessionBinding_tenant_owner_fk",
      columns: [t.tenantId, t.invocationId, t.attemptId, t.ownershipId, t.leaseEpoch],
      foreignColumns: [
        executionOwnershipTable.tenantId,
        executionOwnershipTable.invocationId,
        executionOwnershipTable.attemptId,
        executionOwnershipTable.id,
        executionOwnershipTable.leaseEpoch,
      ],
    }),
    identityUq: uniqueIndex("RuntimeSessionBinding_identity_uq").on(
      t.tenantId,
      t.invocationId,
      t.attemptId,
      t.ownershipId,
      t.leaseEpoch,
      t.id,
    ),
    dispatchFreezeShape: check(
      "RuntimeSessionBinding_dispatch_freeze_shape",
      sql`((\`semanticRequestJson\` IS NULL AND \`semanticRequestDigest\` IS NULL AND \`intentFrozenAt\` IS NULL) OR (\`semanticRequestJson\` IS NOT NULL AND \`semanticRequestDigest\` IS NOT NULL AND \`intentFrozenAt\` IS NOT NULL)) AND (\`bindingState\` NOT IN ('dispatching', 'active') OR (\`semanticRequestJson\` IS NOT NULL AND \`semanticRequestDigest\` IS NOT NULL AND \`intentFrozenAt\` IS NOT NULL)) AND (\`bindingState\` <> 'active' OR (\`remoteSessionRef\` IS NOT NULL AND \`remoteExecutionRef\` IS NOT NULL AND \`startedEventId\` IS NOT NULL))`,
    ),
  }),
);
export type RuntimeSessionBinding = InferSelectModel<typeof runtimeSessionBindingTable>;
export type NewRuntimeSessionBinding = InferInsertModel<typeof runtimeSessionBindingTable>;

export const runtimeEventIngressTable = mysqlTable(
  "RuntimeEventIngress",
  {
    id: ascii("id", 36)
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: ascii("tenantId", 36)
      .notNull()
      .references(() => tenant.id),
    invocationId: ascii("invocationId", 36).notNull(),
    acceptedAttemptId: ascii("acceptedAttemptId", 36).notNull(),
    acceptedOwnershipId: ascii("acceptedOwnershipId", 36).notNull(),
    acceptedSessionId: ascii("acceptedSessionId", 36).notNull(),
    acceptedEpoch: bigintUnsigned("acceptedEpoch").notNull(),
    producerEventId: ascii("producerEventId", 128).notNull(),
    producerSequence: bigintUnsigned("producerSequence").notNull(),
    candidateType: ascii("candidateType", 64).notNull(),
    schemaVersion: int("schemaVersion", { unsigned: true }).notNull().default(1),
    payloadHash: ascii("payloadHash", 71).notNull(),
    payloadJson: json("payloadJson").notNull(),
    receiptJson: json("receiptJson").notNull(),
    recoveryVersionAfter: bigintUnsigned("recoveryVersionAfter").notNull(),
    receivedAt: timestamp("receivedAt").notNull(),
    acceptedAt: timestamp("acceptedAt").notNull(),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("RuntimeEventIngress_tenant_id_uq").on(t.tenantId, t.id),
    eventUq: uniqueIndex("RuntimeEventIngress_tenant_invocation_event_uq").on(
      t.tenantId,
      t.invocationId,
      t.producerEventId,
    ),
    sequenceUq: uniqueIndex("RuntimeEventIngress_tenant_invocation_sequence_uq").on(
      t.tenantId,
      t.invocationId,
      t.producerSequence,
    ),
    acceptedIdx: index("RuntimeEventIngress_tenant_owner_sequence_idx").on(
      t.tenantId,
      t.acceptedOwnershipId,
      t.producerSequence,
    ),
    positive: check(
      "RuntimeEventIngress_sequence_positive",
      sql`\`producerSequence\` >= 1 AND \`acceptedEpoch\` >= 1`,
    ),
    sessionFk: foreignKey({
      name: "RuntimeEventIngress_tenant_session_fk",
      columns: [
        t.tenantId,
        t.invocationId,
        t.acceptedAttemptId,
        t.acceptedOwnershipId,
        t.acceptedEpoch,
        t.acceptedSessionId,
      ],
      foreignColumns: [
        runtimeSessionBindingTable.tenantId,
        runtimeSessionBindingTable.invocationId,
        runtimeSessionBindingTable.attemptId,
        runtimeSessionBindingTable.ownershipId,
        runtimeSessionBindingTable.leaseEpoch,
        runtimeSessionBindingTable.id,
      ],
    }),
    payloadShape: check(
      "RuntimeEventIngress_payload_shape",
      sql`JSON_LENGTH(\`payloadJson\`) IS NOT NULL AND JSON_LENGTH(\`receiptJson\`) IS NOT NULL AND \`payloadHash\` REGEXP '^sha256:[0-9a-f]{64}$'`,
    ),
  }),
);
export type RuntimeEventIngress = InferSelectModel<typeof runtimeEventIngressTable>;
export type NewRuntimeEventIngress = InferInsertModel<typeof runtimeEventIngressTable>;
export type RuntimeEventIngressRow = RuntimeEventIngress;
export type NewRuntimeEventIngressRow = NewRuntimeEventIngress;

export const INVOCATION_COMMAND_TYPES = ["cancel", "resume", "steer", "checkpoint"] as const;
export type InvocationCommandType = (typeof INVOCATION_COMMAND_TYPES)[number];
export const INVOCATION_COMMAND_STATES = [
  "queued",
  "dispatched",
  "acknowledged",
  "failed",
] as const;
export type InvocationCommandState = (typeof INVOCATION_COMMAND_STATES)[number];

export const invocationCommandTable = mysqlTable(
  "InvocationCommand",
  {
    id: ascii("id", 36)
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: ascii("tenantId", 36)
      .notNull()
      .references(() => tenant.id),
    invocationId: ascii("invocationId", 36).notNull(),
    commandType: ascii("commandType", 32).$type<InvocationCommandType>().notNull(),
    commandState: ascii("commandState", 32)
      .$type<InvocationCommandState>()
      .notNull()
      .default("queued"),
    idempotencyKey: ascii("idempotencyKey", 128).notNull(),
    payloadJson: json("payloadJson").notNull(),
    payloadDigest: ascii("payloadDigest", 71).notNull(),
    targetOwnershipId: ascii("targetOwnershipId", 36),
    targetSessionId: ascii("targetSessionId", 36),
    requestedByType: ascii("requestedByType", 16).notNull(),
    requestedById: ascii("requestedById", 128).notNull(),
    dispatchCount: int("dispatchCount", { unsigned: true }).notNull().default(0),
    nextDispatchAt: timestamp("nextDispatchAt"),
    dispatchLeaseOwner: ascii("dispatchLeaseOwner", 128),
    dispatchLeaseExpiresAt: timestamp("dispatchLeaseExpiresAt"),
    receiptJson: json("receiptJson"),
    lastErrorCode: ascii("lastErrorCode", 64),
    completedAt: timestamp("completedAt"),
    versionNo: bigintUnsigned("versionNo").notNull().default(1),
    createdAt: timestamp("createdAt").notNull().default(currentTimestamp()),
    updatedAt: timestamp("updatedAt").notNull().default(currentTimestamp()),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("InvocationCommand_tenant_id_uq").on(t.tenantId, t.id),
    idempotencyUq: uniqueIndex("InvocationCommand_tenant_invocation_idempotency_uq").on(
      t.tenantId,
      t.invocationId,
      t.idempotencyKey,
    ),
    dispatchIdx: index("InvocationCommand_state_dispatch_idx").on(
      t.commandState,
      t.nextDispatchAt,
      t.dispatchLeaseExpiresAt,
    ),
    typeAllowed: check(
      "InvocationCommand_type_allowed",
      sql`\`commandType\` IN ('cancel', 'resume', 'steer', 'checkpoint')`,
    ),
    stateAllowed: check(
      "InvocationCommand_state_allowed",
      sql`\`commandState\` IN ('queued', 'dispatched', 'acknowledged', 'failed')`,
    ),
    invocationFk: foreignKey({
      name: "InvocationCommand_tenant_invocation_fk",
      columns: [t.tenantId, t.invocationId],
      foreignColumns: [invocationTable.tenantId, invocationTable.id],
    }),
    commandDigestShape: check(
      "InvocationCommand_digest_shape",
      sql`\`payloadDigest\` LIKE 'sha256:%'`,
    ),
  }),
);
export type InvocationCommand = InferSelectModel<typeof invocationCommandTable>;
export type NewInvocationCommand = InferInsertModel<typeof invocationCommandTable>;
