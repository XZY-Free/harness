/**
 * V11 控制面 schema：Runtime 与 RuntimeRevision。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §4.3、
 *         ../v11-agentkit-platform/09-unified-domain-model.md §3.2、
 *         ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md S03-W02。
 *
 * Runtime 表示一种逻辑运行入口（hosted 或 external）；RuntimeRevision 固定主机/Adapter 制品、
 * 协议、网络区、身份模式、配置 hash 和真实 capabilities。
 *
 * 关键约束：
 * - UNIQUE(tenantId, runtimeKey)：租户内稳定 key 唯一。
 * - UNIQUE(runtimeId, revisionNo)：Runtime 内修订号单调递增。
 * - published Revision 业务内容不可修改；只能新建修订。
 * - withdrawn 只阻止新发布或路由，不删除历史引用。
 * - currentRevisionId 必须指向同一 Runtime 的 published Revision（逻辑外键，应用层校验）。
 * - capabilities 必须来自探测和一致性测试，管理员不能手工勾选未支持能力。
 * - endpoint_ref 只引用受管连接，不直接保存带 Secret 的 URL。
 *
 * Runtime lifecycle 与 Agent 一致（draft/enabled/disabled/retired，retired 为终态）。
 * RuntimeRevision state 与 AgentRevision 一致（draft/published/withdrawn）。
 * protocol_type/identity_mode/network_zone 使用 varchar 存储以便扩展（契约未固定枚举）。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/v11/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  boolean,
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

// ─── Runtime Lifecycle ─────────────────────────────────────

/**
 * Runtime 生命周期状态（与 Agent 一致）。
 * - draft：刚创建，未启用。
 * - enabled：已启用，可被路由。
 * - disabled：临时停用。
 * - retired：永久退役（终态，不可恢复）。
 */
export const RUNTIME_LIFECYCLE_STATES = ["draft", "enabled", "disabled", "retired"] as const;
export type RuntimeLifecycleState = (typeof RUNTIME_LIFECYCLE_STATES)[number];

// ─── Runtime Kind ──────────────────────────────────────────

/**
 * Runtime 种类。
 * - hosted：平台托管运行时。
 * - external：外部运行时（必须声明身份、事件、取消和能力协议）。
 */
export const RUNTIME_KINDS = ["hosted", "external"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

// ─── RuntimeRevision State ─────────────────────────────────

/**
 * RuntimeRevision 状态（与 AgentRevision 一致）。
 * - draft：草稿，可编辑业务内容。
 * - published：已发布，业务内容不可修改，可被路由引用。
 * - withdrawn：已撤回，只阻止新发布或路由，不删除历史引用。
 */
export const RUNTIME_REVISION_STATES = ["draft", "published", "withdrawn"] as const;
export type RuntimeRevisionState = (typeof RUNTIME_REVISION_STATES)[number];

// ─── Protocol Type / Identity Mode / Network Zone ──────────
// 契约未固定枚举值，使用 varchar 存储以便扩展；以下为已知常量。

/** 已知协议类型。 */
export const RUNTIME_PROTOCOL_TYPES = ["agent_runtime_protocol", "a2a"] as const;
export type RuntimeProtocolType = (typeof RUNTIME_PROTOCOL_TYPES)[number];

/** 已知身份模式。 */
export const RUNTIME_IDENTITY_MODES = ["workload_token", "api_key", "none"] as const;
export type RuntimeIdentityMode = (typeof RUNTIME_IDENTITY_MODES)[number];

/** 已知网络区域。 */
export const RUNTIME_NETWORK_ZONES = ["internal", "external", "dmz"] as const;
export type RuntimeNetworkZone = (typeof RUNTIME_NETWORK_ZONES)[number];

// ─── Runtime ───────────────────────────────────────────────

export const v11Runtime = mysqlTable(
  "V11Runtime",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 租户内稳定唯一 key（slug），例如 "doubao-hosted"。 */
    runtimeKey: varchar("runtimeKey", { length: 128 }).notNull(),
    displayName: varchar("displayName", { length: 256 }).notNull(),
    /** hosted 或 external。 */
    runtimeKind: mysqlEnum("runtimeKind", RUNTIME_KINDS).notNull(),
    /** 负责人 userIdentityId（逻辑外键 → UserIdentity.id）。 */
    ownerUserId: varchar("ownerUserId", { length: 36 }).notNull(),
    lifecycleState: mysqlEnum("lifecycleState", RUNTIME_LIFECYCLE_STATES)
      .notNull()
      .default("draft"),
    /** 当前发布修订 id（逻辑外键 → V11RuntimeRevision.id）；null 表示未发布。 */
    currentRevisionId: varchar("currentRevisionId", { length: 36 }),
    /** 乐观并发版本号。 */
    versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    deletedAt: datetime("deletedAt", { mode: "date" }),
  },
  (t) => ({
    tenantKeyUq: uniqueIndex("V11Runtime_tenant_runtimeKey_uq").on(t.tenantId, t.runtimeKey),
    tenantLifecycleUpdatedIdx: index("V11Runtime_tenant_lifecycle_updated_idx").on(
      t.tenantId,
      t.lifecycleState,
      t.updatedAt,
    ),
  }),
);

export type V11Runtime = InferSelectModel<typeof v11Runtime>;
export type NewV11Runtime = InferInsertModel<typeof v11Runtime>;

// ─── RuntimeRevision ───────────────────────────────────────

export const v11RuntimeRevision = mysqlTable(
  "V11RuntimeRevision",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    runtimeId: varchar("runtimeId", { length: 36 })
      .notNull()
      .references(() => v11Runtime.id),
    /** Runtime 内单调递增修订号。 */
    revisionNo: bigint("revisionNo", { mode: "number" }).notNull(),
    /** 协议类型（agent_runtime_protocol/a2a/...）；varchar 以便扩展。 */
    protocolType: varchar("protocolType", { length: 32 }).notNull(),
    /** Conformance 与发布共同冻结的协议契约版本。 */
    protocolContractRevision: varchar("protocolContractRevision", { length: 128 })
      .notNull()
      .default("agent-runtime-protocol@1"),
    /** 受管连接引用，不保存带 Secret 的 URL。 */
    endpointRef: varchar("endpointRef", { length: 512 }).notNull(),
    /** Runtime 主机/Adapter 制品引用。 */
    runtimeArtifactRef: varchar("runtimeArtifactRef", { length: 512 }).notNull(),
    /** 权威控制面 Artifact；兼容期允许旧 Revision 为空。 */
    artifactId: varchar("artifactId", { length: 36 }),
    /** 与 artifactId 同时冻结的内容摘要。 */
    artifactDigest: varchar("artifactDigest", { length: 71 }),
    /** 实际能力（来自探测和一致性测试，非手工勾选）。 */
    runtimeCapabilitiesJson: json("runtimeCapabilitiesJson").notNull(),
    /** 身份模式（workload_token/api_key/none/...）；varchar 以便扩展。 */
    identityMode: varchar("identityMode", { length: 32 }).notNull(),
    /** 网络区域（internal/external/dmz/...）；varchar 以便扩展。 */
    networkZone: varchar("networkZone", { length: 32 }).notNull(),
    /** 配置 hash（带算法前缀，如 sha256:...）。 */
    configHash: varchar("configHash", { length: 128 }).notNull(),
    revisionState: mysqlEnum("revisionState", RUNTIME_REVISION_STATES).notNull().default("draft"),
    /** 创建者 userIdentityId 或 serviceId。 */
    createdBy: varchar("createdBy", { length: 128 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    publishedAt: datetime("publishedAt", { mode: "date", fsp: 3 }),
  },
  (t) => ({
    runtimeRevisionNoUq: uniqueIndex("V11RuntimeRevision_runtime_revisionNo_uq").on(
      t.runtimeId,
      t.revisionNo,
    ),
    runtimeStateIdx: index("V11RuntimeRevision_runtime_state_idx").on(t.runtimeId, t.revisionState),
    artifactIdx: index("V11RuntimeRevision_artifact_idx").on(t.artifactId),
  }),
);

export type V11RuntimeRevision = InferSelectModel<typeof v11RuntimeRevision>;
export type NewV11RuntimeRevision = InferInsertModel<typeof v11RuntimeRevision>;

// ─── Invocation Kind ───────────────────────────────────────

/**
 * Invocation 类型（§6.2）。
 * - initial：Turn 或 Job 的首次执行。
 * - regenerate：Regenerate 创建的新 Invocation，替代原 Invocation。
 * - job：后台 Job 触发的执行。
 */
export const INVOCATION_KINDS = ["initial", "regenerate", "job"] as const;
export type InvocationKind = (typeof INVOCATION_KINDS)[number];

// ─── Invocation Execution State ────────────────────────────

/**
 * Invocation 执行状态（§6.2）。
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
 * V11Invocation 表：一次 AgentRevision + RuntimeRevision 的执行（§6.2 L366-387）。
 *
 * 关键约束：
 * - turnId/jobId 恰有一个非空（应用层校验，DB 不加 CHECK）。
 * - invocationSequence 在 Turn 或 Job 内单调递增（UNIQUE(threadId, invocationSequence) / UNIQUE(jobId, invocationSequence)）。
 * - Regenerate 创建新 Invocation（replacesInvocationId 指向原 Invocation），仍属于原 Turn。
 * - 一个 Invocation 必须且只能属于一个 Turn 或一个 Job。
 * - executionState 状态机：queued → running → waiting_user → running → completed/failed/cancelled/lost。
 */
export const v11Invocation = mysqlTable(
  "V11Invocation",
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
    /** 外键 runtime_session_binding（本阶段不实现，先 NULL）。 */
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
    threadSequenceUq: uniqueIndex("V11Invocation_thread_sequence_uq").on(
      t.threadId,
      t.invocationSequence,
    ),
    jobSequenceUq: uniqueIndex("V11Invocation_job_sequence_uq").on(t.jobId, t.invocationSequence),
    tenantStateIdx: index("V11Invocation_tenant_state_idx").on(t.tenantId, t.executionState),
    turnIdx: index("V11Invocation_turn_idx").on(t.turnId),
  }),
);

export type V11Invocation = InferSelectModel<typeof v11Invocation>;
export type NewV11Invocation = InferInsertModel<typeof v11Invocation>;

// ─── ExecutionBinding ──────────────────────────────────────

/**
 * V11ExecutionBinding 表：一条 Invocation 恰有一条不可变绑定（§6.3 L405-423）。
 *
 * 关键约束：
 * - 一条 Invocation 恰有一条不可变绑定（invocationId 为主键，1:1）。
 * - 启动后不可变：只有 create，没有 update。
 * - Route 更新不修改进行中的 ExecutionBinding。
 * - configHash 由 computeBindingConfigHash 规范化字段后 SHA-256 计算。
 */
export const v11ExecutionBinding = mysqlTable(
  "V11ExecutionBinding",
  {
    /** 主键 = invocationId（1:1）。 */
    invocationId: varchar("invocationId", { length: 36 })
      .primaryKey()
      .notNull()
      .references(() => v11Invocation.id),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    agentRevisionId: varchar("agentRevisionId", { length: 36 }).notNull(),
    runtimeRevisionId: varchar("runtimeRevisionId", { length: 36 }).notNull(),
    deploymentRouteId: varchar("deploymentRouteId", { length: 36 }).notNull(),
    modelProvider: varchar("modelProvider", { length: 128 }).notNull(),
    modelId: varchar("modelId", { length: 256 }).notNull(),
    modelRevisionRef: varchar("modelRevisionRef", { length: 256 }),
    /** 本阶段不实现 EnvironmentLease，先 NULL。 */
    initialEnvironmentLeaseId: varchar("initialEnvironmentLeaseId", { length: 36 }),
    workspaceBindingId: varchar("workspaceBindingId", { length: 36 }),
    policyRevisionId: varchar("policyRevisionId", { length: 36 }),
    contextCheckpointId: varchar("contextCheckpointId", { length: 36 }),
    configHash: varchar("configHash", { length: 128 }).notNull(),
    boundAt: datetime("boundAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantIdx: index("V11ExecutionBinding_tenant_idx").on(t.tenantId),
    agentRevisionIdx: index("V11ExecutionBinding_agentRevision_idx").on(t.agentRevisionId),
    runtimeRevisionIdx: index("V11ExecutionBinding_runtimeRevision_idx").on(t.runtimeRevisionId),
  }),
);

export type V11ExecutionBinding = InferSelectModel<typeof v11ExecutionBinding>;
export type NewV11ExecutionBinding = InferInsertModel<typeof v11ExecutionBinding>;

// ─── InvocationAttempt State ───────────────────────────────

/**
 * InvocationAttempt 状态（§6.4）。
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
 * V11InvocationAttempt 表：整个 Invocation 的基础设施重调度（§6.4 L389-403）。
 *
 * 关键约束：
 * - attemptNo 从 1 开始递增（1 表示第一次基础设施重试）。
 * - Attempt 只表示整个 Invocation 基础设施重调度，不表示模型 Span、ToolCall。
 * - UNIQUE(invocationId, attemptNo) 保证 Attempt 编号唯一。
 * - 一次 Invocation 可以有多个 Attempt（基础设施重试）。
 */
export const v11InvocationAttempt = mysqlTable(
  "V11InvocationAttempt",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    invocationId: varchar("invocationId", { length: 36 })
      .notNull()
      .references(() => v11Invocation.id),
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
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    invocationAttemptUq: uniqueIndex("V11InvocationAttempt_invocation_attempt_uq").on(
      t.invocationId,
      t.attemptNo,
    ),
    invocationStateIdx: index("V11InvocationAttempt_invocation_state_idx").on(
      t.invocationId,
      t.attemptState,
    ),
  }),
);

export type V11InvocationAttempt = InferSelectModel<typeof v11InvocationAttempt>;
export type NewV11InvocationAttempt = InferInsertModel<typeof v11InvocationAttempt>;

// ─── ExecutionOwnership State ──────────────────────────────

/**
 * ExecutionOwnership 状态（§6.13）。
 * - active：当前持有执行权。
 * - released：主动释放。
 * - lost：心跳超时，被标记为丢失。
 */
export const EXECUTION_OWNERSHIP_STATES = ["active", "released", "lost"] as const;
export type ExecutionOwnershipState = (typeof EXECUTION_OWNERSHIP_STATES)[number];

// ─── ExecutionOwnership ────────────────────────────────────

/**
 * V11ExecutionOwnership 表：Invocation 执行权管理（§6.13 L516-523）。
 *
 * 关键约束：
 * - leaseEpoch 单调递增，每次新获取执行权时 +1。
 * - UNIQUE(invocationId, leaseEpoch) 保证 lease epoch 唯一。
 * - 同一时刻只有一个 active ownership。
 */
export const v11ExecutionOwnership = mysqlTable(
  "V11ExecutionOwnership",
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
    invocationEpochUq: uniqueIndex("V11ExecutionOwnership_invocation_epoch_uq").on(
      t.invocationId,
      t.leaseEpoch,
    ),
    invocationStateIdx: index("V11ExecutionOwnership_invocation_state_idx").on(
      t.invocationId,
      t.ownershipState,
    ),
  }),
);

export type V11ExecutionOwnership = InferSelectModel<typeof v11ExecutionOwnership>;
export type NewV11ExecutionOwnership = InferInsertModel<typeof v11ExecutionOwnership>;

// ─── RuntimeSessionBinding State ──────────────────────────

/**
 * RuntimeSessionBinding 状态（§6.11）。
 * - active：Runtime 会话活跃。
 * - closed：主动关闭（Turn 终态后由平台请求关闭）。
 * - lost：Runtime 心跳超时或自报丢失。
 */
export const RUNTIME_SESSION_BINDING_STATES = ["active", "closed", "lost"] as const;
export type RuntimeSessionBindingState = (typeof RUNTIME_SESSION_BINDING_STATES)[number];

// ─── RuntimeSessionBinding ────────────────────────────────

/**
 * V11RuntimeSessionBinding 表：Runtime 维护的会话引用（§6.11 L506-508）。
 *
 * 关键约束：
 * - threadId/jobId 恰有一个非空（应用层校验，DB 不加 CHECK）。
 * - externalSessionRef 由 Runtime 颁发，平台仅持久化引用，不解析其内容。
 * - UNIQUE(runtimeRevisionId, externalSessionRef)：同一 RuntimeRevision 下外部会话引用唯一。
 * - 外部 Session 不取代 Thread，仅作为 Runtime 侧执行上下文锚点。
 * - bindingState=active 表示 Runtime 会话活跃；Turn 终态后由平台请求 Runtime 关闭。
 */
export const v11RuntimeSessionBinding = mysqlTable(
  "V11RuntimeSessionBinding",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    runtimeRevisionId: varchar("runtimeRevisionId", { length: 36 }).notNull(),
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
    runtimeExternalRefUq: uniqueIndex("V11RuntimeSessionBinding_runtime_external_ref_uq").on(
      t.runtimeRevisionId,
      t.externalSessionRef,
    ),
    threadIdx: index("V11RuntimeSessionBinding_thread_idx").on(t.threadId),
    jobIdx: index("V11RuntimeSessionBinding_job_idx").on(t.jobId),
  }),
);

export type V11RuntimeSessionBinding = InferSelectModel<typeof v11RuntimeSessionBinding>;
export type NewV11RuntimeSessionBinding = InferInsertModel<typeof v11RuntimeSessionBinding>;

// ─── RuntimeEventIngress State ─────────────────────────────

/**
 * RuntimeEventIngress 状态（§6.9 L486-500）。
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
 * V11RuntimeEventIngress 表：Runtime 回传候选事件的持久批次账本（§6.9 L486-500）。
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
export const v11RuntimeEventIngress = mysqlTable(
  "V11RuntimeEventIngress",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    invocationId: varchar("invocationId", { length: 36 })
      .notNull()
      .references(() => v11Invocation.id),
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
    /** 映射到 JobEvent（本阶段不用）。 */
    mappedJobEventId: varchar("mappedJobEventId", { length: 36 }),
    receivedAt: datetime("receivedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    mappedAt: datetime("mappedAt", { mode: "date", fsp: 3 }),
    rejectedReason: varchar("rejectedReason", { length: 256 }),
  },
  (t) => ({
    invocationProducerEventUq: uniqueIndex(
      "V11RuntimeEventIngress_invocation_producer_event_uq",
    ).on(t.invocationId, t.producerEventId),
    invocationProducerSeqUq: uniqueIndex("V11RuntimeEventIngress_invocation_producer_seq_uq").on(
      t.invocationId,
      t.producerSequence,
    ),
    invocationStateIdx: index("V11RuntimeEventIngress_invocation_state_idx").on(
      t.invocationId,
      t.ingressState,
    ),
  }),
);

export type V11RuntimeEventIngress = InferSelectModel<typeof v11RuntimeEventIngress>;
export type NewV11RuntimeEventIngress = InferInsertModel<typeof v11RuntimeEventIngress>;

// ─── RuntimeConformanceResult ────────────────────────────

/**
 * V11RuntimeConformanceResult 表：RuntimeRevision 一致性测试结果（§6.x + 15-machine-contracts §5 L94-110）。
 *
 * 关键约束：
 * - UNIQUE(runtimeRevisionId, caseId)：每个 Revision 每个 case 只有一条结果（UPSERT 语义）。
 * - conformance case id 必须唯一（与 ALL_CONFORMANCE_CASES 对应）。
 * - mandatory case 失败 → Revision 不可路由（由 publishRuntimeRevision 校验）。
 * - 失败 case 对应 capability 必须设为 false（应用层联动，本表不强制）。
 * - 可选能力缺失只禁用对应功能，不阻断发布。
 * - capabilities 必须来自探测和一致性测试，管理员不能手工勾选未支持能力。
 */
export const v11RuntimeConformanceResult = mysqlTable(
  "V11RuntimeConformanceResult",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    runtimeRevisionId: varchar("runtimeRevisionId", { length: 36 })
      .notNull()
      .references(() => v11RuntimeRevision.id),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** conformance case id（来自 ALL_CONFORMANCE_CASES，如 "dispatch-binds-immutable-config"）。 */
    caseId: varchar("caseId", { length: 64 }).notNull(),
    passed: boolean("passed").notNull(),
    /** 失败原因或成功说明；passed=false 时必填。 */
    reason: text("reason"),
    /** Adapter 制品 digest（用于关联制品证明）。 */
    adapterDigest: varchar("adapterDigest", { length: 128 }),
    /** 测试环境标识，如 "testcontainers-mysql-8"。 */
    testEnvironment: varchar("testEnvironment", { length: 128 }),
    /** 证据引用，如日志/trace 链接。 */
    evidenceRef: varchar("evidenceRef", { length: 512 }),
    testedAt: datetime("testedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    revisionCaseUq: uniqueIndex("V11RuntimeConformanceResult_revision_case_uq").on(
      t.runtimeRevisionId,
      t.caseId,
    ),
    revisionIdx: index("V11RuntimeConformanceResult_revision_idx").on(t.runtimeRevisionId),
    casePassedIdx: index("V11RuntimeConformanceResult_case_passed_idx").on(t.caseId, t.passed),
  }),
);

export type V11RuntimeConformanceResult = InferSelectModel<typeof v11RuntimeConformanceResult>;
export type NewV11RuntimeConformanceResult = InferInsertModel<typeof v11RuntimeConformanceResult>;
