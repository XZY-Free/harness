/**
 * 文件变更 schema：FileChange（阶段 8 S08-C06）。
 *
 * 事实源：
 * - docs/architecture/persistence.md （file_change）、§9 不变量第 11 条
 * （本地路径必须与 Desktop device/binding 一起解释）。
 * - docs/architecture/api-and-events.md （FileChange 通过 WorkspaceBinding + before/after hash 引用）。
 * - docs/architecture/capabilities-and-security.md 。
 *
 * 关键不变量：
 * - Desktop 原地修改不强制上传；使用 FileChange + WorkspaceBinding + before/after hash 记录。
 * - pathRef 必须是相对 WorkspaceBinding 的路径，不得为绝对路径（/、C:\、\\）。
 * - API 不向无权 Web/管理员返回 Desktop 绝对路径（pathRef 结合 WorkspaceBinding.device 解释）。
 * - changeType=create：beforeHash 必须为 null，afterHash 必填。
 * - changeType=delete：beforeHash 必填，afterHash 必须为 null。
 * - changeType=update/rename/move：beforeHash 与 afterHash 都必填。
 * - artifactId 可选关联到 Artifact（变更结果被上传为 Artifact 时填）。
 * - 写入后不可变（无状态机、无 versionNo 乐观锁）。
 * - 跨租户隔离：所有查询按 tenantId 过滤；tenantId 外键 → Tenant(id) ON DELETE CASCADE。
 * - workspaceBindingId 外键 → WorkspaceBinding(id) ON DELETE CASCADE（路径解释依赖）。
 * - toolCallId 逻辑外键 → ToolCall.id（不加 DB FK 避免跨阶段耦合）。
 * - artifactId 逻辑外键 → Artifact.id（不加 DB FK 避免跨阶段耦合）。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import { workspaceBinding } from "@/lib/persistence/schema/workspace";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { datetime, index, mysqlEnum, mysqlTable, varchar } from "drizzle-orm/mysql-core";

// ─── FileChangeType ──────────────────────────────────────

/**
 * 文件变更类型。
 * - create：新建文件（beforeHash=null，afterHash 必填）。
 * - update：修改文件（beforeHash 与 afterHash 都必填）。
 * - delete：删除文件（beforeHash 必填，afterHash=null）。
 * - rename：重命名（beforeHash 与 afterHash 都必填；pathRef 表达新路径）。
 * - move：移动（beforeHash 与 afterHash 都必填；pathRef 表达新位置）。
 */
export const FILE_CHANGE_TYPES = ["create", "update", "delete", "rename", "move"] as const;
export type FileChangeType = (typeof FILE_CHANGE_TYPES)[number];

// ─── FileChange 表 ────────────────────────────────────

/**
 * FileChange 表：Desktop/Tool 执行产生的文件变更记录（）。
 *
 * 关键约束：
 * - workspaceBindingId 外键 → WorkspaceBinding(id) ON DELETE CASCADE。
 * - pathRef 必须结合 WorkspaceBinding.device 解释；API 默认返回相对展示路径。
 * - beforeHash / afterHash 至少一个非空（create 时 before 为 null；delete 时 after 为 null）。
 * - toolCallId / artifactId 逻辑外键（不加 DB FK）。
 * - 写入后不可变。
 */
export const fileChangeTable = mysqlTable(
 "FileChange",
 {
 id: varchar("id", { length: 36 })
 .primaryKey()
 .notNull()
 .$defaultFn(() => randomUUID()),
 tenantId: varchar("tenantId", { length: 36 })
 .notNull()
 .references(() => tenant.id),
 /** 产生此变更的 ToolCall id（逻辑外键 → ToolCall.id；必填）。 */
 toolCallId: varchar("toolCallId", { length: 36 }).notNull(),
 /** 路径解释所必需的 Binding（DB 级 FK → WorkspaceBinding.id ON DELETE CASCADE）。 */
 workspaceBindingId: varchar("workspaceBindingId", { length: 36 })
 .notNull()
 .references(() => workspaceBinding.id),
 /** 相对 Binding 的路径引用；不得为绝对路径（/、C:\、\\）。 */
 pathRef: varchar("pathRef", { length: 512 }).notNull(),
 /** 变更类型。 */
 changeType: mysqlEnum("changeType", FILE_CHANGE_TYPES).notNull(),
 /** 变更前内容 hash（create 时为 null；update/delete/rename/move 时必填）。 */
 beforeHash: varchar("beforeHash", { length: 128 }),
 /** 变更后内容 hash（delete 时为 null；create/update/rename/move 时必填）。 */
 afterHash: varchar("afterHash", { length: 128 }),
 /** 变更结果被上传为 Artifact 时关联（逻辑外键 → Artifact.id；可为 null）。 */
 artifactId: varchar("artifactId", { length: 36 }),
 createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
 .notNull()
 .$defaultFn(() => new Date()),
 },
 (t) => ({
 tenantToolCallIdx: index("FileChange_tenant_toolCall_idx").on(t.tenantId, t.toolCallId),
 tenantBindingIdx: index("FileChange_tenant_binding_idx").on(t.tenantId, t.workspaceBindingId),
 tenantArtifactIdx: index("FileChange_tenant_artifact_idx").on(t.tenantId, t.artifactId),
 }),
);

export type FileChange = InferSelectModel<typeof fileChangeTable>;
export type NewFileChange = InferInsertModel<typeof fileChangeTable>;
