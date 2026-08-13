/**
 * schema：数据保留策略与 Legal Hold（S12-W06）。
 *
 * 事实源：docs/architecture/security.md §6
 * （为 Thread/Event/Trace/Audit/Artifact/Memory/Knowledge/Job/安全记录定义独立保留策略；
 * Legal Hold 明确对象范围、原因、创建人、批准人、有效期和解除审计）。
 *
 * 表语义：
 * - RetentionPolicy：按 (tenantId, objectType) 唯一的保留策略。retentionDays 决定过期清理；
 * legalHoldDays（可空）为 Legal Hold 解除后的额外保留窗口。dataClass 与 statutoryRequirements
 * 用于解析适用策略（不把一个天数硬编码到所有存储）。
 * - LegalHold：按 (tenantId, targetType, targetId) 唯一的 Legal Hold 记录。holdState=active
 * 时阻止该对象的删除；released 后恢复原保留策略计算。reason/createdBy/approvedBy/validUntil
 * 全部记录，解除时写审计（legal_hold.manage）。
 *
 * 不变量：
 * - 同一 (tenantId, objectType) 仅一条 active 策略（唯一索引保证）。
 * - 同一 (tenantId, targetType, targetId) 仅一条 active Legal Hold（查询时 holdState=active 过滤）。
 * - Legal Hold 不扩大到无关对象：仅匹配的 target 被阻止删除。
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

// ─── 保留策略适用对象类型 ────────────────────────────────────

/**
 * 保留策略适用的对象类型。
 *
 * 每类对象独立保留策略，不把一个天数硬编码到所有存储：
 * - thread：会话主记录
 * - event：事件账本
 * - trace：Trace/Span/Observation
 * - audit：审计账本
 * - artifact：制品元数据（正文由对象存储 Adapter 处理）
 * - memory：记忆条目
 * - knowledge：知识文档
 * - job：任务记录
 * - security_log：安全记录（Workload Token 撤销、登录日志等）
 */
export const RETENTION_OBJECT_TYPES = [
  "thread",
  "event",
  "trace",
  "audit",
  "artifact",
  "memory",
  "knowledge",
  "job",
  "security_log",
] as const;

export type RetentionObjectType = (typeof RETENTION_OBJECT_TYPES)[number];

// ─── Legal Hold 目标类型 ────────────────────────────────────

/**
 * Legal Hold 可挂载的目标类型。
 *
 * 与保留策略不同，Legal Hold 挂载到具体资源实例（按 id），而非类型。
 * - tenant：租户级 Legal Hold（阻止该租户所有对象删除）
 * - thread / invocation / job / artifact / agent_revision：按具体资源实例
 */
export const LEGAL_HOLD_TARGET_TYPES = [
  "tenant",
  "thread",
  "invocation",
  "job",
  "artifact",
  "agent_revision",
] as const;

export type LegalHoldTargetType = (typeof LEGAL_HOLD_TARGET_TYPES)[number];

// ─── Legal Hold 状态 ────────────────────────────────────────

export const LEGAL_HOLD_STATES = ["active", "released"] as const;
export type LegalHoldState = (typeof LEGAL_HOLD_STATES)[number];

// ─── RetentionPolicy 表 ──────────────────────────────────

export const retentionPolicyTable = mysqlTable(
  "RetentionPolicy",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 策略适用的对象类型。 */
    objectType: mysqlEnum("objectType", RETENTION_OBJECT_TYPES).notNull(),
    /** 保留天数（过期后由清理任务删除）。 */
    retentionDays: varchar("retentionDays", { length: 16 }).notNull(),
    /** Legal Hold 解除后的额外保留窗口（天），可空表示无额外保留。 */
    legalHoldDays: varchar("legalHoldDays", { length: 16 }),
    /** 数据分类（如 pii/financial/operational），用于解析适用策略。 */
    dataClass: varchar("dataClass", { length: 64 }).notNull(),
    /** 法定要求说明（如 GDPR/SOX/HIPAA），用于解析适用策略。 */
    statutoryRequirements: text("statutoryRequirements").notNull(),
    /** 策略说明。 */
    description: text("description").notNull(),
    /** 创建者（userIdentityId / serviceId）。 */
    createdBy: varchar("createdBy", { length: 128 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    /** 最后更新者。 */
    updatedBy: varchar("updatedBy", { length: 128 }).notNull(),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantObjectUq: uniqueIndex("RetentionPolicy_tenant_object_uq").on(t.tenantId, t.objectType),
    tenantDataClassIdx: index("RetentionPolicy_tenant_data_class_idx").on(t.tenantId, t.dataClass),
  }),
);

export type RetentionPolicy = InferSelectModel<typeof retentionPolicyTable>;
export type NewRetentionPolicy = InferInsertModel<typeof retentionPolicyTable>;

// ─── LegalHold 表 ────────────────────────────────────────

export const legalHoldTable = mysqlTable(
  "LegalHold",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** Hold 目标类型。 */
    targetType: mysqlEnum("targetType", LEGAL_HOLD_TARGET_TYPES).notNull(),
    /** Hold 目标 id（targetType=tenant 时填 tenantId）。 */
    targetId: varchar("targetId", { length: 128 }).notNull(),
    /** Hold 状态（active/released）。 */
    holdState: mysqlEnum("holdState", LEGAL_HOLD_STATES).notNull().default("active"),
    /** Hold 原因（必须填写，用于审计）。 */
    reason: text("reason").notNull(),
    /** 创建人（发起 Hold 的用户）。 */
    createdBy: varchar("createdBy", { length: 128 }).notNull(),
    /** 批准人（必须填写，Hold 需双人审批）。 */
    approvedBy: varchar("approvedBy", { length: 128 }).notNull(),
    /** Hold 有效期（到期后自动失效，防止遗忘）。 */
    validUntil: datetime("validUntil", { mode: "date", fsp: 3 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    /** 解除时间（holdState=released 时设置）。 */
    releasedAt: datetime("releasedAt", { mode: "date", fsp: 3 }),
    /** 解除操作者（holdState=released 时设置）。 */
    releasedBy: varchar("releasedBy", { length: 128 }),
    /** 解除原因（holdState=released 时设置）。 */
    releaseReason: text("releaseReason"),
  },
  (t) => ({
    tenantTargetUq: uniqueIndex("LegalHold_tenant_target_uq").on(
      t.tenantId,
      t.targetType,
      t.targetId,
    ),
    tenantStateIdx: index("LegalHold_tenant_state_idx").on(t.tenantId, t.holdState),
    validUntilIdx: index("LegalHold_valid_until_idx").on(t.validUntil),
  }),
);

export type LegalHold = InferSelectModel<typeof legalHoldTable>;
export type NewLegalHold = InferInsertModel<typeof legalHoldTable>;
