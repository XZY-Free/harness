/**
 * V11 公共账本 schema：审计账本 audit_event。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §8、
 *         ../v11-agentkit-platform-development-plan/02-identity-authorization-and-common-ledgers.md S02-W05。
 *
 * 管理、安全、授权和敏感查看的不可修改审计事实：
 * - 发布、路由、策略、授权、Credential、删除、Legal Hold、隔离事件处理、诊断内容查看和导出均写审计。
 * - Audit 记录 actor、action、target、before/after hash、reason 和 request id，不复制无关聊天正文。
 * - Audit 只追加，不允许普通应用账号 UPDATE/DELETE；依法清理走后续数据生命周期流程。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/v11/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { datetime, index, mysqlEnum, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";

/** 审计执行者类型（谁执行了被审计的操作）。 */
export const AUDIT_ACTOR_TYPES = ["user", "service", "workload", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * 审计动作类型目录（S02-W05）。
 *
 * 覆盖：发布、路由、策略、授权、Credential、删除、Legal Hold、隔离事件处理、诊断内容查看和导出。
 * - 前 15 个与 ACTION_CODES 管理动作对齐（操作发生即审计）。
 * - 额外包含只读敏感查看类动作（diagnostic.view / audit.export 本身也是审计动作）。
 *
 * actionType 存储为 varchar（非 enum 约束），未来扩展不需 migration；
 * 本常量供写入前校验使用，未知动作拒绝写入（fail-closed）。
 */
export const AUDIT_ACTION_TYPES = [
  // 管理写动作（与 ACTION_CODES 对齐）
  "agent.revision.create",
  "agent.publish",
  "agent.retract",
  "route.update",
  "route.revision.create",
  "runtime.publish",
  "runtime.retract",
  "tool.schema.publish",
  "policy.publish",
  "credential.bind",
  "credential.revoke",
  "memory.review",
  "job.cancel",
  "job.retry",
  "event.quarantine.resolve",
  "artifact.attestation.verify",
  "artifact.attestation.revoke",
  "legal_hold.manage",
  "deletion.request",
  "audit.export",
  // 管理导出动作（S11-W08）：requested/completed/failed 与 downloaded 审计事件
  "admin.export.requested",
  "admin.export.completed",
  "admin.export.failed",
  "admin.export.downloaded",
  // 敏感查看类动作（只读但需审计）
  "diagnostic.view",
  "audit.read",
  // 运行时安全动作（S12-W05）：Workload Token 撤销审计
  "workload.token.revoked",
  // 备份恢复演练动作（S12-W08）：recovery.drill 审计（发起/完成/失败/取消）
  "recovery.drill",
  // 安全与事故处置动作（S12-W09）：security.incident 审计（创建/调查/隔离/解决/升级）
  "security.incident",
] as const;
export type AuditActionType = (typeof AUDIT_ACTION_TYPES)[number];

export const auditEvent = mysqlTable(
  "AuditEvent",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    actorType: mysqlEnum("actorType", AUDIT_ACTOR_TYPES).notNull(),
    /** 稳定执行者 id：userIdentityId / serviceId / invocationId / "system"。 */
    actorId: varchar("actorId", { length: 128 }).notNull(),
    /** 审计动作类型（见 AUDIT_ACTION_TYPES 目录）。 */
    actionType: varchar("actionType", { length: 64 }).notNull(),
    /** 目标资源类型（agent/route/policy/credential/...）。 */
    targetType: varchar("targetType", { length: 64 }).notNull(),
    /** 目标资源 id；创建操作可为 null。 */
    targetId: varchar("targetId", { length: 128 }),
    /** 变更前内容 sha256 hex；创建操作为 null。 */
    beforeHash: varchar("beforeHash", { length: 64 }),
    /** 变更后内容 sha256 hex；删除操作为 null。 */
    afterHash: varchar("afterHash", { length: 64 }),
    /** 操作原因（人工填写或系统生成）。 */
    reason: text("reason"),
    /** 关联请求 id（X-Request-ID），保证可跟踪。 */
    requestId: varchar("requestId", { length: 64 }).notNull(),
    occurredAt: datetime("occurredAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantOccurredIdx: index("AuditEvent_tenant_occurred_idx").on(t.tenantId, t.occurredAt),
    tenantActorIdx: index("AuditEvent_tenant_actor_idx").on(t.tenantId, t.actorType, t.actorId),
    tenantTargetIdx: index("AuditEvent_tenant_target_idx").on(t.tenantId, t.targetType, t.targetId),
    tenantActionIdx: index("AuditEvent_tenant_action_idx").on(t.tenantId, t.actionType),
  }),
);

export type AuditEvent = InferSelectModel<typeof auditEvent>;
export type NewAuditEvent = InferInsertModel<typeof auditEvent>;
