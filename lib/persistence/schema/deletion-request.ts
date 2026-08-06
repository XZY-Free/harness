/**
 * schema：可验证删除请求与步骤（S12-W07）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-data-lifecycle.md §7
 * （删除请求生成独立生命周期，先解析对象关系与 Legal Hold，再进入各存储 Adapter；
 * 覆盖 MySQL、对象存储、向量/检索、Trace/Log 和缓存；
 * 部分失败保持 failed/partial 并可安全重试，不以"主表已删"宣称全部完成）。
 *
 * 表语义：
 * - DeletionRequest：删除请求主体。记录 subject/mode/reason/请求人/状态机/阻塞原因/审计事件 id。
 * requestState 推进：planning → blocked_by_hold（Legal Hold 阻止）/ deleting → completed/partial/failed。
 * - DeletionStep：每个存储 Adapter 的删除步骤。按 (requestId, storeType, subjectRef) 唯一。
 * stepState：pending → running → completed（含 evidenceRef）/ failed / blocked / retained（共享资源保留）/ skipped。
 * completed 要求存储端 evidenceRef；局部失败保持 failed/partial，幂等可重试。
 *
 * 不变量：
 * - 同一 (requestId, storeType, subjectRef) 仅一条 step（唯一索引保证）。
 * - Legal Hold 不扩大到无关对象：仅匹配的 target 被阻止删除。
 * - 共享 Knowledge、跨 Thread Memory、用户原始本地文件不因单个 Thread 删除而清除（stepState=retained）。
 * - 不写 ThreadEvent 冒充已删除，只写管理域 AuditEvent（deletion.request）。
 * - 生命周期优先级：active Legal Hold > 法规保留 > 已受理删除请求 > 默认清理。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
 datetime,
 index,
 int,
 mysqlEnum,
 mysqlTable,
 text,
 uniqueIndex,
 varchar,
} from "drizzle-orm/mysql-core";

// ─── 删除请求 subject 类型 ──────────────────────────────────

/**
 * 删除请求的目标类型（与 OpenAPI 契约对齐）。
 *
 * 员工端 subject：thread / memory_entry / artifact / user_data_export_scope。
 * 管理端 subject 额外含：user / retention_scope。
 */
export const DELETION_SUBJECT_TYPES = [
 "thread",
 "memory_entry",
 "artifact",
 "user",
 "retention_scope",
 "user_data_export_scope",
] as const;

export type DeletionSubjectType = (typeof DELETION_SUBJECT_TYPES)[number];

// ─── 删除模式 ──────────────────────────────────────────────

/**
 * 删除模式（不能绕过 Legal Hold）。
 * - standard：标准删除。
 * - privacy_request：隐私请求删除（需 PRIVACY_REQUEST_VERIFIED）。
 * - retention_expiry：保留期到期清理（管理端）。
 */
export const DELETION_DELETE_MODES = ["standard", "privacy_request", "retention_expiry"] as const;
export type DeletionDeleteMode = (typeof DELETION_DELETE_MODES)[number];

// ─── 删除原因码 ────────────────────────────────────────────

/**
 * 删除原因码（与 OpenAPI 契约对齐）。
 * - USER_REQUESTED：员工请求删除。
 * - RETENTION_EXPIRED：保留期到期。
 * - ADMIN_POLICY：管理员策略删除。
 * - PRIVACY_REQUEST_VERIFIED：已验证的隐私请求。
 */
export const DELETION_REASON_CODES = [
 "USER_REQUESTED",
 "RETENTION_EXPIRED",
 "ADMIN_POLICY",
 "PRIVACY_REQUEST_VERIFIED",
] as const;

export type DeletionReasonCode = (typeof DELETION_REASON_CODES)[number];

// ─── 存储类型（5 类 Adapter） ──────────────────────────────

/**
 * 跨存储 Adapter 类型（方案 §7）。
 * - mysql：主库行（Thread/Event/Job/Audit 行等）。
 * - object_storage：对象存储（Artifact 正文、制品 bundle 等）。
 * - vector_search：向量/检索索引（Memory/Knowledge embedding）。
 * - trace_log：Trace/Span/Observation 与日志。
 * - cache：缓存失效（不持久存储，仅失效证据）。
 */
export const DELETION_STORE_TYPES = [
 "mysql",
 "object_storage",
 "vector_search",
 "trace_log",
 "cache",
] as const;

export type DeletionStoreType = (typeof DELETION_STORE_TYPES)[number];

// ─── 请求状态机 ────────────────────────────────────────────

/**
 * 删除请求状态机。
 * - planning：已受理，规划器解析对象图与 Legal Hold。
 * - blocked_by_hold：Legal Hold 阻止删除（不进入 deleting）。
 * - deleting：执行器按计划执行各存储 step。
 * - completed：所有 in-scope step 完成且含 evidenceRef。
 * - partial：部分 step 完成，部分失败但可安全重试。
 * - failed：非可重试失败或关键 step 失败。
 * - cancelled：管理员取消。
 */
export const DELETION_REQUEST_STATES = [
 "planning",
 "blocked_by_hold",
 "deleting",
 "completed",
 "partial",
 "failed",
 "cancelled",
] as const;

export type DeletionRequestState = (typeof DELETION_REQUEST_STATES)[number];

/** 请求终态（不再推进）。 */
export const TERMINAL_REQUEST_STATES: ReadonlySet<DeletionRequestState> = new Set([
 "completed",
 "failed",
 "cancelled",
]);

// ─── 步骤状态 ──────────────────────────────────────────────

/**
 * 删除步骤状态。
 * - pending：已规划，待执行。
 * - running：执行器正在调用存储 Adapter。
 * - completed：存储端返回 evidenceRef，删除完成。
 * - failed：Adapter 抛错；可重试（attemptCount 未耗尽）。
 * - blocked：Legal Hold 或法规保留阻止删除该 step。
 * - retained：共享资源保留（不删除，记录原因）。
 * - skipped：规划阶段决定跳过（如该存储无相关数据）。
 */
export const DELETION_STEP_STATES = [
 "pending",
 "running",
 "completed",
 "failed",
 "blocked",
 "retained",
 "skipped",
] as const;

export type DeletionStepState = (typeof DELETION_STEP_STATES)[number];

// ─── 请求主体类型 ──────────────────────────────────────────

/** 请求发起者类型（与幂等 callerType 对齐语义）。 */
export const DELETION_REQUEST_PRINCIPAL_KINDS = ["user", "service"] as const;
export type DeletionRequestPrincipalKind = (typeof DELETION_REQUEST_PRINCIPAL_KINDS)[number];

// ─── DeletionRequest 表 ─────────────────────────────────

export const deletionRequestTable = mysqlTable(
 "DeletionRequest",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 删除目标类型。 */
 subjectType: mysqlEnum("subjectType", DELETION_SUBJECT_TYPES).notNull(),
 /** 删除目标 id（subjectType=retention_scope 时为范围标识，如 trace-before-2026-01-01）。 */
 subjectId: varchar("subjectId", { length: 128 }).notNull(),
 /** 删除模式。 */
 deleteMode: mysqlEnum("deleteMode", DELETION_DELETE_MODES).notNull(),
 /** 删除原因码（varchar 便于未来扩展，写入前校验在 DELETION_REASON_CODES 内）。 */
 reasonCode: varchar("reasonCode", { length: 64 }).notNull(),
 /** 本次请求依据的不可变 Policy revision（管理端必填，员工端可空）。 */
 policyRevisionId: varchar("policyRevisionId", { length: 64 }),
 /** 请求发起者 id（userIdentityId / serviceId）。 */
 requestedBy: varchar("requestedBy", { length: 128 }).notNull(),
 /** 请求发起者类型。 */
 requestPrincipalKind: mysqlEnum("requestPrincipalKind", DELETION_REQUEST_PRINCIPAL_KINDS)
 .notNull()
 .default("user"),
 /** 请求状态机。 */
 requestState: mysqlEnum("requestState", DELETION_REQUEST_STATES).notNull().default("planning"),
 /** 阻塞原因码（JSON 数组，如 ["ACTIVE_LEGAL_HOLD"]；非阻塞时为 null）。 */
 blockedReasonCodes: text("blockedReasonCodes"),
 /** 关联审计事件 id（管理端写 deletion.request 审计时回填）。 */
 auditEventId: varchar("auditEventId", { length: 36 }),
 /** 受理时间。 */
 acceptedAt: datetime("acceptedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 /** 完成时间（终态时设置）。 */
 completedAt: datetime("completedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 tenantSubjectIdx: index("DeletionRequest_tenant_subject_idx").on(
 t.tenantId,
 t.subjectType,
 t.subjectId,
 ),
 tenantStateIdx: index("DeletionRequest_tenant_state_idx").on(t.tenantId, t.requestState),
 tenantRequestedByIdx: index("DeletionRequest_tenant_requested_by_idx").on(
 t.tenantId,
 t.requestedBy,
 ),
 }),
);

export type DeletionRequest = InferSelectModel<typeof deletionRequestTable>;
export type NewDeletionRequest = InferInsertModel<typeof deletionRequestTable>;

// ─── DeletionStep 表 ────────────────────────────────────

export const deletionStepTable = mysqlTable(
 "DeletionStep",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 所属删除请求 id。 */
 requestId: varchar("requestId", { length: 36 })
 .notNull()
 .references(() => deletionRequestTable.id),
 /** 存储类型（5 类 Adapter 之一）。 */
 storeType: mysqlEnum("storeType", DELETION_STORE_TYPES).notNull(),
 /** 该存储内资源标识（如 "thread:thr_001"、"artifact:art_001"、"trace:trc_001"）。 */
 subjectRef: varchar("subjectRef", { length: 256 }).notNull(),
 /** 步骤状态。 */
 stepState: mysqlEnum("stepState", DELETION_STEP_STATES).notNull().default("pending"),
 /** 存储端删除证据引用（completed 时必填）。 */
 evidenceRef: varchar("evidenceRef", { length: 256 }),
 /** retained/blocked 原因或 failed 错误摘要（不含被删正文）。 */
 failureReason: text("failureReason"),
 /** 执行尝试次数（含首次；failed 可重试时递增）。 */
 attemptCount: int("attemptCount").notNull().default(0),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 /** 完成时间（completed/retained/skipped 时设置）。 */
 completedAt: datetime("completedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 requestStoreSubjectUq: uniqueIndex("DeletionStep_request_store_subject_uq").on(
 t.requestId,
 t.storeType,
 t.subjectRef,
 ),
 tenantRequestIdx: index("DeletionStep_tenant_request_idx").on(t.tenantId, t.requestId),
 requestStateIdx: index("DeletionStep_request_state_idx").on(t.requestId, t.stepState),
 }),
);

export type DeletionStep = InferSelectModel<typeof deletionStepTable>;
export type NewDeletionStep = InferInsertModel<typeof deletionStepTable>;
