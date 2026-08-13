/**
 * Workspace schema：workspace / workspace_binding /
 * workspace_attachment / workspace_attachment_use 表。
 *
 * 事实源：
 * - docs/architecture/persistence.md （workspace/binding/attachment）。
 * - docs/architecture/capabilities-and-security.md §9—16（执行位置语义）。
 * - docs/architecture/capabilities-and-security.md 。
 *
 * 关键不变量（）：
 * - Workspace 只保存逻辑身份和默认位置，不保存可被所有环境解释的绝对路径。
 * - Desktop Binding 必须同时绑定 device 和 location ref；Cloud/Remote 使用受管 location_ref。
 * - Attachment 是 Thread 的额外受限资源，不改变默认 Workspace。
 * - Attachment 使用时再为 Turn 建 usage 记录；UNIQUE(turn_id, workspace_attachment_id)。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 */
import { randomUUID } from "node:crypto";
import { threadTable } from "@/lib/persistence/schema/conversation";
import { device } from "@/lib/persistence/schema/device";
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

// ─── 枚举常量 ──────────────────────────────────────────────

/**
 * Workspace 类型（）。
 * - personal：员工个人 Workspace（默认随身份创建）。
 * - project：项目共享 Workspace。
 * - shared：跨成员共享（受权策略保护）。
 * - system：平台系统级 Workspace（运维/评测用）。
 */
export const WORKSPACE_KINDS = ["personal", "project", "shared", "system"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/**
 * Workspace 生命周期状态。
 * - active：活跃。
 * - archived：归档（只读）。
 * - deleted：软删除（数据生命周期阶段物理清理）。
 */
export const WORKSPACE_LIFECYCLE_STATES = ["active", "archived", "deleted"] as const;
export type WorkspaceLifecycleState = (typeof WORKSPACE_LIFECYCLE_STATES)[number];

/**
 * WorkspaceBinding 类型（）。
 * - desktop：绑定本地设备 + 本地路径（必含 device_id + location_ref）。
 * - cloud：平台托管环境（受管 location_ref，无 device_id）。
 * - remote：远程环境（受管 location_ref，无 device_id）。
 * - sandbox：沙盒环境（短生命周期，受管 location_ref）。
 */
export const WORKSPACE_BINDING_TYPES = ["desktop", "cloud", "remote", "sandbox"] as const;
export type WorkspaceBindingType = (typeof WORKSPACE_BINDING_TYPES)[number];

/**
 * WorkspaceBinding 状态。
 * - active：活跃可用。
 * - inactive：临时不可用（设备离线等）。
 * - revoked：已撤销（不可恢复，仅保留历史引用）。
 */
export const WORKSPACE_BINDING_STATES = ["active", "inactive", "revoked"] as const;
export type WorkspaceBindingState = (typeof WORKSPACE_BINDING_STATES)[number];

/**
 * Attachment 资源类型。
 * - file：单个文件引用。
 * - directory：目录引用。
 * - archive：归档压缩包。
 * - database_snapshot：数据库快照。
 * - external_ref：外部系统引用（如 Confluence page id）。
 */
export const WORKSPACE_ATTACHMENT_RESOURCE_TYPES = [
 "file",
 "directory",
 "archive",
 "database_snapshot",
 "external_ref",
] as const;
export type WorkspaceAttachmentResourceType = (typeof WORKSPACE_ATTACHMENT_RESOURCE_TYPES)[number];

/**
 * Attachment 访问模式。
 * - read：只读（默认）。
 * - read_write：可读写（写入影响原对象位置）。
 */
export const WORKSPACE_ATTACHMENT_ACCESS_MODES = ["read", "read_write"] as const;
export type WorkspaceAttachmentAccessMode = (typeof WORKSPACE_ATTACHMENT_ACCESS_MODES)[number];

/**
 * Attachment 状态。
 * - attached：已挂载（活跃）。
 * - detached：已卸载（阻止后续 Turn 取得新 handle，不撤销已开始的）。
 * - expired：过期（expires_at 到期自动转）。
 */
export const WORKSPACE_ATTACHMENT_STATES = ["attached", "detached", "expired"] as const;
export type WorkspaceAttachmentState = (typeof WORKSPACE_ATTACHMENT_STATES)[number];

// ─── workspace ─────────────────────────────────────────────

export const workspace = mysqlTable(
 "Workspace",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 所有者用户 id（personal Workspace 必填；project/shared 可空）。 */
 ownerUserId: varchar("ownerUserId", { length: 36 }),
 /** 租户内稳定 key（用于 Agent/Runtime 引用）。 */
 workspaceKey: varchar("workspaceKey", { length: 128 }).notNull(),
 /** 显示名称（可变）。 */
 displayName: varchar("displayName", { length: 256 }).notNull(),
 /** 描述（用途、覆盖范围等）。 */
 description: text("description"),
 workspaceKind: mysqlEnum("workspaceKind", WORKSPACE_KINDS).notNull().default("personal"),
 lifecycleState: mysqlEnum("lifecycleState", WORKSPACE_LIFECYCLE_STATES)
 .notNull()
 .default("active"),
 /** 默认环境定义 id（逻辑外键 → EnvironmentDefinition.id；不是实际 Lease）。 */
 defaultEnvironmentDefinitionId: varchar("defaultEnvironmentDefinitionId", { length: 36 }),
 /** 默认 WorkspaceBinding id（逻辑外键 → WorkspaceBinding.id）。 */
 defaultBindingId: varchar("defaultBindingId", { length: 36 }),
 /** 并发版本号（ETag/If-Match 乐观锁）。 */
 versionNo: varchar("versionNo", { length: 64 })
 .notNull()
 .$defaultFn(() => randomUUID()),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 deletedAt: datetime("deletedAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 // 租户内 workspaceKey 唯一。
 tenantKeyUq: uniqueIndex("Workspace_tenant_key_uq").on(t.tenantId, t.workspaceKey),
 tenantOwnerIdx: index("Workspace_tenant_owner_idx").on(t.tenantId, t.ownerUserId),
 tenantLifecycleIdx: index("Workspace_tenant_lifecycle_idx").on(t.tenantId, t.lifecycleState),
 }),
);

// ─── workspace_binding ─────────────────────────────────────

export const workspaceBinding = mysqlTable(
 "WorkspaceBinding",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 所属 Workspace（DB 级 FK → Workspace.id ON DELETE CASCADE）。 */
 workspaceId: varchar("workspaceId", { length: 36 })
 .notNull()
 .references(() => workspace.id),
 bindingType: mysqlEnum("bindingType", WORKSPACE_BINDING_TYPES).notNull(),
 /**
 * 设备 id（仅 desktop binding 必填；DB 级 FK → Device.id）。
 * Cloud/Remote/Sandbox 不绑定具体设备，为 null。
 */
 deviceId: varchar("deviceId", { length: 36 }).references(() => device.id),
 /** 环境定义 id（逻辑外键 → EnvironmentDefinition.id；运行时校验兼容性）。 */
 environmentDefinitionId: varchar("environmentDefinitionId", { length: 36 }),
 /**
 * 位置引用（受管引用，不是绝对路径）：
 * - desktop：相对 device 的本地路径指纹（如 sha256(device_root + relative_path)）。
 * - cloud：对象存储 bucket + key。
 * - remote：远程主机别名 + 路径指纹。
 * - sandbox：沙盒容器内路径指纹。
 */
 locationRef: varchar("locationRef", { length: 512 }).notNull(),
 /** 位置指纹（sha256: 前缀；用于跨环境一致性校验，不暴露原路径）。 */
 locationFingerprint: varchar("locationFingerprint", { length: 128 }),
 bindingState: mysqlEnum("bindingState", WORKSPACE_BINDING_STATES).notNull().default("active"),
 /** 最近一次校验时间（设备在线 + 路径可访问）。 */
 lastVerifiedAt: datetime("lastVerifiedAt", { mode: "date", fsp: 3 }),
 /** 并发版本号（ETag/If-Match 乐观锁）。 */
 versionNo: varchar("versionNo", { length: 64 })
 .notNull()
 .$defaultFn(() => randomUUID()),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 tenantWorkspaceIdx: index("WorkspaceBinding_tenant_workspace_idx").on(
 t.tenantId,
 t.workspaceId,
 ),
 tenantDeviceIdx: index("WorkspaceBinding_tenant_device_idx").on(t.tenantId, t.deviceId),
 tenantStateIdx: index("WorkspaceBinding_tenant_state_idx").on(t.tenantId, t.bindingState),
 }),
);

// ─── workspace_attachment ──────────────────────────────────

export const workspaceAttachment = mysqlTable(
 "WorkspaceAttachment",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 所属 Thread（DB 级 FK → Thread.id ON DELETE CASCADE）。 */
 threadId: varchar("threadId", { length: 36 })
 .notNull()
 .references(() => threadTable.id),
 /** WorkspaceBinding（DB 级 FK → WorkspaceBinding.id）。 */
 workspaceBindingId: varchar("workspaceBindingId", { length: 36 })
 .notNull()
 .references(() => workspaceBinding.id),
 resourceType: mysqlEnum("resourceType", WORKSPACE_ATTACHMENT_RESOURCE_TYPES).notNull(),
 /** 资源引用（受管引用，不是绝对路径；解释依赖 WorkspaceBinding）。 */
 resourceRef: varchar("resourceRef", { length: 512 }).notNull(),
 /** 资源指纹（sha256: 前缀；内容指纹，用于校验完整性）。 */
 resourceFingerprint: varchar("resourceFingerprint", { length: 128 }),
 /** 员工可见展示引用（脱敏后的相对路径/对象名等，不暴露绝对路径）。 */
 displayRef: varchar("displayRef", { length: 256 }),
 accessMode: mysqlEnum("accessMode", WORKSPACE_ATTACHMENT_ACCESS_MODES)
 .notNull()
 .default("read"),
 attachmentState: mysqlEnum("attachmentState", WORKSPACE_ATTACHMENT_STATES)
 .notNull()
 .default("attached"),
 /** 挂载人（用户 id 或 service identity）。 */
 attachedBy: varchar("attachedBy", { length: 128 }).notNull(),
 /** 并发版本号（ETag/If-Match 乐观锁）。 */
 versionNo: varchar("versionNo", { length: 64 })
 .notNull()
 .$defaultFn(() => randomUUID()),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 /** 过期时间（到期自动转 expired；null 表示不过期）。 */
 expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }),
 },
 (t) => ({
 tenantThreadIdx: index("WorkspaceAttachment_tenant_thread_idx").on(t.tenantId, t.threadId),
 tenantBindingIdx: index("WorkspaceAttachment_tenant_binding_idx").on(
 t.tenantId,
 t.workspaceBindingId,
 ),
 tenantStateIdx: index("WorkspaceAttachment_tenant_state_idx").on(t.tenantId, t.attachmentState),
 }),
);

// ─── workspace_attachment_use ──────────────────────────────

export const workspaceAttachmentUse = mysqlTable(
 "WorkspaceAttachmentUse",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 引用 Turn（DB 级 FK → Turn.id）。 */
 turnId: varchar("turnId", { length: 36 }).notNull(),
 /** 引用 Attachment（DB 级 FK → WorkspaceAttachment.id）。 */
 workspaceAttachmentId: varchar("workspaceAttachmentId", { length: 36 })
 .notNull()
 .references(() => workspaceAttachment.id),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 // Turn + Attachment 唯一：同一 Turn 不重复引用同一 Attachment。
 turnAttachmentUq: uniqueIndex("WorkspaceAttachmentUse_turn_attachment_uq").on(
 t.turnId,
 t.workspaceAttachmentId,
 ),
 tenantTurnIdx: index("WorkspaceAttachmentUse_tenant_turn_idx").on(t.tenantId, t.turnId),
 tenantAttachmentIdx: index("WorkspaceAttachmentUse_tenant_attachment_idx").on(
 t.tenantId,
 t.workspaceAttachmentId,
 ),
 }),
);

// ─── 类型导出 ──────────────────────────────────────────────

export type Workspace = InferSelectModel<typeof workspace>;
export type WorkspaceInsert = InferInsertModel<typeof workspace>;

export type WorkspaceBinding = InferSelectModel<typeof workspaceBinding>;
export type WorkspaceBindingInsert = InferInsertModel<typeof workspaceBinding>;

export type WorkspaceAttachment = InferSelectModel<typeof workspaceAttachment>;
export type WorkspaceAttachmentInsert = InferInsertModel<typeof workspaceAttachment>;

export type WorkspaceAttachmentUse = InferSelectModel<typeof workspaceAttachmentUse>;
export type WorkspaceAttachmentUseInsert = InferInsertModel<typeof workspaceAttachmentUse>;

/** 校验位置/资源指纹格式（sha256: 前缀 + 64 hex）。 */
export function isValidWorkspaceFingerprint(hash: string): boolean {
 return /^sha256:[0-9a-f]{64}$/.test(hash);
}
