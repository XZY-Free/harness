/**
 * schema：安全事件与隔离止损（S12-W09）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md §9
 * （安全事件可按 Agent、Revision、ToolProvider、Credential、Runtime 或 Environment 隔离和止损；
 * 撤销 Credential、禁用能力或隔离 Route 后，新操作立即拒绝；进行中副作用进入核对而非静默重试；
 * 事故时间线从 Audit/Event/Trace 汇总，诊断内容访问仍受时限、脱敏和审计约束）。
 *
 * 表语义：
 * - SecurityIncident：安全事件主体。记录严重程度/状态机/目标类型/检测来源/审计事件 id。
 * incidentState 推进：open → investigating → contained → resolved / escalated。
 * - IncidentContainment：每次事故下的隔离止损动作。按 (incidentId, actionType) 唯一。
 * actionState：pending → applied → reverted（resolved 时可回滚）。
 *
 * 不变量：
 * - 同一 (incidentId, actionType) 仅一条 containment（唯一索引保证）。
 * - incidentState=contained 要求所有 pending containment 为 applied/failed。
 * - incidentState=resolved 时可回滚 applied containment（reverted）。
 * - 不写 ThreadEvent，只写管理域 AuditEvent（security.incident）。
 * - 撤销立即生效：containment applied 后新操作立即拒绝；进行中副作用进入 Effect 核对账本。
 * - 不以日志文本冒充隔离成功：applied 要求 evidenceRef 指向实际撤销/禁用证据。
 * - 事故时间线从 Audit/Event/Trace 汇总，诊断内容访问受时限、脱敏和审计约束。
 *
 * 生命周期优先级：
 * - 安全事件记录作为事故处置证据，与 Retention Policy 独立（不因保留期到期删除）。
 * - escalated 事件需人工介入，不自动 resolve。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
 datetime,
 index,
 mysqlEnum,
 mysqlTable,
 text,
 uniqueIndex,
 varchar,
} from "drizzle-orm/mysql-core";

// ─── 隔离目标类型 ──────────────────────────────────────────

/**
 * 安全事件隔离目标类型（覆盖方案 §9 列出的全部隔离维度）。
 *
 * 对应方案 §9：
 * - agent：Agent 主体隔离（阻止新发布 + 隔离关联 Route）。
 * - agent_revision：AgentRevision 隔离（withdraw 阻止新路由引用）。
 * - tool_provider：ToolProvider 隔离（disable 阻止新 Tool 调用）。
 * - tool：Tool 隔离（disable 阻止新调用）。
 * - credential：Credential 隔离（revoke 立即停止注入）。
 * - runtime：Runtime 隔离（withdraw Revision + disable Route）。
 * - environment：Environment 隔离（阻止新 Invocation 调度）。
 * - workload_token：Workload Token 撤销（立即拒绝身份解析）。
 * - other：其他安全事件（如 SSRF、路径穿越等，不直接关联可撤销实体）。
 */
export const INCIDENT_TARGET_TYPES = [
 "agent",
 "agent_revision",
 "tool_provider",
 "tool",
 "credential",
 "runtime",
 "environment",
 "workload_token",
 "other",
] as const;
export type IncidentTargetType = (typeof INCIDENT_TARGET_TYPES)[number];

// ─── 事故状态机 ────────────────────────────────────────────

/**
 * 事故状态（state machine）。
 * - open：已识别，待调查（检测来源触发）。
 * - investigating：调查中（确认影响范围 + 规划隔离动作）。
 * - contained：已隔离止损（所有 containment 已 applied/failed）。
 * - resolved：已解决（恢复或确认无影响；可回滚 containment）。
 * - escalated：已升级（超出平台自动处置能力，需人工介入）。
 */
export const INCIDENT_STATES = [
 "open",
 "investigating",
 "contained",
 "resolved",
 "escalated",
] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

// ─── 严重程度 ──────────────────────────────────────────────

/**
 * 事故严重程度。
 * - low：低影响（如单次异常请求）。
 * - medium：中等影响（如单个 Credential 泄露）。
 * - high：高影响（如 Agent 被滥用）。
 * - critical：严重影响（如租户级数据泄露或 Runtime 被攻陷）。
 */
export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

// ─── 隔离动作类型 ──────────────────────────────────────────

/**
 * 隔离止损动作类型（覆盖方案 §9 列出的全部隔离手段）。
 *
 * - revoke_credential：撤销 Credential（lifecycleState → revoked，终态不可恢复）。
 * - disable_tool_provider：禁用 ToolProvider（lifecycleState → disabled）。
 * - disable_tool：禁用 Tool（lifecycleState → disabled）。
 * - disable_route：禁用 DeploymentRoute（routeState → disabled，阻止新 Invocation）。
 * - withdraw_agent_revision：撤回 AgentRevision（revisionState → withdrawn）。
 * - withdraw_runtime_revision：撤回 RuntimeRevision（revisionState → withdrawn）。
 * - revoke_workload_token：撤销 Workload Token（写入撤销表，立即拒绝身份解析）。
 * - isolate_environment：隔离 Environment（阻止新 Invocation 调度到该环境）。
 * - quarantine_event：隔离事件（event ingress quarantine，阻止消费）。
 */
export const CONTAINMENT_ACTION_TYPES = [
 "revoke_credential",
 "disable_tool_provider",
 "disable_tool",
 "disable_route",
 "withdraw_agent_revision",
 "withdraw_runtime_revision",
 "revoke_workload_token",
 "isolate_environment",
 "quarantine_event",
] as const;
export type ContainmentActionType = (typeof CONTAINMENT_ACTION_TYPES)[number];

// ─── 隔离动作状态 ──────────────────────────────────────────

/**
 * 隔离动作状态。
 * - pending：待执行（事故创建时按 targetType 预填）。
 * - applied：已应用隔离（新操作立即拒绝；含 evidenceRef 证据）。
 * - failed：应用失败（含 failureReason）。
 * - reverted：已回滚（incident resolved 时回滚可恢复的隔离）。
 */
export const CONTAINMENT_STATES = ["pending", "applied", "failed", "reverted"] as const;
export type ContainmentState = (typeof CONTAINMENT_STATES)[number];

// ─── TargetType × ActionType 适用矩阵 ─────────────────────

/**
 * 各 targetType 适用的 containmentActionType 集合（用于 incident 创建时预填 containment 项）。
 *
 * 设计依据方案 §9：
 * - agent：撤回 AgentRevision + 禁用关联 Route（阻止新 Invocation 调度到该 Agent）。
 * - agent_revision：撤回 AgentRevision（阻止新路由引用，已开始 Invocation 保留原绑定）。
 * - tool_provider：禁用 ToolProvider（阻止新 Tool 调用）。
 * - tool：禁用 Tool（阻止新调用）。
 * - credential：撤销 Credential（立即停止注入，Vault 按策略销毁）。
 * - runtime：撤回 RuntimeRevision + 禁用 Route（阻止新 Invocation 调度到该 Runtime）。
 * - environment：隔离 Environment（阻止新 Invocation 调度）。
 * - workload_token：撤销 Workload Token（立即拒绝身份解析）。
 * - other：无预填动作（人工评估后手动添加 containment）。
 */
export const CONTAINMENT_ACTION_MATRIX: Record<
 IncidentTargetType,
 readonly ContainmentActionType[]
> = {
 agent: ["withdraw_agent_revision", "disable_route"],
 agent_revision: ["withdraw_agent_revision"],
 tool_provider: ["disable_tool_provider"],
 tool: ["disable_tool"],
 credential: ["revoke_credential"],
 runtime: ["withdraw_runtime_revision", "disable_route"],
 environment: ["isolate_environment"],
 workload_token: ["revoke_workload_token"],
 other: [],
};

// ─── SecurityIncident 表 ───────────────────────────────

export const securityIncidentTable = mysqlTable(
 "SecurityIncident",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 业务唯一键（便于幂等去重与外部系统关联）。 */
 incidentKey: varchar("incidentKey", { length: 128 }).notNull(),
 /** 严重程度。 */
 severity: mysqlEnum("severity", INCIDENT_SEVERITIES).notNull(),
 /** 事故状态（状态机）。 */
 incidentState: mysqlEnum("incidentState", INCIDENT_STATES).notNull().default("open"),
 /** 隔离目标类型。 */
 targetType: mysqlEnum("targetType", INCIDENT_TARGET_TYPES).notNull(),
 /** 被隔离的目标 id（如 agentId / revisionId / credentialId / runtimeId / environmentId）。 */
 targetId: varchar("targetId", { length: 128 }).notNull(),
 /** 事故概要（人工填写或系统生成）。 */
 summary: text("summary"),
 /** 检测来源（audit/manual/alert/drill/system）。 */
 detectedBy: varchar("detectedBy", { length: 64 }).notNull(),
 /** 检测时间（事故首次识别时间）。 */
 detectedAt: datetime("detectedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 /** 调查开始时间。 */
 investigatingAt: datetime("investigatingAt", { mode: "date", fsp: 3 }),
 /** 隔离完成时间。 */
 containedAt: datetime("containedAt", { mode: "date", fsp: 3 }),
 /** 解决时间。 */
 resolvedAt: datetime("resolvedAt", { mode: "date", fsp: 3 }),
 /** 关闭人（userId / serviceId）。 */
 closedBy: varchar("closedBy", { length: 128 }),
 /** 关闭原因（resolved/escalated 时填写）。 */
 closureReason: text("closureReason"),
 /** 隔离动作汇总 JSON（containmentCount/appliedCount/failedCount/revertedCount）。 */
 containmentSummaryJson: text("containmentSummaryJson"),
 /** 审计事件 id（security.incident 审计）。 */
 auditEventId: varchar("auditEventId", { length: 36 }),
 /** 关联请求 id（X-Request-ID），保证可跟踪。 */
 requestId: varchar("requestId", { length: 64 }),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 tenantKeyUq: uniqueIndex("SecurityIncident_tenant_key_uq").on(t.tenantId, t.incidentKey),
 tenantStateIdx: index("SecurityIncident_tenant_state_idx").on(t.tenantId, t.incidentState),
 tenantTargetIdx: index("SecurityIncident_tenant_target_idx").on(
 t.tenantId,
 t.targetType,
 t.targetId,
 ),
 tenantSeverityIdx: index("SecurityIncident_tenant_severity_idx").on(t.tenantId, t.severity),
 tenantDetectedIdx: index("SecurityIncident_tenant_detected_idx").on(t.tenantId, t.detectedAt),
 }),
);

export type SecurityIncident = InferSelectModel<typeof securityIncidentTable>;
export type NewSecurityIncident = InferInsertModel<typeof securityIncidentTable>;

// ─── IncidentContainment 表 ────────────────────────────

export const incidentContainmentTable = mysqlTable(
 "IncidentContainment",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 所属事故 id。 */
 incidentId: varchar("incidentId", { length: 36 })
 .notNull()
 .references(() => securityIncidentTable.id),
 /** 隔离动作类型（9 类）。 */
 actionType: mysqlEnum("actionType", CONTAINMENT_ACTION_TYPES).notNull(),
 /** 隔离动作状态（状态机）。 */
 actionState: mysqlEnum("actionState", CONTAINMENT_STATES).notNull().default("pending"),
 /**
 * 存储端证据引用（applied 必填）。
 * 指向实际撤销/禁用证据（如 CredentialRevocation.id、RouteState 变更审计 id）。
 * 不能用日志文本冒充隔离成功。
 */
 evidenceRef: varchar("evidenceRef", { length: 256 }),
 /** 隔离目标引用（如 "credential:cred-001" / "route:route-001"）。 */
 targetRef: varchar("targetRef", { length: 256 }),
 /** 核对详情 JSON（actionType 特定的隔离结果，如 affectedInvocations / revokedAt）。 */
 detailsJson: text("detailsJson"),
 /** 失败原因（actionState=failed 时填写）。 */
 failureReason: text("failureReason"),
 /** 应用时间（applied 时回填）。 */
 appliedAt: datetime("appliedAt", { mode: "date", fsp: 3 }),
 /** 回滚时间（reverted 时回填）。 */
 revertedAt: datetime("revertedAt", { mode: "date", fsp: 3 }),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 incidentActionUq: uniqueIndex("IncidentContainment_incident_action_uq").on(
 t.incidentId,
 t.actionType,
 ),
 tenantIncidentIdx: index("IncidentContainment_tenant_incident_idx").on(
 t.tenantId,
 t.incidentId,
 ),
 incidentStateIdx: index("IncidentContainment_incident_state_idx").on(
 t.incidentId,
 t.actionState,
 ),
 }),
);

export type IncidentContainment = InferSelectModel<typeof incidentContainmentTable>;
export type NewIncidentContainment = InferInsertModel<typeof incidentContainmentTable>;
