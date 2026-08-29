/**
 * AgentCall Schema — AgentCall 子执行域（专题01 冻结架构 02 §五/§六）。
 *
 * AgentCall 是 Parent Harness Invocation 内部的 Agent 能力调用子执行域，绝非第二个
 * 顶层 Invocation。本文件定义以下表的单一物理 Schema 权威：
 * - AgentCall：子执行状态（独立状态机，不复用 Invocation 状态 Authority）。
 * - AgentCallBinding：不可变证据冻结（exact AgentRevision/Contract/Publication/Route/
 *   endpoint/credential/resolution digest/policy）。
 * - AgentCallAttempt：尝试执行记录（幂等 + 唯一 outbound）。
 * - AgentSessionBinding：A2A contextId 归属（会话容器）。
 * - AgentCallEventIngress：Agent 事件幂等账本。
 *
 * 冻结映射：
 * - A2A contextId → AgentSessionBinding.externalContextRef
 * - A2A taskId     → AgentCall.externalTaskRef
 *
 * 关键约束：
 * - AgentCall.parentInvocationId 必须属于同 tenant（Store 校验，DB 加 FK 到 Invocation）。
 * - AgentCallBinding 只有 create，没有 update（证据不可变）。
 * - AgentCallAttempt UNIQUE(callId, attemptNo)。
 * - AgentSessionBinding UNIQUE(agentRevisionId, routeRevisionId, externalContextRef)。
 * - AgentCallEventIngress UNIQUE(callId, producerEventId) / UNIQUE(callId, producerSequence)。
 */
import { randomUUID } from "node:crypto";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
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

// ─── AgentCall State ───────────────────────────────────────

/**
 * AgentCall 状态机 — 独立于 Invocation 状态 Authority。
 * - queued / running / waiting_user：非终态。
 * - completed / failed / cancelled / lost：终态。
 */
export const AGENT_CALL_STATES = [
  "queued",
  "running",
  "waiting_user",
  "completed",
  "failed",
  "cancelled",
  "lost",
] as const;
export type AgentCallState = (typeof AGENT_CALL_STATES)[number];

/** AgentCall 来源类型（专题01 第一阶段只会出现 user_selected）。 */
export const AGENT_CALL_SOURCE_TYPES = ["user_selected", "dynamic_discovery", "policy"] as const;
export type AgentCallSourceType = (typeof AGENT_CALL_SOURCE_TYPES)[number];

// ─── AgentCall ─────────────────────────────────────────────

/**
 * AgentCall 表：一次 Parent Harness Invocation 对某 Agent 能力的调用。
 *
 * 关键约束：
 * - parentInvocationId 恒必填且属于同 tenant（AgentCall 永远是子执行域）。
 * - agentId 为 stable Agent.id；agentRevisionId 为 exact AgentRevision.id。
 * - state 独立状态机，不复用 Invocation 状态。
 * - 业务幂等：parentInvocationId + logicalCallKey（应用层/UNIQUE 兜底）。
 */
export const agentCallTable = mysqlTable(
  "AgentCall",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** Parent Harness Invocation id — AgentCall 永远是子执行域，绝不成为顶层 Invocation。 */
    parentInvocationId: varchar("parentInvocationId", { length: 36 })
      .notNull()
      .references(() => invocationTable.id),
    /** stable Agent.id（能力资产）。 */
    agentId: varchar("agentId", { length: 36 }).notNull(),
    /** exact AgentRevision.id（冻结，见 AgentCallBinding）。 */
    agentRevisionId: varchar("agentRevisionId", { length: 36 }).notNull(),
    /** 调用来源类型。 */
    sourceType: varchar("sourceType", { length: 32 }).notNull(),
    /** 来源引用（user_selected → Turn.id）。 */
    sourceRef: varchar("sourceRef", { length: 256 }),
    /** 独立状态机。 */
    state: mysqlEnum("state", AGENT_CALL_STATES).notNull().default("queued"),
    /** A2A contextId 快照（权威在 AgentSessionBinding.externalContextRef）。 */
    externalContextRef: varchar("externalContextRef", { length: 256 }),
    /** A2A taskId。 */
    externalTaskRef: varchar("externalTaskRef", { length: 256 }),
    /** 归一化结果文本。 */
    resultText: text("resultText"),
    /** 归一化结果 JSON。 */
    resultJson: json("resultJson"),
    /** 归一化结果 digest（sha256: 前缀）。 */
    resultDigest: varchar("resultDigest", { length: 71 }),
    errorCode: varchar("errorCode", { length: 128 }),
    errorSummary: text("errorSummary"),
    /** 业务幂等键（parentInvocationId + logicalCallKey 幂等）。 */
    logicalCallKey: varchar("logicalCallKey", { length: 256 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    startedAt: datetime("startedAt", { mode: "date", fsp: 3 }),
    waitingAt: datetime("waitingAt", { mode: "date", fsp: 3 }),
    finishedAt: datetime("finishedAt", { mode: "date", fsp: 3 }),
    versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
  },
  (t) => ({
    tenantStateIdx: index("AgentCall_tenant_state_idx").on(t.tenantId, t.state),
    parentIdx: index("AgentCall_parent_idx").on(t.parentInvocationId),
    agentIdx: index("AgentCall_agent_idx").on(t.agentId),
    parentLogicalKeyUq: uniqueIndex("AgentCall_parent_logical_key_uq").on(
      t.parentInvocationId,
      t.logicalCallKey,
    ),
  }),
);
export type AgentCall = InferSelectModel<typeof agentCallTable>;
export type NewAgentCall = InferInsertModel<typeof agentCallTable>;

// ─── AgentCallBinding ──────────────────────────────────────

/**
 * AgentCallBinding 表：一次 AgentCall 恰有一条不可变绑定（1:1）。
 *
 * 关键约束：
 * - callId 为主键（1:1）。
 * - 创建后不可变：只有 create，没有 update。
 * - 冻结 exact AgentRevision / Contract / Publication / Route / endpoint /
 *   credential / resolution digest / policy / governance。
 * - bindingHash 由 computeAgentCallBindingHash 规范化字段后 SHA-256 计算。
 */
export const agentCallBindingTable = mysqlTable(
  "AgentCallBinding",
  {
    /** 主键 = callId（1:1）。 */
    callId: varchar("callId", { length: 36 })
      .primaryKey()
      .notNull()
      .references(() => agentCallTable.id),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    agentId: varchar("agentId", { length: 36 }).notNull(),
    agentRevisionId: varchar("agentRevisionId", { length: 36 }).notNull(),
    agentContractSnapshotId: varchar("agentContractSnapshotId", { length: 36 }).notNull(),
    agentContractDigest: varchar("agentContractDigest", { length: 71 }).notNull(),
    agentCapabilityDigest: varchar("agentCapabilityDigest", { length: 71 }).notNull(),
    agentContextDigest: varchar("agentContextDigest", { length: 71 }).notNull(),
    agentPublicationRecordId: varchar("agentPublicationRecordId", { length: 36 }).notNull(),
    deploymentRouteId: varchar("deploymentRouteId", { length: 36 }).notNull(),
    routeRevisionId: varchar("routeRevisionId", { length: 36 }).notNull(),
    routeActivationId: varchar("routeActivationId", { length: 36 }).notNull(),
    routeContentDigest: varchar("routeContentDigest", { length: 71 }).notNull(),
    resolutionInputDigest: varchar("resolutionInputDigest", { length: 71 }).notNull(),
    projectionVersionNo: int("projectionVersionNo").notNull(),
    endpointRef: varchar("endpointRef", { length: 512 }).notNull(),
    identityMode: mysqlEnum("identityMode", ["none", "bearer"]).notNull(),
    credentialRefId: varchar("credentialRefId", { length: 36 }),
    networkZone: varchar("networkZone", { length: 32 }).notNull(),
    protocolType: varchar("protocolType", { length: 32 }).notNull(),
    protocolContractRevision: varchar("protocolContractRevision", { length: 128 }).notNull(),
    policyRevisionId: varchar("policyRevisionId", { length: 36 }).notNull(),
    policyRulesDigest: varchar("policyRulesDigest", { length: 71 }).notNull(),
    governanceConfigRevisionId: varchar("governanceConfigRevisionId", { length: 36 }).notNull(),
    governanceConfigDigest: varchar("governanceConfigDigest", { length: 71 }).notNull(),
    bindingHash: varchar("bindingHash", { length: 128 }).notNull(),
    boundAt: datetime("boundAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantIdx: index("AgentCallBinding_tenant_idx").on(t.tenantId),
    agentRevisionIdx: index("AgentCallBinding_agentRevision_idx").on(t.agentRevisionId),
    routeRevisionIdx: index("AgentCallBinding_routeRevision_idx").on(t.routeRevisionId),
  }),
);
export type AgentCallBinding = InferSelectModel<typeof agentCallBindingTable>;
export type NewAgentCallBinding = InferInsertModel<typeof agentCallBindingTable>;

// ─── AgentCallAttempt State ───────────────────────────────

/**
 * AgentCallAttempt 状态。
 * - queued / running：非终态。
 * - completed / failed / cancelled / lost：终态。
 */
export const AGENT_CALL_ATTEMPT_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "lost",
] as const;
export type AgentCallAttemptState = (typeof AGENT_CALL_ATTEMPT_STATES)[number];

// ─── AgentCallAttempt ─────────────────────────────────────

/**
 * AgentCallAttempt 表：一次 AgentCall 的尝试执行记录。
 *
 * 关键约束：
 * - UNIQUE(callId, attemptNo) 保证 Attempt 编号唯一。
 * - dispatchAttemptCount 记录该 Attempt 对远端累计 outbound 次数（防重复 outbound）。
 * - externalTaskRef 为 A2A taskId。
 */
export const agentCallAttemptTable = mysqlTable(
  "AgentCallAttempt",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    callId: varchar("callId", { length: 36 })
      .notNull()
      .references(() => agentCallTable.id),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    /** 1 表示第一次尝试。 */
    attemptNo: int("attemptNo").notNull(),
    attemptState: mysqlEnum("attemptState", AGENT_CALL_ATTEMPT_STATES).notNull().default("queued"),
    externalTaskRef: varchar("externalTaskRef", { length: 256 }),
    /** 该 Attempt 累计 outbound 次数。 */
    dispatchAttemptCount: int("dispatchAttemptCount").notNull().default(0),
    retryReasonCode: varchar("retryReasonCode", { length: 64 }),
    /**
     * 初始 claim 的 durable 请求摘要（sha256: 前缀）。
     * 原子 claim 语义：requestDigest IS NULL 表示未被认领；非空即已被某次 start 认领。
     * 同 call 同 input 并发 start → 共享同一 digest → 幂等；不同 input → digest 不同 → 冲突。
     * 不得滥用 retryReasonCode 承载该语义。
     */
    requestDigest: varchar("requestDigest", { length: 71 }),
    startedAt: datetime("startedAt", { mode: "date", fsp: 3 }),
    finishedAt: datetime("finishedAt", { mode: "date", fsp: 3 }),
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
    callAttemptUq: uniqueIndex("AgentCallAttempt_call_attempt_uq").on(t.callId, t.attemptNo),
    callStateIdx: index("AgentCallAttempt_call_state_idx").on(t.callId, t.attemptState),
  }),
);
export type AgentCallAttempt = InferSelectModel<typeof agentCallAttemptTable>;
export type NewAgentCallAttempt = InferInsertModel<typeof agentCallAttemptTable>;

// ─── AgentSessionBinding State ────────────────────────────

/**
 * AgentSessionBinding 状态。
 * - active：Agent 会话活跃。
 * - closed：显式关闭。
 * - lost：心跳超时或自报丢失。
 */
export const AGENT_SESSION_BINDING_STATES = ["active", "closed", "lost"] as const;
export type AgentSessionBindingState = (typeof AGENT_SESSION_BINDING_STATES)[number];

// ─── AgentSessionBinding ──────────────────────────────────

/**
 * AgentSessionBinding 表：Agent 会话的连续容器（A2A contextId 归属）。
 *
 * 关键约束：
 * - externalContextRef 为 A2A contextId；平台仅持久化，不解析其内容。
 * - UNIQUE(agentRevisionId, routeRevisionId, externalContextRef)：同 AgentRevision +
 *   同 RouteRevision + 同外部上下文唯一。
 * - 会话生命周期跨 Turn；关闭条件只有显式关闭 / lost / 管理操作。
 */
export const agentSessionBindingTable = mysqlTable(
  "AgentSessionBinding",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    threadId: varchar("threadId", { length: 36 }).notNull(),
    agentId: varchar("agentId", { length: 36 }).notNull(),
    agentRevisionId: varchar("agentRevisionId", { length: 36 }).notNull(),
    deploymentRouteId: varchar("deploymentRouteId", { length: 36 }).notNull(),
    routeRevisionId: varchar("routeRevisionId", { length: 36 }).notNull(),
    /** A2A contextId — 平台仅持久化，不解析其内容。 */
    externalContextRef: varchar("externalContextRef", { length: 256 }).notNull(),
    bindingState: mysqlEnum("bindingState", AGENT_SESSION_BINDING_STATES)
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
    revisionRouteContextUq: uniqueIndex("AgentSessionBinding_revision_route_context_uq").on(
      t.agentRevisionId,
      t.routeRevisionId,
      t.externalContextRef,
    ),
    threadIdx: index("AgentSessionBinding_thread_idx").on(t.threadId),
    agentIdx: index("AgentSessionBinding_agent_idx").on(t.agentId),
  }),
);
export type AgentSessionBinding = InferSelectModel<typeof agentSessionBindingTable>;
export type NewAgentSessionBinding = InferInsertModel<typeof agentSessionBindingTable>;

// ─── AgentCallEventIngress State ──────────────────────────

/**
 * AgentCallEventIngress 状态。
 * - accepted：候选事件已接收，尚未归一化到 AgentCall state。
 * - mapped：已归一化到 AgentCall state。
 * - rejected：因 hash 冲突等不可修复原因被拒绝。
 */
export const AGENT_CALL_EVENT_INGRESS_STATES = ["accepted", "mapped", "rejected"] as const;
export type AgentCallEventIngressState = (typeof AGENT_CALL_EVENT_INGRESS_STATES)[number];

// ─── AgentCall Candidate Event Type ───────────────────────

/**
 * AgentCall 候选事件类型（归一化到 AgentCall 域，不直接映射 Invocation 终态）。
 * - call.started：远端 Task 已启动。
 * - call.completed：调用完成。
 * - call.input_required：远端请求用户补充信息。
 * - call.failed：调用失败。
 * - call.cancelled：调用被取消。
 * - call.lost：调用丢失。
 */
export const AGENT_CALL_CANDIDATE_EVENT_TYPES = [
  "call.started",
  "call.completed",
  "call.input_required",
  "call.failed",
  "call.cancelled",
  "call.lost",
] as const;
export type AgentCallCandidateEventType = (typeof AGENT_CALL_CANDIDATE_EVENT_TYPES)[number];

// ─── AgentCallEventIngress ────────────────────────────────

/**
 * AgentCallEventIngress 表：AgentCall 回传候选事件的持久批次账本。
 *
 * 关键约束：
 * - UNIQUE(callId, producerEventId)：Agent 稳定事件 id 唯一（幂等键 1）。
 * - UNIQUE(callId, producerSequence)：Agent 连续序号唯一（幂等键 2）。
 * - 相同 producerEventId/producerSequence 但 payloadHash 不同 → 直接拒绝（hash 冲突）。
 * - AgentCall 事件归一化到 AgentCall state，由 Harness Loop 决定顶层 Invocation 走向。
 */
export const agentCallEventIngressTable = mysqlTable(
  "AgentCallEventIngress",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    callId: varchar("callId", { length: 36 })
      .notNull()
      .references(() => agentCallTable.id),
    tenantId: varchar("tenantId", { length: 36 }).notNull(),
    /** Agent 稳定事件 id（幂等键 1）。 */
    producerEventId: varchar("producerEventId", { length: 128 }).notNull(),
    /** Agent 连续序号（幂等键 2，整个 AgentCall 内连续）。 */
    producerSequence: bigint("producerSequence", { mode: "number" }).notNull(),
    /** AgentCall 候选事件类型。 */
    candidateType: varchar("candidateType", { length: 64 }).notNull(),
    /** 候选负载 SHA-256 hash（递归排序 key 后 sha256）。 */
    payloadHash: varchar("payloadHash", { length: 128 }).notNull(),
    /** 短期保存原候选负载，或对象引用；可为 null 用于诊断采样。 */
    payloadJson: json("payloadJson"),
    ingressState: mysqlEnum("ingressState", AGENT_CALL_EVENT_INGRESS_STATES)
      .notNull()
      .default("accepted"),
    receivedAt: datetime("receivedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    mappedAt: datetime("mappedAt", { mode: "date", fsp: 3 }),
    rejectedReason: varchar("rejectedReason", { length: 256 }),
  },
  (t) => ({
    callProducerEventUq: uniqueIndex("AgentCallEventIngress_call_producer_event_uq").on(
      t.callId,
      t.producerEventId,
    ),
    callProducerSeqUq: uniqueIndex("AgentCallEventIngress_call_producer_seq_uq").on(
      t.callId,
      t.producerSequence,
    ),
    callStateIdx: index("AgentCallEventIngress_call_state_idx").on(t.callId, t.ingressState),
  }),
);
export type AgentCallEventIngress = InferSelectModel<typeof agentCallEventIngressTable>;
export type NewAgentCallEventIngress = InferInsertModel<typeof agentCallEventIngressTable>;

// ─── Canonical Row 别名 ───────────────────────────────────
export type AgentCallRow = AgentCall;
export type NewAgentCallRow = NewAgentCall;
