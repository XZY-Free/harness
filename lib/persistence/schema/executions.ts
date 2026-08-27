/**
 * 稳定 Executions Schema — 正式控制面职责命名。
 *
 * 本文件是 Invocation / ExecutionBinding / InvocationAttempt / ExecutionOwnership /
 * RuntimeSessionBinding / RuntimeEventIngress 的单一物理 Schema 权威（docs/V12/01 §20 / §29 H）。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import { sql } from "drizzle-orm";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  check,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── Invocation Kind ───────────────────────────────────────

/**
 * Invocation 类型（）。
 * - initial：Turn 或 Job 的首次执行。
 * - regenerate：Regenerate 创建的新 Invocation，替代原 Invocation。
 * - job：后台 Job 触发的执行。
 */
export const INVOCATION_KINDS = ["initial", "regenerate", "job"] as const;
export type InvocationKind = (typeof INVOCATION_KINDS)[number];

// ─── Invocation Execution State ────────────────────────────

/**
 * Invocation 执行状态（）。
 * - queued：已排队等待 Runtime。
 * - running：Runtime 正在执行。
 * - waiting_user：等待用户操作。
 * - completed：正常完成（终态）。
 * - failed：执行失败（终态）。
 * - cancelled：被取消（终态）。
 * - lost：心跳超时，被标记为丢失（终态）。
 */
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

/** Invocation 终态集合（不可恢复）。 */
export const INVOCATION_TERMINAL_STATES: readonly InvocationExecutionState[] = [
  "completed",
  "failed",
  "cancelled",
  "lost",
];

// ─── Invocation ────────────────────────────────────────────

/**
 * Invocation 表：一次 AgentRevision + RuntimeRevision 的执行（L366-387）。
 *
 * 关键约束：
 * - turnId/jobId 恰有一个非空（应用层校验，DB 不加 CHECK）。
 * - invocationSequence 在 Turn 或 Job 内单调递增（UNIQUE(threadId, invocationSequence) / UNIQUE(jobId, invocationSequence)）。
 * - Regenerate 创建新 Invocation（replacesInvocationId 指向原 Invocation），仍属于原 Turn。
 * - 一个 Invocation 必须且只能属于一个 Turn 或一个 Job。
 * - executionState 状态机：queued → running → waiting_user → running → completed/failed/cancelled/lost。
 */
export const invocationTable = mysqlTable(
  "Invocation",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 会话执行时存在；后台 Job 执行时为空。 */
    threadId: varchar("threadId", { length: 36 }),
    /** 会话执行时存在；后台 Job 执行时为空。 */
    turnId: varchar("turnId", { length: 36 }),
    /** 后台执行时存在；会话执行时为空。 */
    jobId: varchar("jobId", { length: 36 }),
    /** Turn 或 Job 内递增序号。 */
    invocationSequence: bigint("invocationSequence", { mode: "number" }).notNull(),
    invocationKind: mysqlEnum("invocationKind", INVOCATION_KINDS).notNull(),
    executionState: mysqlEnum("executionState", INVOCATION_EXECUTION_STATES)
      .notNull()
      .default("queued"),
    /** 输入 Item（通常是 user_message）。 */
    triggerItemId: varchar("triggerItemId", { length: 36 }),
    /** Regenerate 替代的原 Invocation id。 */
    replacesInvocationId: varchar("replacesInvocationId", { length: 36 }),
    /** 会话 Invocation 当前输出 Item。 */
    outputItemId: varchar("outputItemId", { length: 36 }),
    /** Job 结果引用。 */
    resultRef: varchar("resultRef", { length: 512 }),
    /** 可选 runtime_session_binding 引用（会话路径执行时存在，基础 Route 为空）。 */
    runtimeSessionBindingId: varchar("runtimeSessionBindingId", { length: 36 }),
    runtimeExecutionRef: varchar("runtimeExecutionRef", { length: 256 }),
    startedAt: datetime("startedAt", { mode: "date", fsp: 3 }),
    finishedAt: datetime("finishedAt", { mode: "date", fsp: 3 }),
    lastHeartbeatAt: datetime("lastHeartbeatAt", { mode: "date", fsp: 3 }),
    errorCode: varchar("errorCode", { length: 128 }),
    errorSummary: text("errorSummary"),
    versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    threadSequenceUq: uniqueIndex("Invocation_thread_sequence_uq").on(
      t.threadId,
      t.invocationSequence,
    ),
    jobSequenceUq: uniqueIndex("Invocation_job_sequence_uq").on(t.jobId, t.invocationSequence),
    tenantStateIdx: index("Invocation_tenant_state_idx").on(t.tenantId, t.executionState),
    turnIdx: index("Invocation_turn_idx").on(t.turnId),
  }),
);

export type Invocation = InferSelectModel<typeof invocationTable>;
export type NewInvocation = InferInsertModel<typeof invocationTable>;

// ─── ExecutionBinding ──────────────────────────────────────

/**
 * ExecutionBinding 表：一条 Invocation 恰有一条不可变绑定（L405-423）。
 *
 * 关键约束：
 * - 一条 Invocation 恰有一条不可变绑定（invocationId 为主键，1:1）。
 * - 启动后不可变：只有 create，没有 update。
 * - Route 更新不修改进行中的 ExecutionBinding。
 * - configHash 由 computeBindingConfigHash 规范化字段后 SHA-256 计算。
 */
export const executionBindingTable = mysqlTable(
  "ExecutionBinding",
  {
    /** 主键 = invocationId（1:1）。 */
    invocationId: varchar("invocationId", { length: 36 })
      .primaryKey()
      .notNull()
      .references(() => invocationTable.id),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    /** null = 基础 Harness Route（无 Agent 资产约束，§8.3）。 */
    agentRevisionId: varchar("agentRevisionId", { length: 36 }),
    runtimeRevisionId: varchar("runtimeRevisionId", { length: 36 }).notNull(),
    deploymentRouteId: varchar("deploymentRouteId", { length: 36 }).notNull(),
    modelProvider: varchar("modelProvider", { length: 128 }).notNull(),
    modelId: varchar("modelId", { length: 256 }).notNull(),
    modelRevisionRef: varchar("modelRevisionRef", { length: 256 }),
    /** 可选 EnvironmentLease 引用（环境路径执行时存在，基础 Route 为空）。 */
    initialEnvironmentLeaseId: varchar("initialEnvironmentLeaseId", { length: 36 }),
    workspaceBindingId: varchar("workspaceBindingId", { length: 36 }),
    /** 冻结的 Permission Policy Revision id（NOT NULL；有效 Binding 永远非空，§10）。 */
    policyRevisionId: varchar("policyRevisionId", { length: 36 }).notNull(),
    /** 冻结的 Permission Policy rules digest（sha256: 前缀；必须与该 Revision rulesHash 一致，§9）。 */
    policyRulesDigest: varchar("policyRulesDigest", { length: 71 }).notNull(),
    /** 冻结的 Governance Config Revision id（NOT NULL，§9）。 */
    governanceConfigRevisionId: varchar("governanceConfigRevisionId", { length: 36 }).notNull(),
    /** 冻结的 Governance Config digest（sha256: 前缀；必须与该 Revision configDigest 一致，§9）。 */
    governanceConfigDigest: varchar("governanceConfigDigest", { length: 71 }).notNull(),
    contextCheckpointId: varchar("contextCheckpointId", { length: 36 }),
    routeRevisionId: varchar("routeRevisionId", { length: 36 }).notNull(),
    routeActivationId: varchar("routeActivationId", { length: 36 }).notNull(),
    routeContentDigest: varchar("routeContentDigest", { length: 71 }).notNull(),
    /** null = external_endpoint Runtime（无 Runtime Artifact，03 §3）。 */
    runtimeArtifactId: varchar("runtimeArtifactId", { length: 36 }),
    /** null = external_endpoint Runtime（03 §3）。 */
    runtimeArtifactDigest: varchar("runtimeArtifactDigest", { length: 71 }),
    /** 冻结的 Runtime 证据种类 — hosted 要求 artifact 全集；external 无 artifact（03 §3）。 */
    runtimeEvidenceKind: mysqlEnum("runtimeEvidenceKind", [
      "hosted_artifact",
      "external_endpoint",
    ]).notNull(),
    runtimeConfigDigest: varchar("runtimeConfigDigest", { length: 71 }).notNull(),
    /** 冻结的 Runtime 目标摘要 — 发布证据权威（03 §6）。 */
    runtimeTargetDigest: varchar("runtimeTargetDigest", { length: 71 }).notNull(),
    capabilityManifestDigest: varchar("capabilityManifestDigest", { length: 71 }).notNull(),
    // ─── Agent Contract 证据（Agent Route 必填，base route 为 null — 05 §5）────
    /** null = 基础 Harness Route（§18 not_applicable）。 */
    agentContractSnapshotId: varchar("agentContractSnapshotId", { length: 36 }),
    /** null = 基础 Harness Route（§18 not_applicable）。 */
    agentContractDigest: varchar("agentContractDigest", { length: 71 }),
    /** null = 基础 Harness Route（§18 not_applicable）。 */
    agentContextDigest: varchar("agentContextDigest", { length: 71 }),
    runtimeAttestationIds: json("runtimeAttestationIds").$type<string[]>().notNull(),
    /** null = 基础 Harness Route（§18 not_applicable）。 */
    agentPublicationRecordId: varchar("agentPublicationRecordId", { length: 36 }),
    runtimePublicationRecordId: varchar("runtimePublicationRecordId", { length: 36 }).notNull(),
    conformanceRunId: varchar("conformanceRunId", { length: 36 }).notNull(),
    /** 冻结解析时刻的请求参数 Digest。 */
    resolutionInputDigest: varchar("resolutionInputDigest", { length: 71 }).notNull(),
    /** Projection 版本号 — Binding 用此检测 Projection 滞后。 */
    projectionVersionNo: int("projectionVersionNo").notNull(),
    environmentDefinitionRevisionId: varchar("environmentDefinitionRevisionId", { length: 36 }),
    configHash: varchar("configHash", { length: 128 }).notNull(),
    boundAt: datetime("boundAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantIdx: index("ExecutionBinding_tenant_idx").on(t.tenantId),
    agentRevisionIdx: index("ExecutionBinding_agentRevision_idx").on(t.agentRevisionId),
    runtimeRevisionIdx: index("ExecutionBinding_runtimeRevision_idx").on(t.runtimeRevisionId),
    routeRevisionIdx: index("ExecutionBinding_routeRevision_idx").on(t.routeRevisionId),
    runtimeArtifactIdx: index("ExecutionBinding_runtimeArtifact_idx").on(t.runtimeArtifactId),
    conformanceRunIdx: index("ExecutionBinding_conformanceRun_idx").on(t.conformanceRunId),
    runtimeAttestationIdsNonEmpty: check(
      "ExecutionBinding_runtimeAttestationIds_non_empty",
      // external_endpoint Runtime 无 Artifact Attestation（03 §3，不伪造）→ 空数组合法；
      // hosted_artifact 仍要求非空全集。
      sql`JSON_TYPE(${t.runtimeAttestationIds}) = 'ARRAY' AND (JSON_LENGTH(${t.runtimeAttestationIds}) >= 1 OR ${t.runtimeEvidenceKind} = 'external_endpoint')`,
    ),
    // §10.3 Agent Evidence 条件性完整组：全部为空（base route，not_applicable）或 全部完整（agent route）。
    // Agent 是源码不可见黑盒 — Agent Route 证据 = Contract 三元组 + Publication 引用，
    // 不含 source Artifact/Attestation（01 阶段收口）。禁止"随便 nullable"半完整组（禁 4 态模糊，§8.4）。
    agentEvidenceAllOrNothing: check(
      "ExecutionBinding_agentEvidence_all_or_nothing",
      sql`(
        ${t.agentRevisionId} IS NULL
        AND ${t.agentContractSnapshotId} IS NULL
        AND ${t.agentContractDigest} IS NULL
        AND ${t.agentContextDigest} IS NULL
        AND ${t.agentPublicationRecordId} IS NULL
      ) OR (
        ${t.agentRevisionId} IS NOT NULL
        AND ${t.agentContractSnapshotId} IS NOT NULL
        AND ${t.agentContractDigest} IS NOT NULL
        AND ${t.agentContextDigest} IS NOT NULL
        AND ${t.agentPublicationRecordId} IS NOT NULL
      )`,
    ),
  }),
);

export type ExecutionBinding = InferSelectModel<typeof executionBindingTable>;
export type NewExecutionBinding = InferInsertModel<typeof executionBindingTable>;

// ─── InvocationAttempt State ───────────────────────────────

/**
 * InvocationAttempt 状态（）。
 * - queued：已排队。
 * - running：Runtime 正在执行此 Attempt。
 * - completed：成功完成。
 * - failed：失败。
 * - cancelled：被取消。
 * - lost：心跳超时，被标记为丢失。
 */
export const INVOCATION_ATTEMPT_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "lost",
] as const;
export type InvocationAttemptState = (typeof INVOCATION_ATTEMPT_STATES)[number];

// ─── InvocationAttempt ─────────────────────────────────────

/**
 * InvocationAttempt 表：整个 Invocation 的基础设施重调度（L389-403）。
 *
 * 关键约束：
 * - attemptNo 从 1 开始递增（1 表示第一次基础设施重试）。
 * - Attempt 只表示整个 Invocation 基础设施重调度，不表示模型 Span、ToolCall。
 * - UNIQUE(invocationId, attemptNo) 保证 Attempt 编号唯一。
 * - 一次 Invocation 可以有多个 Attempt（基础设施重试）。
 */
export const invocationAttemptTable = mysqlTable(
  "InvocationAttempt",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    invocationId: varchar("invocationId", { length: 36 })
      .notNull()
      .references(() => invocationTable.id),
    /** 1 表示第一次基础设施重试。 */
    attemptNo: int("attemptNo").notNull(),
    attemptState: mysqlEnum("attemptState", INVOCATION_ATTEMPT_STATES).notNull().default("queued"),
    environmentLeaseId: varchar("environmentLeaseId", { length: 36 }),
    workerRef: varchar("workerRef", { length: 256 }),
    runtimeExecutionRef: varchar("runtimeExecutionRef", { length: 256 }),
    checkpointRef: varchar("checkpointRef", { length: 512 }),
    retryReasonCode: varchar("retryReasonCode", { length: 64 }),
    startedAt: datetime("startedAt", { mode: "date", fsp: 3 }),
    finishedAt: datetime("finishedAt", { mode: "date", fsp: 3 }),
    lastHeartbeatAt: datetime("lastHeartbeatAt", { mode: "date", fsp: 3 }),
    errorCode: varchar("errorCode", { length: 128 }),
    errorSummary: text("errorSummary"),
    /**
     * 基础设施 dispatch retry（Durable Dispatch / Retry Authority）。
     * dispatchAttemptCount = 该 Attempt 自身因 transient（网络/503）对 Runtime
     * startInvocation 累计发起的 HTTP 次数；区别于 attemptNo（第几次基础设施重调度）。
     */
    dispatchAttemptCount: int("dispatchAttemptCount").notNull().default(0),
    /** 下一次允许 Retry Worker 领取的时间（attemptState=queued + 非空 = 正式 retry work）。 */
    nextDispatchAt: datetime("nextDispatchAt", { mode: "date", fsp: 3 }),
    /** 当前持有 dispatch lease 的 Worker 身份（仅 lease 语义，非安全 Principal）。 */
    dispatchLeaseOwner: varchar("dispatchLeaseOwner", { length: 128 }),
    /** dispatch lease 过期时间；过期后其他 Worker 可接管。 */
    dispatchLeaseExpiresAt: datetime("dispatchLeaseExpiresAt", { mode: "date", fsp: 3 }),
    /** 最近一次 dispatch HTTP 发起时间。 */
    lastDispatchAttemptAt: datetime("lastDispatchAttemptAt", { mode: "date", fsp: 3 }),
    /** 最近一次 transient 错误的安全错误码（不存 endpoint/stack/token）。 */
    lastTransientErrorCode: varchar("lastTransientErrorCode", { length: 128 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    invocationAttemptUq: uniqueIndex("InvocationAttempt_invocation_attempt_uq").on(
      t.invocationId,
      t.attemptNo,
    ),
    invocationStateIdx: index("InvocationAttempt_invocation_state_idx").on(
      t.invocationId,
      t.attemptState,
    ),
    dispatchRetryIdx: index("InvocationAttempt_dispatch_retry_idx").on(
      t.attemptState,
      t.nextDispatchAt,
    ),
    dispatchLeaseIdx: index("InvocationAttempt_dispatch_lease_idx").on(t.dispatchLeaseExpiresAt),
  }),
);

export type InvocationAttempt = InferSelectModel<typeof invocationAttemptTable>;
export type NewInvocationAttempt = InferInsertModel<typeof invocationAttemptTable>;

// ─── ExecutionOwnership State ──────────────────────────────

/**
 * ExecutionOwnership 状态（）。
 * - active：当前持有执行权。
 * - released：主动释放。
 * - lost：心跳超时，被标记为丢失。
 */
export const EXECUTION_OWNERSHIP_STATES = ["active", "released", "lost"] as const;
export type ExecutionOwnershipState = (typeof EXECUTION_OWNERSHIP_STATES)[number];

// ─── ExecutionOwnership ────────────────────────────────────

/**
 * ExecutionOwnership 表：Invocation 执行权管理（L516-523）。
 *
 * 关键约束：
 * - leaseEpoch 单调递增，每次新获取执行权时 +1。
 * - UNIQUE(invocationId, leaseEpoch) 保证 lease epoch 唯一。
 * - 同一时刻只有一个 active ownership。
 */
export const executionOwnershipTable = mysqlTable(
  "ExecutionOwnership",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    invocationId: varchar("invocationId", { length: 36 }).notNull(),
    deviceId: varchar("deviceId", { length: 36 }),
    environmentLeaseId: varchar("environmentLeaseId", { length: 36 }),
    ownershipState: mysqlEnum("ownershipState", EXECUTION_OWNERSHIP_STATES)
      .notNull()
      .default("active"),
    leaseEpoch: bigint("leaseEpoch", { mode: "number" }).notNull(),
    acquiredAt: datetime("acquiredAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    lastHeartbeatAt: datetime("lastHeartbeatAt", { mode: "date", fsp: 3 }),
    releasedAt: datetime("releasedAt", { mode: "date", fsp: 3 }),
  },
  (t) => ({
    invocationEpochUq: uniqueIndex("ExecutionOwnership_invocation_epoch_uq").on(
      t.invocationId,
      t.leaseEpoch,
    ),
    invocationStateIdx: index("ExecutionOwnership_invocation_state_idx").on(
      t.invocationId,
      t.ownershipState,
    ),
  }),
);

export type ExecutionOwnership = InferSelectModel<typeof executionOwnershipTable>;
export type NewExecutionOwnership = InferInsertModel<typeof executionOwnershipTable>;

// ─── RuntimeSessionBinding State ──────────────────────────

/**
 * RuntimeSessionBinding 状态。
 * - active：Runtime 会话活跃。
 * - closed：显式关闭（Thread 关闭/删除、用户 reset、continuity policy 不允许复用、管理操作）。
 * - lost：Runtime 心跳超时或自报丢失。
 *
 * Turn completed 不是关闭条件（06 §3：Session 生命周期跨 Turn）。
 */
export const RUNTIME_SESSION_BINDING_STATES = ["active", "closed", "lost"] as const;
export type RuntimeSessionBindingState = (typeof RUNTIME_SESSION_BINDING_STATES)[number];

// ─── RuntimeSessionBinding ────────────────────────────────

/**
 * RuntimeSessionBinding 表：Runtime 维护的会话引用（06 §2）。
 *
 * 关键约束：
 * - threadId/jobId 恰有一个非空（应用层校验，DB 不加 CHECK）。
 * - externalSessionRef 由 Runtime 颁发（A2A = contextId，不透明引用），平台仅持久化，
 *   不解析其内容；禁止 contextId = threadId 硬编码（06 §2）。
 * - UNIQUE(runtimeRevisionId, externalSessionRef)：同一 RuntimeRevision 下外部会话引用唯一。
 * - Session 复用匹配维度：Tenant + Thread + AgentRevision + RuntimeRevision（06 §4）；
 *   agentRevisionId 可空 = 基础 Harness Route。
 * - 生命周期跨 Turn（06 §3）：关闭条件只有 Thread 关闭/删除、用户显式 reset、
 *   continuity policy 不允许复用、Runtime 报 lost、管理操作；Turn completed 不关闭。
 * - taskId（A2A Task）不进入 RuntimeSessionBinding（06 §5）：contextId 跨 Turn 连续，
 *   taskId 属于单个 Invocation（Invocation.runtimeExecutionRef）。
 */
export const runtimeSessionBindingTable = mysqlTable(
  "RuntimeSessionBinding",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    runtimeRevisionId: varchar("runtimeRevisionId", { length: 36 }).notNull(),
    /** Agent 维度（06 §4）：null = 基础 Harness Route（无 Agent 资产约束）。 */
    agentRevisionId: varchar("agentRevisionId", { length: 36 }),
    /** 会话执行时存在；后台 Job 执行时为空。 */
    threadId: varchar("threadId", { length: 36 }),
    /** 后台执行时存在；会话执行时为空。 */
    jobId: varchar("jobId", { length: 36 }),
    /** Runtime 维护的会话引用；平台仅持久化，不解析其内容。 */
    externalSessionRef: varchar("externalSessionRef", { length: 256 }).notNull(),
    bindingState: mysqlEnum("bindingState", RUNTIME_SESSION_BINDING_STATES)
      .notNull()
      .default("active"),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    lastUsedAt: datetime("lastUsedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    closedAt: datetime("closedAt", { mode: "date", fsp: 3 }),
  },
  (t) => ({
    runtimeExternalRefUq: uniqueIndex("RuntimeSessionBinding_runtime_external_ref_uq").on(
      t.runtimeRevisionId,
      t.externalSessionRef,
    ),
    threadIdx: index("RuntimeSessionBinding_thread_idx").on(t.threadId),
    jobIdx: index("RuntimeSessionBinding_job_idx").on(t.jobId),
  }),
);

export type RuntimeSessionBinding = InferSelectModel<typeof runtimeSessionBindingTable>;
export type NewRuntimeSessionBinding = InferInsertModel<typeof runtimeSessionBindingTable>;

// ─── RuntimeEventIngress State ─────────────────────────────

/**
 * RuntimeEventIngress 状态（L486-500）。
 * - accepted：候选事件已接收，尚未映射到平台 Thread/Turn/Item。
 * - mapped：已映射到 ThreadEvent/ThreadItem/JobEvent。
 * - rejected：因 hash 冲突等不可修复原因被拒绝。
 */
export const RUNTIME_EVENT_INGRESS_STATES = ["accepted", "mapped", "rejected"] as const;
export type RuntimeEventIngressState = (typeof RUNTIME_EVENT_INGRESS_STATES)[number];

// ─── Runtime Candidate Event Type ──────────────────────────

/**
 * Runtime Protocol 候选事件类型（持久批次账本）。
 *
 * 事实源：11-api-and-event-boundaries.md §4（Runtime Protocol）。
 * - progress.snapshot：进度快照（创建 user_guidance Item）。
 * - response.completed：正式回答完成（创建 agent_message Item + 终态）。
 * - user_action.requested：请求用户操作（创建 user_action Item + waiting_user）。
 * - execution.completed：执行正常完成（终态，无 final_item）。
 * - execution.failed：执行失败（终态）。
 * - execution.cancelled：执行被取消（终态）。
 *
 * transient 通道（response.delta/heartbeat/stdout/stderr）不进入持久账本。
 */
export const RUNTIME_CANDIDATE_EVENT_TYPES = [
  "progress.snapshot",
  "response.completed",
  "user_action.requested",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
] as const;
export type RuntimeCandidateEventType = (typeof RUNTIME_CANDIDATE_EVENT_TYPES)[number];

// ─── RuntimeEventIngress ──────────────────────────────────

/**
 * RuntimeEventIngress 表：Runtime 回传候选事件的持久批次账本（L486-500）。
 *
 * 关键约束：
 * - UNIQUE(invocationId, producerEventId)：Runtime 稳定事件 id 唯一。
 * - UNIQUE(invocationId, producerSequence)：Runtime 连续序号唯一。
 * - producerSequence 在整个 Invocation 内连续，不按 Attempt 重启。
 * - 相同 producerEventId/producerSequence 但 payloadHash 不同直接拒绝（hash 冲突）。
 * - 可重试的 Schema/大小错误不写 ingress 行、不消费序号。
 * - 身份、租户、hash 冲突等不可修复错误原子终止 Invocation。
 * - Runtime 不能指定 Thread/Job event sequence、Item id 或直接更新 Item（平台分配）。
 */
export const runtimeEventIngressTable = mysqlTable(
  "RuntimeEventIngress",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    invocationId: varchar("invocationId", { length: 36 })
      .notNull()
      .references(() => invocationTable.id),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** Runtime 稳定事件 id（幂等键 1）。 */
    producerEventId: varchar("producerEventId", { length: 128 }).notNull(),
    /** Runtime 连续序号（幂等键 2，整个 Invocation 内连续）。 */
    producerSequence: bigint("producerSequence", { mode: "number" }).notNull(),
    /** Runtime Protocol 候选事件类型。 */
    candidateType: varchar("candidateType", { length: 64 }).notNull(),
    schemaVersion: int("schemaVersion").notNull().default(1),
    /** 候选负载 SHA-256 hash（递归排序 key 后 sha256）。 */
    payloadHash: varchar("payloadHash", { length: 128 }).notNull(),
    /** 短期保存原候选负载，或对象引用；可为 null 用于诊断采样。 */
    payloadJson: json("payloadJson"),
    ingressState: mysqlEnum("ingressState", RUNTIME_EVENT_INGRESS_STATES)
      .notNull()
      .default("accepted"),
    /** 映射到 ThreadItem（mapped 时填）。 */
    mappedItemId: varchar("mappedItemId", { length: 36 }),
    /** 映射到 ThreadEvent（mapped 时填）。 */
    mappedThreadEventId: varchar("mappedThreadEventId", { length: 36 }),
    /** 映射到 JobEvent（后台 Job 路径执行时填充，否则为空）。 */
    mappedJobEventId: varchar("mappedJobEventId", { length: 36 }),
    receivedAt: datetime("receivedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    mappedAt: datetime("mappedAt", { mode: "date", fsp: 3 }),
    rejectedReason: varchar("rejectedReason", { length: 256 }),
  },
  (t) => ({
    invocationProducerEventUq: uniqueIndex("RuntimeEventIngress_invocation_producer_event_uq").on(
      t.invocationId,
      t.producerEventId,
    ),
    invocationProducerSeqUq: uniqueIndex("RuntimeEventIngress_invocation_producer_seq_uq").on(
      t.invocationId,
      t.producerSequence,
    ),
    invocationStateIdx: index("RuntimeEventIngress_invocation_state_idx").on(
      t.invocationId,
      t.ingressState,
    ),
  }),
);

export type RuntimeEventIngress = InferSelectModel<typeof runtimeEventIngressTable>;
export type NewRuntimeEventIngress = InferInsertModel<typeof runtimeEventIngressTable>;

// ─── Canonical Row 别名（领域面向的行类型名）────────────────
export type ExecutionBindingRow = ExecutionBinding;
export type NewExecutionBindingRow = NewExecutionBinding;
export type InvocationRow = Invocation;
export type NewInvocationRow = NewInvocation;
