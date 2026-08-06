/**
 * schema：备份恢复演练与一致性核对（S12-W08）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md §8
 * （数据库备份、对象版本/复制、配置和密钥恢复分别定义 RPO/RTO 与责任边界；
 * 恢复演练验证 Event sequence、投影 checkpoint、Artifact 引用、Legal Hold 和删除证据的一致性；
 * Runtime/Worker/队列故障演练覆盖未完成 ToolCall、unknown Effect、Job 恢复和 UserAction 等待；
 * 演练在隔离环境使用真实组件，不连接生产数据库，不以备份任务成功日志代替可恢复性）。
 *
 * 表语义：
 * - RecoveryDrill：恢复演练主体。记录演练类型/RPO/RTO 目标/执行人/状态机/一致性汇总/审计事件 id。
 * drillState 推进：scheduled → running → completed / failed / cancelled。
 * 演练必须在隔离环境执行，记录 environment_tag（如 isolated-staging-001）。
 * - RecoveryDrillCheck：每次演练下的一致性检查项。按 (drillId, checkType) 唯一。
 * checkState：pending → running → passed / failed / skipped。
 * passed/failed 要求 evidence_ref（存储端证据，不能用日志文本冒充）。
 *
 * 不变量：
 * - 同一 (drillId, checkType) 仅一条 check（唯一索引保证）。
 * - drillState=completed 要求所有 in-scope check 为 passed/skipped。
 * - drillState=failed 时至少一条 check 为 failed。
 * - 不写 ThreadEvent，只写管理域 AuditEvent（recovery.drill）。
 * - 不以备份任务成功日志代替可恢复性：passed 要求 evidence_ref 指向实际核对证据。
 * - 演练不连接生产数据库：environment_tag 标识隔离环境。
 *
 * 生命周期优先级：
 * - 演练记录作为可恢复性证据，与 Retention Policy 独立（不因保留期到期删除）。
 * - 演练失败立即触发事故处置流程（S12-W09）。
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

// ─── 演练类型 ──────────────────────────────────────────────

/**
 * 恢复演练类型（覆盖 4 类恢复场景）。
 *
 * 对应方案 §8：
 * - db_restore：数据库备份恢复（Event sequence + 投影 checkpoint 一致性）。
 * - object_version：对象存储版本/复制恢复（Artifact 引用完整性）。
 * - secret_restore：配置与密钥恢复（Credential 可用性）。
 * - runtime_failover：Runtime/Worker 故障切换（未完成 ToolCall + unknown Effect 恢复）。
 * - queue_failover：队列故障切换（Job 恢复 + UserAction 等待恢复）。
 *
 * 注：runtime_failover 和 queue_failover 在隔离环境注入故障，
 * 验证 Runtime/Job 的恢复机制（recovery-queries / redispatch-queries）正确处理：
 * - 未完成 ToolCall 保持 pending（不伪造完成）。
 * - unknown Effect 保持 unknown（不自动重复高影响调用）。
 * - Job 恢复走 requires_redispatch（不丢失）。
 * - UserAction 等待状态保持 waiting_user（不超时静默失败）。
 */
export const RECOVERY_DRILL_TYPES = [
 "db_restore",
 "object_version",
 "secret_restore",
 "runtime_failover",
 "queue_failover",
] as const;
export type RecoveryDrillType = (typeof RECOVERY_DRILL_TYPES)[number];

// ─── 演练状态机 ────────────────────────────────────────────

/**
 * 演练状态（与 DeletionRequest 状态机模式一致）。
 * - scheduled：已调度，等待执行（隔离环境准备中）。
 * - running：演练执行中（故障注入 + 恢复 + 一致性核对）。
 * - completed：演练完成，所有 in-scope check passed/skipped。
 * - failed：演练失败，至少一条 check failed。
 * - cancelled：演练取消（隔离环境异常或人工中止）。
 */
export const RECOVERY_DRILL_STATES = [
 "scheduled",
 "running",
 "completed",
 "failed",
 "cancelled",
] as const;
export type RecoveryDrillState = (typeof RECOVERY_DRILL_STATES)[number];

// ─── 检查类型 ──────────────────────────────────────────────

/**
 * 一致性检查类型（覆盖方案 §8 列出的全部一致性维度）。
 *
 * - event_sequence：Event sequence 连续无间隙（恢复后 producer_sequence 不丢不重）。
 * - projection_checkpoint：投影 checkpoint 水位一致（replay 后 ThreadItem 与 ThreadEvent 对齐）。
 * - artifact_ref：Artifact 引用完整（content_ref 指向的对象可读取）。
 * - legal_hold：Legal Hold 仍生效（恢复后阻止删除不变）。
 * - deletion_evidence：删除证据完整（completed DeletionStep 含 evidenceRef）。
 * - tool_call_pending：未完成 ToolCall 保持 pending（不伪造完成）。
 * - unknown_effect：unknown Effect 保持 unknown（不自动重复高影响调用）。
 * - job_recovery：Job 恢复走 requires_redispatch（不丢失）。
 * - user_action_wait：UserAction 等待状态保持 waiting_user（不超时静默失败）。
 */
export const RECOVERY_CHECK_TYPES = [
 "event_sequence",
 "projection_checkpoint",
 "artifact_ref",
 "legal_hold",
 "deletion_evidence",
 "tool_call_pending",
 "unknown_effect",
 "job_recovery",
 "user_action_wait",
] as const;
export type RecoveryCheckType = (typeof RECOVERY_CHECK_TYPES)[number];

// ─── 检查状态 ──────────────────────────────────────────────

/**
 * 检查项状态。
 * - pending：待执行（演练调度时根据 drillType 预填）。
 * - running：核对中（checker 执行中）。
 * - passed：核对通过（含 evidenceRef 证据）。
 * - failed：核对失败（含 evidenceRef 指向失败证据 + failureReason）。
 * - skipped：跳过（该 checkType 不适用于本次 drillType）。
 */
export const RECOVERY_CHECK_STATES = ["pending", "running", "passed", "failed", "skipped"] as const;
export type RecoveryCheckState = (typeof RECOVERY_CHECK_STATES)[number];

// ─── Drill × CheckType 适用矩阵 ────────────────────────────

/**
 * 各 drillType 适用的 checkType 集合（用于 scheduled → running 时预填 check 项）。
 *
 * 设计依据方案 §8：
 * - db_restore 验证 Event sequence + 投影 checkpoint + Artifact 引用 + Legal Hold + 删除证据。
 * - object_version 验证 Artifact 引用 + 删除证据（对象版本可恢复）。
 * - secret_restore 验证 Legal Hold（密钥恢复后策略仍生效）+ 删除证据（Credential 可用）。
 * - runtime_failover 验证 ToolCall pending + unknown Effect + Job 恢复 + UserAction 等待。
 * - queue_failover 验证 Job 恢复 + UserAction 等待（队列恢复不丢失待处理任务）。
 */
export const DRILL_CHECK_MATRIX: Record<RecoveryDrillType, readonly RecoveryCheckType[]> = {
 db_restore: [
 "event_sequence",
 "projection_checkpoint",
 "artifact_ref",
 "legal_hold",
 "deletion_evidence",
 ],
 object_version: ["artifact_ref", "deletion_evidence"],
 secret_restore: ["legal_hold", "deletion_evidence"],
 runtime_failover: ["tool_call_pending", "unknown_effect", "job_recovery", "user_action_wait"],
 queue_failover: ["job_recovery", "user_action_wait"],
};

// ─── RecoveryDrill 表 ───────────────────────────────────

export const recoveryDrillTable = mysqlTable(
 "RecoveryDrill",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 演练类型（5 类恢复场景）。 */
 drillType: mysqlEnum("drillType", RECOVERY_DRILL_TYPES).notNull(),
 /** 演练状态（状态机）。 */
 drillState: mysqlEnum("drillState", RECOVERY_DRILL_STATES).notNull().default("scheduled"),
 /**
 * RPO 目标（秒）：可容忍的数据丢失窗口。
 * 由方案 §8 定义责任边界；drillType 决定默认值（db_restore=300, object_version=3600, 等）。
 */
 rpoTargetSeconds: int("rpoTargetSeconds").notNull(),
 /**
 * RTO 目标（秒）：可容忍的恢复时间。
 * 由方案 §8 定义责任边界；drillType 决定默认值。
 */
 rtoTargetSeconds: int("rtoTargetSeconds").notNull(),
 /** 实际 RPO（秒）：演练测得的实际数据丢失窗口。 */
 rpoActualSeconds: int("rpoActualSeconds"),
 /** 实际 RTO（秒）：演练测得的实际恢复时间。 */
 rtoActualSeconds: int("rtoActualSeconds"),
 /**
 * 隔离环境标识（如 isolated-staging-001）。
 * 演练必须在隔离环境执行，不连接生产数据库。
 */
 environmentTag: varchar("environmentTag", { length: 128 }).notNull(),
 /** 演练原因（人工填写或系统生成）。 */
 reason: text("reason"),
 /** 执行人 id（userIdentityId / serviceId）。 */
 executedBy: varchar("executedBy", { length: 128 }).notNull(),
 /** 执行人类型（user / service）。 */
 executedByKind: mysqlEnum("executedByKind", ["user", "service"]).notNull().default("user"),
 /** 一致性汇总 JSON（checkCount/passedCount/failedCount/skippedCount）。 */
 consistencySummaryJson: text("consistencySummaryJson"),
 /** 审计事件 id（recovery.drill 审计）。 */
 auditEventId: varchar("auditEventId", { length: 36 }),
 /** 失败原因（drillState=failed 时填写）。 */
 failureReason: text("failureReason"),
 /** 关联请求 id（X-Request-ID），保证可跟踪。 */
 requestId: varchar("requestId", { length: 64 }),
 scheduledAt: datetime("scheduledAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 startedAt: datetime("startedAt", { mode: "date", fsp: 3 }),
 completedAt: datetime("completedAt", { mode: "date", fsp: 3 }),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 tenantScheduledIdx: index("RecoveryDrill_tenant_scheduled_idx").on(t.tenantId, t.scheduledAt),
 tenantStateIdx: index("RecoveryDrill_tenant_state_idx").on(t.tenantId, t.drillState),
 tenantTypeIdx: index("RecoveryDrill_tenant_type_idx").on(t.tenantId, t.drillType),
 tenantExecutedByIdx: index("RecoveryDrill_tenant_executed_by_idx").on(t.tenantId, t.executedBy),
 }),
);

export type RecoveryDrill = InferSelectModel<typeof recoveryDrillTable>;
export type NewRecoveryDrill = InferInsertModel<typeof recoveryDrillTable>;

// ─── RecoveryDrillCheck 表 ──────────────────────────────

export const recoveryDrillCheckTable = mysqlTable(
 "RecoveryDrillCheck",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 所属演练 id。 */
 drillId: varchar("drillId", { length: 36 })
 .notNull()
 .references(() => recoveryDrillTable.id),
 /** 检查类型（9 类一致性维度）。 */
 checkType: mysqlEnum("checkType", RECOVERY_CHECK_TYPES).notNull(),
 /** 检查状态（状态机）。 */
 checkState: mysqlEnum("checkState", RECOVERY_CHECK_STATES).notNull().default("pending"),
 /**
 * 存储端证据引用（passed/failed 必填）。
 * 指向实际核对证据（如 Event sequence 报告、Artifact 引用清单、ToolCall 状态快照）。
 * 不能用日志文本冒充可恢复性。
 */
 evidenceRef: varchar("evidenceRef", { length: 256 }),
 /** 核对详情 JSON（checkType 特定的核对结果，如 gapCount / missingRefs / pendingCount）。 */
 detailsJson: text("detailsJson"),
 /** 失败原因（checkState=failed 时填写）。 */
 failureReason: text("failureReason"),
 /** 核对耗时（毫秒）。 */
 durationMs: int("durationMs"),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 completedAt: datetime("completedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 drillCheckUq: uniqueIndex("RecoveryDrillCheck_drill_check_uq").on(t.drillId, t.checkType),
 tenantDrillIdx: index("RecoveryDrillCheck_tenant_drill_idx").on(t.tenantId, t.drillId),
 drillStateIdx: index("RecoveryDrillCheck_drill_state_idx").on(t.drillId, t.checkState),
 }),
);

export type RecoveryDrillCheck = InferSelectModel<typeof recoveryDrillCheckTable>;
export type NewRecoveryDrillCheck = InferInsertModel<typeof recoveryDrillCheckTable>;
