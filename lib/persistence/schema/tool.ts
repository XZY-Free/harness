/**
 * 控制面 schema：Connection / CredentialRef / ToolProvider / Tool / ToolSchemaRevision
 * （阶段 6 S06-C02）。
 *
 * 事实源：
 * - docs/architecture/persistence.md （能力和治理表）
 * - docs/architecture/capabilities-and-security.md §4（Tool）、§8（MCP）
 * - docs/architecture/capability-and-collaboration-api.md （读取 Tool Schema）
 *
 * 模型边界：
 * - ToolProvider 对内置、HTTP/OpenAPI、MCP 和外部 Adapter 使用协议中立模型。
 * - Tool 保存稳定 id、提供方、风险分类和当前 SchemaRevision。
 * - SchemaRevision 保存机器输入/输出 Schema、描述、风险元数据和 hash。
 * - 模型只提交业务参数；tenant、user、connection、credential 和 trace 由平台注入。
 * - Credential 不进模型上下文（§13）。
 * - 稳定边界是单次 ToolCall（）。
 *
 * 关键约束：
 * - UNIQUE(tenantId, connectionKey)：租户内 Connection key 唯一。
 * - UNIQUE(tenantId, providerKey)：租户内 ToolProvider key 唯一。
 * - UNIQUE(tenantId, providerId, toolKey)：Provider 内 Tool key 唯一。
 * - UNIQUE(toolId, revisionNo)：Tool 内 SchemaRevision 号单调递增。
 * - published SchemaRevision 业务内容不可修改；只能新建版本。
 * - withdrawn 只阻止新发布或路由，不删除历史引用。
 * - currentSchemaRevisionId 必须指向同一 Tool 的 published SchemaRevision（逻辑外键，应用层校验）。
 * - connectionKey/providerKey/toolKey 正则 `^[a-z0-9]+(-[a-z0-9]+)*$`，1-64 字符（应用层校验）。
 * - schemaHash / fingerprint 必须以 `sha256:` 前缀存储（应用层校验）。
 * - CredentialRef 不存密文，只保存 Vault 引用 + 指纹（用于脱敏比对）。
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

// ─── Connection Lifecycle ─────────────────────────────────

/**
 * Connection 生命周期状态。
 * - draft：刚创建，未启用。
 * - enabled：已启用，可被 Provider 引用。
 * - disabled：临时停用。
 * - retired：永久退役（终态，不可恢复）。
 */
export const CONNECTION_LIFECYCLE_STATES = ["draft", "enabled", "disabled", "retired"] as const;
export type ConnectionLifecycleState = (typeof CONNECTION_LIFECYCLE_STATES)[number];

/** Connection 类型（varchar 存储以便扩展，不使用 enum 约束）。 */
export const CONNECTION_TYPES = [
 "http",
 "mcp",
 "webhook",
 "database",
 "script",
 "ssh",
 "other",
] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

/** Connection 鉴权方式。 */
export const CONNECTION_AUTH_METHODS = [
 "none",
 "bearer",
 "basic",
 "api_key",
 "oauth",
 "ssh_key",
 "cookie",
 "custom",
] as const;
export type ConnectionAuthMethod = (typeof CONNECTION_AUTH_METHODS)[number];

// ─── CredentialRef Lifecycle ──────────────────────────────

/**
 * CredentialRef 生命周期。
 * - active：可用，可被注入到 ToolCall。
 * - rotated：已轮换（被新版本替代，不再注入）。
 * - revoked：已撤销（终态，不可恢复）。
 */
export const CREDENTIAL_REF_LIFECYCLE_STATES = ["active", "rotated", "revoked"] as const;
export type CredentialRefLifecycleState = (typeof CREDENTIAL_REF_LIFECYCLE_STATES)[number];

// ─── ToolProvider Lifecycle ───────────────────────────────

/**
 * ToolProvider 生命周期状态。
 * - draft：刚创建，未启用。
 * - enabled：已启用，可注册 Tool。
 * - disabled：临时停用。
 * - retired：永久退役（终态，不可恢复）。
 */
export const TOOL_PROVIDER_LIFECYCLE_STATES = ["draft", "enabled", "disabled", "retired"] as const;
export type ToolProviderLifecycleState = (typeof TOOL_PROVIDER_LIFECYCLE_STATES)[number];

/** ToolProvider 类型（协议中立，varchar 存储以便扩展）。 */
export const TOOL_PROVIDER_TYPES = [
 "builtin",
 "custom",
 "mcp",
 "webhook",
 "script",
 "http_openapi",
] as const;
export type ToolProviderType = (typeof TOOL_PROVIDER_TYPES)[number];

/** ToolProvider 信任级别。 */
export const TOOL_PROVIDER_TRUST_LEVELS = ["low", "standard", "high", "trusted"] as const;
export type ToolProviderTrustLevel = (typeof TOOL_PROVIDER_TRUST_LEVELS)[number];

// ─── Tool Lifecycle & Risk ────────────────────────────────

/**
 * Tool 生命周期状态。
 * - draft：刚创建，未启用。
 * - enabled：已启用，可被路由。
 * - disabled：临时停用。
 * - retired：永久退役（终态，不可恢复）。
 */
export const TOOL_LIFECYCLE_STATES = ["draft", "enabled", "disabled", "retired"] as const;
export type ToolLifecycleState = (typeof TOOL_LIFECYCLE_STATES)[number];

/** Tool 风险等级。 */
export const TOOL_RISK_CLASSES = ["low", "medium", "high", "critical"] as const;
export type ToolRiskClass = (typeof TOOL_RISK_CLASSES)[number];

// ─── ToolSchemaRevision State ─────────────────────────────

/**
 * ToolSchemaRevision 状态。
 * - draft：草稿，可编辑业务内容。
 * - published：已发布，业务内容不可修改，可被路由引用。
 * - withdrawn：已撤回，只阻止新发布或路由，不删除历史引用。
 */
export const TOOL_REVISION_STATES = ["draft", "published", "withdrawn"] as const;
export type ToolRevisionState = (typeof TOOL_REVISION_STATES)[number];

// ─── Connection ───────────────────────────────────────────

export const connectionTable = mysqlTable(
 "Connection",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 租户内稳定唯一 key（slug），正则 `^[a-z0-9]+(-[a-z0-9]+)*$`，1-64 字符（应用层校验）。 */
 connectionKey: varchar("connectionKey", { length: 128 }).notNull(),
 /** 连接类型（http/mcp/webhook/database/script/ssh/other，varchar 存储以扩展）。 */
 connectionType: varchar("connectionType", { length: 32 }).notNull(),
 /** 端点引用（URL / command / DSN）；null 表示无固定端点（如 builtin）。 */
 endpointRef: varchar("endpointRef", { length: 512 }),
 /** 鉴权方式（默认 none）。 */
 authMethod: varchar("authMethod", { length: 32 }).notNull().default("none"),
 /** 负责人 userIdentityId（逻辑外键 → UserIdentity.id）。 */
 ownerUserId: varchar("ownerUserId", { length: 36 }).notNull(),
 lifecycleState: mysqlEnum("lifecycleState", CONNECTION_LIFECYCLE_STATES)
 .notNull()
 .default("draft"),
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
 tenantKeyUq: uniqueIndex("Connection_tenant_connectionKey_uq").on(t.tenantId, t.connectionKey),
 tenantLifecycleUpdatedIdx: index("Connection_tenant_lifecycle_updated_idx").on(
 t.tenantId,
 t.lifecycleState,
 t.updatedAt,
 ),
 }),
);

export type Connection = InferSelectModel<typeof connectionTable>;
export type NewConnection = InferInsertModel<typeof connectionTable>;

// ─── CredentialRef ────────────────────────────────────────

export const credentialRefTable = mysqlTable(
 "CredentialRef",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 关联 Connection（可空：credential 可绑定到 principal 而非 connection）。 */
 connectionId: varchar("connectionId", { length: 36 }).references(() => connectionTable.id),
 /** 凭证提供方标识（vault / env / oauth_provider 等）。 */
 provider: varchar("provider", { length: 64 }).notNull(),
 /** Vault 引用路径（不含密文）。 */
 vaultRef: varchar("vaultRef", { length: 512 }).notNull(),
 /** 凭证指纹（sha256: 前缀，用于脱敏比对）。 */
 fingerprint: varchar("fingerprint", { length: 128 }).notNull(),
 /** 权限 scope（JSON 数组）。 */
 scopeJson: json("scopeJson"),
 /** 过期时间；null 表示永不过期。 */
 expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }),
 lifecycleState: mysqlEnum("lifecycleState", CREDENTIAL_REF_LIFECYCLE_STATES)
 .notNull()
 .default("active"),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 tenantConnectionIdx: index("CredentialRef_tenant_connectionId_idx").on(
 t.tenantId,
 t.connectionId,
 ),
 tenantFingerprintIdx: index("CredentialRef_tenant_fingerprint_idx").on(
 t.tenantId,
 t.fingerprint,
 ),
 }),
);

export type CredentialRef = InferSelectModel<typeof credentialRefTable>;
export type NewCredentialRef = InferInsertModel<typeof credentialRefTable>;

// ─── ToolProvider ─────────────────────────────────────────

export const toolProviderTable = mysqlTable(
 "ToolProvider",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 租户内稳定唯一 key（slug），正则 `^[a-z0-9]+(-[a-z0-9]+)*$`，1-64 字符（应用层校验）。 */
 providerKey: varchar("providerKey", { length: 128 }).notNull(),
 /** 提供方类型（builtin/custom/mcp/webhook/script/http_openapi）。 */
 providerType: varchar("providerType", { length: 32 }).notNull(),
 /** 关联 Connection（MCP/HTTP 类型必填，builtin/custom 可空）。 */
 connectionId: varchar("connectionId", { length: 36 }).references(() => connectionTable.id),
 /** 信任级别（low/standard/high/trusted）。 */
 trustLevel: varchar("trustLevel", { length: 32 }).notNull().default("standard"),
 displayName: varchar("displayName", { length: 256 }).notNull(),
 description: text("description"),
 /** 负责人 userIdentityId（逻辑外键 → UserIdentity.id）。 */
 ownerUserId: varchar("ownerUserId", { length: 36 }).notNull(),
 lifecycleState: mysqlEnum("lifecycleState", TOOL_PROVIDER_LIFECYCLE_STATES)
 .notNull()
 .default("draft"),
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
 tenantKeyUq: uniqueIndex("ToolProvider_tenant_providerKey_uq").on(t.tenantId, t.providerKey),
 tenantTypeLifecycleIdx: index("ToolProvider_tenant_providerType_lifecycle_idx").on(
 t.tenantId,
 t.providerType,
 t.lifecycleState,
 ),
 }),
);

export type ToolProvider = InferSelectModel<typeof toolProviderTable>;
export type NewToolProvider = InferInsertModel<typeof toolProviderTable>;

// ─── Tool ─────────────────────────────────────────────────

export const toolTable = mysqlTable(
 "Tool",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 所属 ToolProvider。 */
 providerId: varchar("providerId", { length: 36 })
 .notNull()
 .references(() => toolProviderTable.id),
 /** Provider 内稳定唯一 key（slug），正则 `^[a-z0-9]+(-[a-z0-9]+)*$`，1-64 字符（应用层校验）。 */
 toolKey: varchar("toolKey", { length: 128 }).notNull(),
 displayName: varchar("displayName", { length: 256 }).notNull(),
 description: text("description"),
 /** 风险等级（low/medium/high/critical）。 */
 riskClass: varchar("riskClass", { length: 32 }).notNull().default("medium"),
 /** 当前 SchemaRevision id（逻辑外键 → ToolSchemaRevision.id）；null 表示未发布。 */
 currentSchemaRevisionId: varchar("currentSchemaRevisionId", { length: 36 }),
 lifecycleState: mysqlEnum("lifecycleState", TOOL_LIFECYCLE_STATES).notNull().default("draft"),
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
 tenantProviderKeyUq: uniqueIndex("Tool_tenant_providerId_toolKey_uq").on(
 t.tenantId,
 t.providerId,
 t.toolKey,
 ),
 tenantLifecycleRiskIdx: index("Tool_tenant_lifecycle_riskClass_idx").on(
 t.tenantId,
 t.lifecycleState,
 t.riskClass,
 ),
 }),
);

export type Tool = InferSelectModel<typeof toolTable>;
export type NewTool = InferInsertModel<typeof toolTable>;

// ─── ToolSchemaRevision ───────────────────────────────────

export const toolSchemaRevisionTable = mysqlTable(
 "ToolSchemaRevision",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 toolId: varchar("toolId", { length: 36 })
 .notNull()
 .references(() => toolTable.id),
 /** Tool 内单调递增版本号。 */
 revisionNo: bigint("revisionNo", { mode: "number" }).notNull(),
 /** 版本描述（人类可读）。 */
 description: text("description"),
 /** 机器输入 Schema（JSON Schema，必填）。 */
 inputSchemaJson: json("inputSchemaJson").notNull(),
 /** 输出结构或内容类型；null 表示无输出。 */
 outputSchemaJson: json("outputSchemaJson"),
 /** Schema hash（sha256: 前缀 + 64 hex，应用层校验）。 */
 schemaHash: varchar("schemaHash", { length: 128 }).notNull(),
 /** 风险元数据（effect/data_class/network_scope/side_effects）。 */
 riskMetadataJson: json("riskMetadataJson"),
 revisionState: mysqlEnum("revisionState", TOOL_REVISION_STATES).notNull().default("draft"),
 /** 创建者 userIdentityId 或 serviceId。 */
 createdBy: varchar("createdBy", { length: 128 }).notNull(),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 publishedAt: datetime("publishedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 toolRevisionNoUq: uniqueIndex("ToolSchemaRevision_tool_revisionNo_uq").on(
 t.toolId,
 t.revisionNo,
 ),
 toolStateIdx: index("ToolSchemaRevision_tool_state_idx").on(t.toolId, t.revisionState),
 }),
);

export type ToolSchemaRevision = InferSelectModel<typeof toolSchemaRevisionTable>;
export type NewToolSchemaRevision = InferInsertModel<typeof toolSchemaRevisionTable>;
