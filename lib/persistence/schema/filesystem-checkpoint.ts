/**
 * 文件系统 Checkpoint schema：FilesystemCheckpoint（阶段 8 S08-C06）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §7.3（filesystem_checkpoint）、
 *   §6.3（invocation_attempt.checkpoint_ref 引用本表）、§10 迁移映射第 676 行
 *   （GitCheckpoint 转 FilesystemCheckpoint，不再代表会话恢复）。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §4.1（attempt.checkpoint_ref）。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W06。
 *
 * 与 lib/persistence/schema/context-checkpoint.ts（ContextCheckpoint 上下文组装/压缩点）是不同表：
 * - FilesystemCheckpoint：文件系统状态恢复点（用于 Invocation 失联恢复）。
 * - ContextCheckpoint：上下文组装/压缩点（用于 LLM 上下文窗口管理）。
 * 两者语义不同，不互相冒充（§7.3 第 547 行明确）。
 *
 * 关键不变量：
 * - 只恢复文件状态，不恢复会话（会话恢复读取 Item 和 Event）。
 * - 恢复时必须避开已确认副作用（§6.3 invocation_attempt.checkpoint_ref）。
 * - contentHash 必须是 sha256:<64-hex> 格式。
 * - checkpointRef 必须是受管对象引用，不接受公网 URL。
 * - 写入后不可变（无状态机、无 versionNo 乐观锁）；expiresAt 用于清理。
 * - 跨租户隔离：所有查询按 tenantId 过滤；tenantId 外键 → Tenant(id) ON DELETE CASCADE。
 * - workspaceBindingId 外键 → WorkspaceBinding(id) ON DELETE CASCADE。
 * - invocationId 逻辑外键 → Invocation.id（不加 DB FK 避免跨阶段耦合）。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import { workspaceBinding } from "@/lib/persistence/schema/workspace";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { datetime, index, mysqlTable, varchar } from "drizzle-orm/mysql-core";

// ─── FilesystemCheckpointType ────────────────────────────

/**
 * 文件系统 Checkpoint 类型（应用层枚举，文档未限定穷尽值）。
 * - git：Git commit/tag 作为 checkpoint。
 * - snapshot：文件系统快照（如 ZFS/Btrfs snapshot）。
 * - tarball：tar.gz 归档。
 * - zip：zip 归档。
 */
export const FILESYSTEM_CHECKPOINT_TYPES = ["git", "snapshot", "tarball", "zip"] as const;
export type FilesystemCheckpointType = (typeof FILESYSTEM_CHECKPOINT_TYPES)[number];

// ─── FilesystemCheckpoint 表 ──────────────────────────

/**
 * FilesystemCheckpoint 表：文件系统状态恢复点（§7.3）。
 *
 * 关键约束：
 * - workspaceBindingId 外键 → WorkspaceBinding(id) ON DELETE CASCADE。
 * - invocationId 必填（逻辑外键 → Invocation.id）。
 * - 恢复时必须避开已确认副作用（由调用方在更高层校验）。
 * - 写入后不可变。
 */
export const filesystemCheckpointTable = mysqlTable(
  "FilesystemCheckpoint",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 路径解释所必需的 Binding（DB 级 FK → WorkspaceBinding.id ON DELETE CASCADE）。 */
    workspaceBindingId: varchar("workspaceBindingId", { length: 36 })
      .notNull()
      .references(() => workspaceBinding.id),
    /** 所属 Invocation id（逻辑外键 → Invocation.id；必填）。 */
    invocationId: varchar("invocationId", { length: 36 }).notNull(),
    /** Checkpoint 类型（git / snapshot / tarball / zip）。 */
    checkpointType: varchar("checkpointType", { length: 32 }).notNull(),
    /** Checkpoint 内容存储引用（受管对象引用，不接受公网 URL）。 */
    checkpointRef: varchar("checkpointRef", { length: 512 }).notNull(),
    /** 基线版本引用（如 git commit hash；可为 null）。 */
    baseRevisionRef: varchar("baseRevisionRef", { length: 512 }),
    /** Checkpoint 内容 hash（sha256: 前缀 + 64 hex）。 */
    contentHash: varchar("contentHash", { length: 128 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    /** 过期时间（用于清理；null 表示不过期）。 */
    expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }),
  },
  (t) => ({
    tenantBindingIdx: index("FilesystemCheckpoint_tenant_binding_idx").on(
      t.tenantId,
      t.workspaceBindingId,
    ),
    tenantInvocationIdx: index("FilesystemCheckpoint_tenant_invocation_idx").on(
      t.tenantId,
      t.invocationId,
    ),
    tenantExpiresIdx: index("FilesystemCheckpoint_tenant_expires_idx").on(t.tenantId, t.expiresAt),
  }),
);

export type FilesystemCheckpoint = InferSelectModel<typeof filesystemCheckpointTable>;
export type NewFilesystemCheckpoint = InferInsertModel<typeof filesystemCheckpointTable>;
