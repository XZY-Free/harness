/**
 * 副作用核对账本 schema：EffectRecord + EffectTarget（阶段 8 S08-C05）。
 *
 * 事实源：
 * - docs/architecture/persistence.md （effect_record 与 effect_target）、
 * （tool_call.call_state 与 effect_state 同步）、（ToolCall、Effect 与 Credential）。
 * - docs/architecture/domain-model.md 、§10 第 9 条
 * （unknown_effect 不自动重放）。
 * - docs/architecture/api-and-events.md （Gateway 即时核对）、
 * （Admin 长期核对 + 同事务更新 tool_call.call_state + AuditEvent）。
 * - docs/architecture/capabilities-and-security.md 。
 *
 * 关键不变量：
 * - 一条有副作用 ToolCall 恰有一条 EffectRecord（UNIQUE(toolCallId) 一对一）。
 * - effect_target 通过 UNIQUE(effectRecordId, targetHash) 防止同目标重复记录。
 * - 总 effect_state 由目标明细派生：全部 success → confirmed_success；
 * 全部 failure → confirmed_failure；混合 → confirmed_partial；含 unknown → unknown_effect。
 * - 写入后不可变：只能新增 target、更新 target_state/verified_at/evidence_json；
 * effect_type/toolCallId/externalIdempotencyKey 不可修改（补偿语义：另起 ToolCall 通过
 * causation 关联原操作，不修改原事实）。
 * - 跨租户隔离：所有查询按 tenantId 过滤；tenantId 外键 → Tenant(id) ON DELETE CASCADE。
 * - reconcile 同事务更新：effect_record + effect_target + tool_call.call_state +
 * ThreadEvent/JobEvent + AuditEvent（；本阶段仅实现仓储层原子更新，
 * ThreadEvent/AuditEvent 由调用方在更高层补充）。
 * - unknown_effect 不能自动重放；partial success 只允许重试明确失败且安全的目标。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
 bigint,
 datetime,
 index,
 json,
 mysqlEnum,
 mysqlTable,
 text,
 uniqueIndex,
 varchar,
} from "drizzle-orm/mysql-core";

// ─── EffectType ──────────────────────────────────────────

/**
 * 副作用类型（非穷尽枚举）。
 * - create：创建资源（如新建文件 / 创建外部记录）。
 * - update：更新资源。
 * - delete：删除资源。
 * - send：发送消息 / 邮件 / 通知。
 * - payment：发起支付 / 转账。
 * - deploy：部署 / 发布。
 *
 * 文档允许其他类型（"等"），但本表用 mysqlEnum 固定六种以避免任意字符串；
 * 新类型需通过 schema 修订引入。
 */
export const EFFECT_TYPES = ["create", "update", "delete", "send", "payment", "deploy"] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

// ─── EffectState ─────────────────────────────────────────

/**
 * EffectRecord 总状态机（）。
 * - not_started：ToolCall 已创建但副作用尚未触发（默认初始状态）。
 * - confirmed_success：核对完成，全部目标成功。
 * - confirmed_partial：核对完成，部分目标成功（86 个目标中的部分成功）。
 * - confirmed_failure：核对完成，全部失败且未产生影响（可按策略重试）。
 * - unknown_effect：核对后仍存在未知目标；ToolCall.call_state 同步保持 unknown_effect，
 * 禁止自动重放。
 *
 * 状态迁移：
 * - not_started → {confirmed_success | confirmed_partial | confirmed_failure | unknown_effect}
 * - confirmed_*：终态，不可恢复（补偿需另起 ToolCall）。
 * - unknown_effect：可通过后续 reconcile 迁移到 confirmed_*（仍受 target_state 约束）。
 *
 * 文档未定义 reverted 终态；补偿通过 causation 关联原操作，不修改原事实。
 */
export const EFFECT_STATES = [
 "not_started",
 "confirmed_success",
 "confirmed_partial",
 "confirmed_failure",
 "unknown_effect",
] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

/** EffectRecord 终态集合（不可恢复；unknown_effect 可通过 reconcile 迁出）。 */
export const EFFECT_TERMINAL_STATES: readonly EffectState[] = [
 "confirmed_success",
 "confirmed_partial",
 "confirmed_failure",
];

// ─── EffectTargetState ───────────────────────────────────

/**
 * EffectTarget 子状态（）。
 * - confirmed_success：该目标已成功（外部核对确认）。
 * - confirmed_failure：该目标已失败（外部核对确认；可按策略重试）。
 * - unknown：该目标状态未知（核对未完成或目标系统不可达）。
 */
export const EFFECT_TARGET_STATES = ["confirmed_success", "confirmed_failure", "unknown"] as const;
export type EffectTargetState = (typeof EFFECT_TARGET_STATES)[number];

// ─── VerificationMethod ──────────────────────────────────

/**
 * 副作用核对方式（、）。
 * - provider_query：直接查询目标系统（Gateway 即时核对唯一允许方式）。
 * - callback_evidence：基于回调证据（如 webhook 回执）。
 * - manual_evidence：人工证据（管理员签字 / 截图引用）。
 *
 * Gateway 路径仅接受 provider_query；Admin 路径接受三种。
 */
export const VERIFICATION_METHODS = [
 "provider_query",
 "callback_evidence",
 "manual_evidence",
] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/** Gateway 路径允许的核对方式（仅 provider_query）。 */
export const GATEWAY_VERIFICATION_METHODS: readonly VerificationMethod[] = ["provider_query"];

/** Admin 路径允许的核对方式（三种全部）。 */
export const ADMIN_VERIFICATION_METHODS: readonly VerificationMethod[] = [
 "provider_query",
 "callback_evidence",
 "manual_evidence",
];

// ─── EffectRecord 表 ─────────────────────────────────────

/**
 * EffectRecord 表：一条有副作用 ToolCall 的总账（）。
 *
 * 关键约束：
 * - UNIQUE(toolCallId)：一条 ToolCall 至多一条 EffectRecord（一对一）。
 * - tenantId 冗余字段（与 tool_call.tenantId 一致；由调用方保证）。
 * - toolCallId 逻辑外键 → ToolCall.id（不加 DB 级 FK 避免跨阶段耦合）。
 * - effect_type / toolCallId / externalIdempotencyKey 写入后不可修改（不可变事实）。
 * - effect_state / verification_method / verified_at / evidence_json 可通过 reconcile 更新。
 * - external_result_ref 可在 reconcile 中回填（外部系统结果引用）。
 * - 不含 Secret / 未脱敏参数；evidence_json 必须脱敏。
 */
export const effectRecordTable = mysqlTable(
 "EffectRecord",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 所属 ToolCall id（逻辑外键 → ToolCall.id；一对一）。 */
 toolCallId: varchar("toolCallId", { length: 36 }).notNull(),
 /** 副作用类型。 */
 effectType: mysqlEnum("effectType", EFFECT_TYPES).notNull(),
 /** 目标数量和脱敏摘要（JSON：{ total, description, ... }）。 */
 targetSummaryJson: json("targetSummaryJson").notNull(),
 /** 总状态（not_started / confirmed_* / unknown_effect）。 */
 effectState: mysqlEnum("effectState", EFFECT_STATES).notNull().default("not_started"),
 /** 目标系统幂等键（如外部 API 的 Idempotency-Key）。 */
 externalIdempotencyKey: varchar("externalIdempotencyKey", { length: 128 }),
 /** 外部结果引用（如外部任务 id / 资源 URI）。 */
 externalResultRef: varchar("externalResultRef", { length: 512 }),
 /** 核对方式（首次核对后回填）。 */
 verificationMethod: mysqlEnum("verificationMethod", VERIFICATION_METHODS),
 /** 核对时间；未核对时为 null。 */
 verifiedAt: datetime("verifiedAt", { mode: "date", fsp: 3 }),
 /** 不含 Secret 的证据摘要（JSON：{ source, ref, summary, ... }）。 */
 evidenceJson: json("evidenceJson"),
 /** 乐观并发版本号。 */
 versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 toolCallUq: uniqueIndex("EffectRecord_toolCall_uq").on(t.toolCallId),
 tenantToolCallIdx: index("EffectRecord_tenant_toolCall_idx").on(t.tenantId, t.toolCallId),
 tenantStateIdx: index("EffectRecord_tenant_state_idx").on(t.tenantId, t.effectState),
 }),
);

export type EffectRecord = InferSelectModel<typeof effectRecordTable>;
export type NewEffectRecord = InferInsertModel<typeof effectRecordTable>;

// ─── EffectTarget 表 ─────────────────────────────────────

/**
 * EffectTarget 表：EffectRecord 的逐目标明细（）。
 *
 * 关键约束：
 * - UNIQUE(effectRecordId, targetHash)：同 EffectRecord 内同目标不重复。
 * - effectRecordId 外键 → EffectRecord.id ON DELETE CASCADE。
 * - target_hash 必须以 `sha256:` 开头（与 ToolCall.argumentsHash 一致风格）。
 * - target_state 可通过 reconcile 更新；target_ref / target_hash 写入后不可修改。
 * - external_result_ref / verified_at / evidence_json 可在 reconcile 中回填。
 */
export const effectTargetTable = mysqlTable(
 "EffectTarget",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 所属 EffectRecord id（外键 → EffectRecord.id ON DELETE CASCADE）。 */
 effectRecordId: varchar("effectRecordId", { length: 36 })
 .notNull()
 .references(() => effectRecordTable.id),
 /** 目标引用（如 user:email:foo@example.com / file:/tmp/foo.txt）。 */
 targetRef: varchar("targetRef", { length: 512 }).notNull(),
 /** 目标摘要 hash（sha256: 前缀 + 64 hex；由 computeTargetHash 计算）。 */
 targetHash: varchar("targetHash", { length: 128 }).notNull(),
 /** 该目标的核对状态。 */
 targetState: mysqlEnum("targetState", EFFECT_TARGET_STATES).notNull().default("unknown"),
 /** 该目标的外部结果引用；未核实时为 null。 */
 externalResultRef: varchar("externalResultRef", { length: 512 }),
 /** 该目标的核对时间；未核实时为 null。 */
 verifiedAt: datetime("verifiedAt", { mode: "date", fsp: 3 }),
 /** 该目标的证据摘要（JSON）；不含 Secret。 */
 evidenceJson: json("evidenceJson"),
 /** 备注（人工核对时填写）。 */
 notes: text("notes"),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 recordTargetHashUq: uniqueIndex("EffectTarget_record_targetHash_uq").on(
 t.effectRecordId,
 t.targetHash,
 ),
 tenantRecordIdx: index("EffectTarget_tenant_record_idx").on(t.tenantId, t.effectRecordId),
 tenantStateIdx: index("EffectTarget_tenant_state_idx").on(t.tenantId, t.targetState),
 }),
);

export type EffectTarget = InferSelectModel<typeof effectTargetTable>;
export type NewEffectTarget = InferInsertModel<typeof effectTargetTable>;
