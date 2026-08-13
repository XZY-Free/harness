/**
 * 受控工具执行链 schema：PermissionDecision + Grant（阶段 8 S08-C03）。
 *
 * 事实源：
 * - docs/architecture/persistence.md （permission_decision、
 * user_action_request 与 grant）、（ToolCall、Effect 与 Credential）。
 * - docs/architecture/domain-model.md （PermissionDecision
 * allow/pause/block）、§9（Credential Gateway）。
 * - docs/architecture/api-and-events.md §10（block 不可被绕过）。
 * - docs/architecture/capabilities-and-security.md 。
 *
 * 关键不变量：
 * - PermissionDecision：UNIQUE(toolCallId, decisionSequence)，每次评估生成新行
 * （允许同一 ToolCall 多次评估，例如 allow 后被覆盖）。
 * - decision=block 不创建可绕过的 UserActionRequest（§10）。
 * - Agent 只能收紧不能放宽平台策略（应用层校验，不在 DB 强制）。
 * - Grant：scope 必须覆盖当前 ToolCall；撤销后不可注入（revokedAt 回填后视为失效）。
 * - credentialRefId 引用 CredentialRef；Grant 不保存 Credential 原值。
 * - userId 引用 UserIdentity；grantType 标识授权来源（user_consent/policy/
 * admin_override）。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import { credentialRefTable } from "@/lib/persistence/schema/tool";
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

// ─── PermissionDecision ──────────────────────────────────

/**
 * PermissionDecision 决策结果（）。
 * - allow：允许执行，无需用户操作。
 * - pause：暂停，等待用户操作（confirmation/auth/grant/input）。
 * 恢复语义由 UserActionRequest 表达，本表只记录决策事实。
 * - block：阻止执行；不创建可绕过的 UserActionRequest（§10）。
 * Agent 只能收紧不能放宽平台策略。
 *
 * 命名区分：与旧 lib/db/schema.ts PERMISSION_DECISIONS 不同值集。
 */
export const PERMISSION_DECISION_VALUES = ["allow", "pause", "block"] as const;
export type PermissionDecisionValue = (typeof PERMISSION_DECISION_VALUES)[number];

/**
 * PermissionDecision 表：单次 ToolCall 的权限评估事实。
 *
 * 关键约束：
 * - UNIQUE(toolCallId, decisionSequence)：同一 ToolCall 多次评估依次递增。
 * - toolCallId 引用 ToolCall（逻辑外键，不加 DB 级 FK 避免跨阶段耦合）。
 * - policyRevisionId 引用当时生效的策略修订（逻辑外键）。
 * - reasonCodesJson 记录触发的策略原因码列表（脱敏，不含敏感参数）。
 * - riskSummaryJson 描述风险摘要（如 risk_class、affected_resources）。
 */
export const permissionDecisionTable = mysqlTable(
 "PermissionDecision",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 所属 ToolCall id（逻辑外键 → ToolCall.id）。 */
 toolCallId: varchar("toolCallId", { length: 36 }).notNull(),
 /** 同一 ToolCall 内决策序号，从 1 开始递增。 */
 decisionSequence: int("decisionSequence").notNull(),
 /** 决策结果（allow/pause/block）。 */
 decision: mysqlEnum("decision", PERMISSION_DECISION_VALUES).notNull(),
 /** 当时生效的策略修订 id（逻辑外键 → PolicyRevision.id）。 */
 policyRevisionId: varchar("policyRevisionId", { length: 36 }),
 /** 触发的策略原因码列表（JSON string[]，如 ["risk_high","destructive_op"]）。 */
 reasonCodesJson: json("reasonCodesJson").notNull(),
 /** 风险摘要（如 { riskClass: "high", affectedResources: [...] }）。 */
 riskSummaryJson: json("riskSummaryJson"),
 /** 决策说明（人类可读，脱敏）。 */
 decisionSummary: text("decisionSummary"),
 /** 评估者（service 名 / user / policy_engine）。 */
 decidedBy: varchar("decidedBy", { length: 128 }).notNull(),
 decidedAt: datetime("decidedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 toolCallSequenceUq: uniqueIndex("PermissionDecision_toolCall_sequence_uq").on(
 t.toolCallId,
 t.decisionSequence,
 ),
 tenantToolCallIdx: index("PermissionDecision_tenant_toolCall_idx").on(t.tenantId, t.toolCallId),
 tenantDecisionIdx: index("PermissionDecision_tenant_decision_idx").on(t.tenantId, t.decision),
 }),
);

export type PermissionDecision = InferSelectModel<typeof permissionDecisionTable>;
export type NewPermissionDecision = InferInsertModel<typeof permissionDecisionTable>;

// ─── Grant Type ──────────────────────────────────────────

/**
 * Grant 授权来源类型。
 * - user_consent：用户主动确认授权（如 OAuth 同意页 / confirmation 通过）。
 * - policy：策略自动授予（如 read-only 工具免确认）。
 * - admin_override：管理员显式覆盖（仅用于紧急情况，必须审计）。
 */
export const GRANT_TYPES = ["user_consent", "policy", "admin_override"] as const;
export type GrantType = (typeof GRANT_TYPES)[number];

// ─── Grant State ─────────────────────────────────────────

/**
 * Grant 生命周期状态。
 * - active：有效。
 * - revoked：已撤销（revokedAt 回填）。
 * - expired：已过期（expiresAt 已过；扫描任务批量更新）。
 */
export const GRANT_STATES = ["active", "revoked", "expired"] as const;
export type GrantState = (typeof GRANT_STATES)[number];

/**
 * Grant 表：用户授权记录（）。
 *
 * 关键约束：
 * - scope 必须覆盖当前 ToolCall 所需 scope（应用层校验）。
 * - 撤销后不可注入（revokedAt 非空时视为失效）。
 * - 过期后不可注入（expiresAt 已过视为失效）。
 * - credentialRefId 引用 CredentialRef（DB 级 FK ON DELETE RESTRICT，
 * 防止 Credential 删除时 Grant 变孤儿）。
 * - userId 引用 UserIdentity（逻辑外键）。
 * - 不保存 Credential 原值，只保存 vaultRef 通过 CredentialRef 间接引用。
 */
export const grantTable = mysqlTable(
 "Grant",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 授权用户 id（逻辑外键 → UserIdentity.id）。 */
 userId: varchar("userId", { length: 36 }).notNull(),
 /** 授权来源类型。 */
 grantType: mysqlEnum("grantType", GRANT_TYPES).notNull(),
 /** 授权 scope（JSON string[]，如 ["tool:execute","file:read:/tmp"])。 */
 scopeJson: json("scopeJson").notNull(),
 /** 关联的 CredentialRef（必填：Grant 必须挂接到具体凭证）。 */
 credentialRefId: varchar("credentialRefId", { length: 36 })
 .notNull()
 .references(() => credentialRefTable.id),
 /** 授权人（user_consent 时 = userId；admin_override 时为管理员 id）。 */
 issuedBy: varchar("issuedBy", { length: 128 }).notNull(),
 issuedAt: datetime("issuedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 /** 过期时间；null 表示永不过期。 */
 expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }),
 /** 撤销时间；null 表示未撤销。 */
 revokedAt: datetime("revokedAt", { mode: "date", fsp: 3 }),
 /** 撤销原因码。 */
 revokeReasonCode: varchar("revokeReasonCode", { length: 64 }),
 /** Grant 状态（active/revoked/expired）。 */
 grantState: mysqlEnum("grantState", GRANT_STATES).notNull().default("active"),
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
 tenantUserStateIdx: index("Grant_tenant_user_state_idx").on(t.tenantId, t.userId, t.grantState),
 tenantCredentialIdx: index("Grant_tenant_credential_idx").on(t.tenantId, t.credentialRefId),
 tenantStateExpiresIdx: index("Grant_tenant_state_expires_idx").on(
 t.tenantId,
 t.grantState,
 t.expiresAt,
 ),
 }),
);

export type Grant = InferSelectModel<typeof grantTable>;
export type NewGrant = InferInsertModel<typeof grantTable>;

/** Grant 终态集合（不可恢复）。 */
export const GRANT_TERMINAL_STATES: readonly GrantState[] = ["revoked", "expired"];

// ─── PolicySet / PolicyRevision / Policy ──────────────────

/**
 * PolicySet 生命周期状态（与 Agent/Skill 对齐）。
 * - draft：刚创建，未启用。
 * - enabled：已启用，可被引用。
 * - disabled：临时停用。
 * - retired：永久退役（终态，不可恢复）。
 */
export const POLICY_LIFECYCLE_STATES = ["draft", "enabled", "disabled", "retired"] as const;
export type PolicyLifecycleState = (typeof POLICY_LIFECYCLE_STATES)[number];

/**
 * PolicyRevision 修订状态。
 * - draft：草稿，可编辑。
 * - published：已发布，业务内容不可修改，可被引用。
 * - withdrawn：已撤回，只阻止新引用，不删除历史引用。
 */
export const POLICY_REVISION_STATES = ["draft", "published", "withdrawn"] as const;
export type PolicyRevisionState = (typeof POLICY_REVISION_STATES)[number];

/**
 * PolicySet 表：稳定策略身份（）。
 *
 * 关键约束：
 * - UNIQUE(tenantId, policySetKey)：租户内稳定 key 唯一。
 * - currentRevisionId 必须指向同一 PolicySet 的 published PolicyRevision（逻辑外键）。
 * - published Revision 业务内容不可修改；只能新建版本。
 */
export const policySetTable = mysqlTable(
 "PolicySet",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 租户内稳定唯一 key（slug），如 "protectedPaths"。 */
 policySetKey: varchar("policySetKey", { length: 128 }).notNull(),
 /** 负责人 userIdentityId（逻辑外键 → UserIdentity.id）；null 表示系统策略。 */
 ownerUserId: varchar("ownerUserId", { length: 36 }),
 /** 当前生效修订 id（逻辑外键 → PolicyRevision.id）；null 表示未发布。 */
 currentRevisionId: varchar("currentRevisionId", { length: 36 }),
 lifecycleState: mysqlEnum("lifecycleState", POLICY_LIFECYCLE_STATES).notNull().default("draft"),
 /** 乐观并发版本号。 */
 versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 deletedAt: datetime("deletedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 tenantKeyUq: uniqueIndex("PolicySet_tenant_policySetKey_uq").on(t.tenantId, t.policySetKey),
 tenantLifecycleUpdatedIdx: index("PolicySet_tenant_lifecycle_updated_idx").on(
 t.tenantId,
 t.lifecycleState,
 t.updatedAt,
 ),
 }),
);

export type PolicySet = InferSelectModel<typeof policySetTable>;
export type NewPolicySet = InferInsertModel<typeof policySetTable>;

/**
 * PolicyRevision 表：不可变策略修订（）。
 *
 * 关键约束：
 * - UNIQUE(policySetId, revisionNo)：PolicySet 内修订号单调递增。
 * - published Revision 业务内容不可修改；只能新建版本。
 * - revisionJson 保存策略规则全量内容（KV value 直接迁入）。
 * - rulesHash 必须以 `sha256:` 前缀存储（应用层校验）。
 */
export const policyRevisionTable = mysqlTable(
 "PolicyRevision",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 policySetId: varchar("policySetId", { length: 36 })
 .notNull()
 .references(() => policySetTable.id),
 /** PolicySet 内单调递增修订号。 */
 revisionNo: bigint("revisionNo", { mode: "number" }).notNull(),
 /** 策略规则全量 JSON（KV value 直接迁入）。 */
 revisionJson: json("revisionJson").notNull(),
 /** 规则内容 hash（sha256: 前缀 + hex）。 */
 rulesHash: varchar("rulesHash", { length: 128 }).notNull(),
 revisionState: mysqlEnum("revisionState", POLICY_REVISION_STATES).notNull().default("draft"),
 /** 创建者 userIdentityId 或 serviceId。 */
 createdBy: varchar("createdBy", { length: 128 }).notNull(),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 publishedAt: datetime("publishedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 setRevisionNoUq: uniqueIndex("PolicyRevision_set_revisionNo_uq").on(
 t.policySetId,
 t.revisionNo,
 ),
 setStateIdx: index("PolicyRevision_set_state_idx").on(t.policySetId, t.revisionState),
 }),
);

export type PolicyRevision = InferSelectModel<typeof policyRevisionTable>;
export type NewPolicyRevision = InferInsertModel<typeof policyRevisionTable>;

/**
 * Policy 表：单条持久化策略规则（ToolPermissionRule 迁入）。
 *
 * 关键约束：
 * - policySetId 引用 PolicySet（逻辑外键，标识所属策略集）。
 * - policyRevisionId 引用 PolicyRevision（逻辑外键，标识所属修订）。
 * - decision 与 PermissionDecision.decision 对齐（allow/pause/block）。
 * - scopeJson 保存映射后的 scope 表达（如 { type: "tenant" }）。
 */
export const policyTable = mysqlTable(
 "Policy",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 所属策略集 id（逻辑外键 → PolicySet.id）。 */
 policySetId: varchar("policySetId", { length: 36 }).notNull(),
 /** 所属修订 id（逻辑外键 → PolicyRevision.id）。 */
 policyRevisionId: varchar("policyRevisionId", { length: 36 }),
 /** 工具匹配模式（如 "tool.writeFile" / "tool.*" / "*"）。 */
 toolPattern: varchar("toolPattern", { length: 128 }).notNull(),
 /** 参数匹配器 JSON（{ pathRegex?, commandRegex?, risk? }）；null 表示无 arg 约束。 */
 argMatcherJson: json("argMatcherJson"),
 /** 决策结果（allow/pause/block，与 PermissionDecision.decision 对齐）。 */
 decision: mysqlEnum("decision", PERMISSION_DECISION_VALUES).notNull(),
 /** 映射后的 scope JSON（如 { type: "tenant" } / { type: "thread", ref: "..." }）。 */
 scopeJson: json("scopeJson").notNull(),
 /** 决策原因（人类可读，脱敏）。 */
 reason: varchar("reason", { length: 256 }),
 /** 越大越优先；同优先级 block > pause > allow。 */
 priority: int("priority").notNull().default(0),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 tenantSetIdx: index("Policy_tenant_set_idx").on(t.tenantId, t.policySetId),
 tenantDecisionIdx: index("Policy_tenant_decision_idx").on(t.tenantId, t.decision),
 }),
);

export type Policy = InferSelectModel<typeof policyTable>;
export type NewPolicy = InferInsertModel<typeof policyTable>;
