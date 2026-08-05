/**
 * Workspace 并发控制 schema：workspace_write_lock / workspace_overlay /
 * workspace_merge_conflict 表（S09-C07）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/05-continuity-collaboration-and-reliability.md §13（并发 Workspace）、
 *   §17（调度与资源可靠性——Workspace 写锁）、§18（预算硬上限时副作用先核对）
 * - ../v11-agentkit-platform/10-core-data-model.md §7.1（WorkspaceBinding 不可变）
 * - ../v11-agentkit-platform-development-plan/09-collaboration-jobs-and-recovery.md S09-W08、S09-C07
 *
 * 关键不变量（§13、§17）：
 * - Desktop 同路径同时只有一个活跃写锁（UNIQUE(workspace_binding_id, path_fingerprint) WHERE lock_state=acquired）。
 * - 写锁有持锁 Invocation + 可选 ThreadRelation，过期或 Invocation lost 时自动释放。
 * - Cloud/Git 并行子任务使用 Overlay（worktree/cloud_overlay）隔离；Overlay 有独立 location_ref。
 * - 合并冲突显式回传父 Agent：禁止后完成者覆盖（§13 行 268）。
 * - 写锁/Overlay 状态变化通过 ThreadEvent 记录，不修改旧事件（§5.5）。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 */
import { randomUUID } from "node:crypto";
import { threadRelationTable } from "@/lib/persistence/schema/conversation";
import { tenant } from "@/lib/persistence/schema/identity";
import { invocationTable } from "@/lib/persistence/schema/runtime";
import { workspaceBinding } from "@/lib/persistence/schema/workspace";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  datetime,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
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

/**
 * Workspace Overlay 类型（§13 行 264-266）。
 * - git_worktree：Git worktree 隔离（同 repo 不同 worktree）。
 * - cloud_overlay：Cloud 受管 Overlay（独立 location_ref，可独立合并）。
 */
export const WORKSPACE_OVERLAY_TYPES = ["git_worktree", "cloud_overlay"] as const;
export type WorkspaceOverlayType = (typeof WORKSPACE_OVERLAY_TYPES)[number];

/**
 * Workspace Overlay 生命周期状态。
 * - active：活跃可用，子任务尚未合并。
 * - merged：已成功合并到父 WorkspaceBinding。
 * - conflict：合并冲突已报告，等待父 Agent 决策。
 * - discarded：父 Agent 决策放弃（不合并）或子任务取消。
 */
export const WORKSPACE_OVERLAY_STATES = ["active", "merged", "conflict", "discarded"] as const;
export type WorkspaceOverlayState = (typeof WORKSPACE_OVERLAY_STATES)[number];

/**
 * 合并冲突状态。
 * - reported：已报告，等待父 Agent 决策。
 * - resolved：父 Agent 显式解决（手动合并或选择一边）。
 * - abandoned：父 Agent 放弃整个 Overlay（转 discarded）。
 */
export const WORKSPACE_MERGE_CONFLICT_STATES = ["reported", "resolved", "abandoned"] as const;
export type WorkspaceMergeConflictState = (typeof WORKSPACE_MERGE_CONFLICT_STATES)[number];

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

// ─── workspace_overlay ────────────────────────────────────

export const workspaceOverlay = mysqlTable(
  "WorkspaceOverlay",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 父 WorkspaceBinding（DB 级 FK → WorkspaceBinding.id）。 */
    parentWorkspaceBindingId: varchar("parentWorkspaceBindingId", { length: 36 })
      .notNull()
      .references(() => workspaceBinding.id),
    /** 关联 ThreadRelation（DB 级 FK → ThreadRelation.id）。 */
    relationId: varchar("relationId", { length: 36 })
      .notNull()
      .references(() => threadRelationTable.id),
    overlayType: mysqlEnum("overlayType", WORKSPACE_OVERLAY_TYPES).notNull(),
    /** Overlay 独立位置引用（受管引用；worktree 路径或 cloud overlay location）。 */
    overlayLocationRef: varchar("overlayLocationRef", { length: 512 }).notNull(),
    /** Overlay 位置指纹（sha256: 前缀）。 */
    overlayFingerprint: varchar("overlayFingerprint", { length: 128 }).notNull(),
    /** 基线 revision 引用（git commit hash / cloud snapshot id）。 */
    baseRevisionRef: varchar("baseRevisionRef", { length: 256 }),
    overlayState: mysqlEnum("overlayState", WORKSPACE_OVERLAY_STATES).notNull().default("active"),
    /** 创建时父 Agent 的任务描述（用于冲突时回传父 Agent 决策）。 */
    taskDescription: text("taskDescription"),
    /** 合并完成的 revision 引用（merged 时填）。 */
    mergedRevisionRef: varchar("mergedRevisionRef", { length: 256 }),
    /** 合并/放弃时间。 */
    mergedAt: datetime("mergedAt", { mode: "date", fsp: 3 }),
    discardedAt: datetime("discardedAt", { mode: "date", fsp: 3 }),
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
    // 同一父 Binding + 同一 ThreadRelation 同时只能有一个 Overlay。
    tenantBindingRelationUq: uniqueIndex("WorkspaceOverlay_tenant_binding_relation_uq").on(
      t.tenantId,
      t.parentWorkspaceBindingId,
      t.relationId,
    ),
    tenantStateIdx: index("WorkspaceOverlay_tenant_state_idx").on(t.tenantId, t.overlayState),
    tenantRelationIdx: index("WorkspaceOverlay_tenant_relation_idx").on(t.tenantId, t.relationId),
  }),
);

// ─── workspace_merge_conflict ─────────────────────────────

export const workspaceMergeConflict = mysqlTable(
  "WorkspaceMergeConflict",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 关联 Overlay（DB 级 FK → WorkspaceOverlay.id）。 */
    overlayId: varchar("overlayId", { length: 36 })
      .notNull()
      .references(() => workspaceOverlay.id),
    /** 冲突路径引用（受管引用）。 */
    conflictPathRef: varchar("conflictPathRef", { length: 512 }).notNull(),
    /** 路径指纹（sha256: 前缀）。 */
    pathFingerprint: varchar("pathFingerprint", { length: 128 }).notNull(),
    /** 父侧（base）内容 hash（sha256: 前缀）。 */
    beforeHash: varchar("beforeHash", { length: 128 }),
    /** 我方（父侧）修改后 hash。 */
    oursHash: varchar("oursHash", { length: 128 }),
    /** 对方（子 Overlay 侧）修改后 hash。 */
    theirsHash: varchar("theirsHash", { length: 128 }),
    conflictState: mysqlEnum("conflictState", WORKSPACE_MERGE_CONFLICT_STATES)
      .notNull()
      .default("reported"),
    /** 冲突详情（structured；如 diff summary、冲突 marker 位置）。 */
    conflictDetailsJson: json("conflictDetailsJson"),
    /** 解决方案摘要（resolved 时填；如手动合并后的 hash、选择一边的标识）。 */
    resolutionSummary: text("resolutionSummary"),
    reportedAt: datetime("reportedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    resolvedAt: datetime("resolvedAt", { mode: "date", fsp: 3 }),
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
    tenantOverlayIdx: index("WorkspaceMergeConflict_tenant_overlay_idx").on(
      t.tenantId,
      t.overlayId,
    ),
    tenantStateIdx: index("WorkspaceMergeConflict_tenant_state_idx").on(
      t.tenantId,
      t.conflictState,
    ),
  }),
);

// ─── 类型导出 ──────────────────────────────────────────────

export type WorkspaceWriteLock = InferSelectModel<typeof workspaceWriteLock>;
export type WorkspaceWriteLockInsert = InferInsertModel<typeof workspaceWriteLock>;

export type WorkspaceOverlay = InferSelectModel<typeof workspaceOverlay>;
export type WorkspaceOverlayInsert = InferInsertModel<typeof workspaceOverlay>;

export type WorkspaceMergeConflict = InferSelectModel<typeof workspaceMergeConflict>;
export type WorkspaceMergeConflictInsert = InferInsertModel<typeof workspaceMergeConflict>;
