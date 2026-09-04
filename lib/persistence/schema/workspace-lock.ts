/**
 * Workspace 并发控制 schema：workspace_write_lock 表。
 *
 * 事实源：
 * - docs/architecture/conversations.md §13（并发 Workspace）、
 * §17（调度与资源可靠性——Workspace 写锁）、§18（预算硬上限时副作用先核对）
 * - docs/architecture/persistence.md （WorkspaceBinding 不可变）
 * - docs/architecture/conversations.md 、S09-C07
 *
 * 关键不变量（§13、§17）：
 * - Desktop 同路径同时只有一个活跃写锁（UNIQUE(workspace_binding_id, path_fingerprint) WHERE lock_state=acquired）。
 * - 写锁有持锁 Invocation + 可选 ThreadRelation，过期或 Invocation lost 时自动释放。
 * - 写锁状态变化通过 ThreadEvent 记录，不修改旧事件。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 */
import { randomUUID } from "node:crypto";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { tenant } from "@/lib/persistence/schema/identity";
import { workspaceBinding } from "@/lib/persistence/schema/workspace";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  datetime,
  index,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── 枚举常量 ──────────────────────────────────────────────

/**
 * Workspace 写锁状态。
 * - acquired：持锁中。
 * - released：正常释放（持锁 Invocation 主动释放或 Turn 完成）。
 * - expired：超过 expires_at 自动转（后台 reap 或下次 acquire 时清理）。
 * - revoked：因 Invocation lost（S09-C06）被强制释放。
 */
export const WORKSPACE_WRITE_LOCK_STATES = ["acquired", "released", "expired", "revoked"] as const;
export type WorkspaceWriteLockState = (typeof WORKSPACE_WRITE_LOCK_STATES)[number];

// ─── workspace_write_lock ─────────────────────────────────

export const workspaceWriteLock = mysqlTable(
  "WorkspaceWriteLock",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 所属 WorkspaceBinding（DB 级 FK → WorkspaceBinding.id）。 */
    workspaceBindingId: varchar("workspaceBindingId", { length: 36 })
      .notNull()
      .references(() => workspaceBinding.id),
    /** 持锁 Invocation（DB 级 FK → Invocation.id）。 */
    holderInvocationId: varchar("holderInvocationId", { length: 36 })
      .notNull()
      .references(() => invocationTable.id),
    /**
     * 持锁 ThreadRelation（可选；delegate Child Thread 持锁时填）。
     * 逻辑外键 → ThreadRelation.id。
     */
    holderRelationId: varchar("holderRelationId", { length: 36 }),
    /** 锁定的路径引用（受管引用，不暴露绝对路径）。 */
    pathRef: varchar("pathRef", { length: 512 }).notNull(),
    /** 路径指纹（sha256: 前缀；UNIQUE 约束基础）。 */
    pathFingerprint: varchar("pathFingerprint", { length: 128 }).notNull(),
    lockState: mysqlEnum("lockState", WORKSPACE_WRITE_LOCK_STATES).notNull().default("acquired"),
    /** 获取时间。 */
    acquiredAt: datetime("acquiredAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    /** 过期时间（null 表示随 Invocation 生命周期释放）。 */
    expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }),
    /** 释放时间（released/expired/revoked 时填）。 */
    releasedAt: datetime("releasedAt", { mode: "date", fsp: 3 }),
    /** 释放原因码（released/expired/revoked 时填，如 turn_completed/invocation_lost/expired）。 */
    releaseReasonCode: varchar("releaseReasonCode", { length: 64 }),
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
    // 同一 WorkspaceBinding 下同一路径指纹同时只能有一个活跃锁。
    // MySQL 不支持部分唯一索引，通过应用层 SELECT FOR UPDATE + lock_state 校验保证。
    tenantBindingPathIdx: uniqueIndex("WorkspaceWriteLock_tenant_binding_path_idx").on(
      t.tenantId,
      t.workspaceBindingId,
      t.pathFingerprint,
    ),
    tenantHolderIdx: index("WorkspaceWriteLock_tenant_holder_idx").on(
      t.tenantId,
      t.holderInvocationId,
    ),
    tenantStateIdx: index("WorkspaceWriteLock_tenant_state_idx").on(t.tenantId, t.lockState),
    tenantExpiryIdx: index("WorkspaceWriteLock_tenant_expiry_idx").on(t.tenantId, t.expiresAt),
  }),
);

// ─── 类型导出 ──────────────────────────────────────────────

export type WorkspaceWriteLock = InferSelectModel<typeof workspaceWriteLock>;
export type WorkspaceWriteLockInsert = InferInsertModel<typeof workspaceWriteLock>;
