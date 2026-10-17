/**
 * 控制面 schema：ToolSyncBinding。
 *
 * 表达 remote capability asset（tool / mcp）与本地 Tool / ToolProvider /
 * ToolSchemaRevision 之间的同步绑定。capability-market 同步后，本地产生
 * 相应 Tool 定义行；每次同步以该绑定记录远端版本与本地 Tool 的对应关系。
 *
 * 与 SkillSyncBinding 的区别：
 * - 覆盖两类远端资产（assetType=tool / mcp），故显式存 assetType。
 * - 本地锚点是 Tool（toolId），而非 Skill。
 * - 不含远端 endpoint / 凭证：MCP 调用走 capm 代理（平台 token），
 *   本地不持有远端连接凭证（2026-10-17 定）。
 *
 * 关键约束：
 * - UNIQUE(tenantId, remoteAssetId)：租户内一个远端资产最多一条绑定。
 * - INDEX(tenantId, localToolId)：按本地 Tool 反查绑定（unsync / 展示）。
 * - INDEX(tenantId, syncState)：按同步状态过滤。
 * - 运行时（catalog loadAuthorizedTools）只把 syncState=active 的同步 Tool 纳入候选。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import { toolProviderTable, toolTable } from "@/lib/persistence/schema/tool";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { datetime, index, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

// ─── Asset Type ─────────────────────────────────────────────

/** 可同步的工具类资产类型。 */
export const TOOL_SYNC_ASSET_TYPES = ["tool", "mcp"] as const;
export type ToolSyncAssetType = (typeof TOOL_SYNC_ASSET_TYPES)[number];

// ─── Sync State ─────────────────────────────────────────────

/**
 * 同步绑定状态（与 SkillSyncState 同语义）。
 * - active：映射有效，本地 Tool 可用。
 * - blocked：远端阻止（block_sync / restriction）。
 * - not_found：远端已下线或 hide，本地 Tool 保留但不再更新。
 * - error：同步过程中失败（网络 / 校验）。
 * - hidden：远端隐藏，本地 Tool 保留。
 */
export const TOOL_SYNC_STATES = ["active", "blocked", "not_found", "error", "hidden"] as const;
export type ToolSyncState = (typeof TOOL_SYNC_STATES)[number];

// ─── ToolSyncBinding ────────────────────────────────────────

export const toolSyncBindingTable = mysqlTable(
  "ToolSyncBinding",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 远端资产类型（tool / mcp）。 */
    assetType: varchar("assetType", { length: 16 }).notNull(),
    /** 远端 capability asset id。 */
    remoteAssetId: varchar("remoteAssetId", { length: 256 }).notNull(),
    remoteName: varchar("remoteName", { length: 128 }).notNull(),
    remoteDisplayName: varchar("remoteDisplayName", { length: 256 }),
    /** 远端版本号（字符串，可比较）。 */
    remoteVersion: varchar("remoteVersion", { length: 128 }).notNull(),
    remoteVersionId: varchar("remoteVersionId", { length: 256 }),
    /** 远端 content hash（capability-market content_hash）。 */
    remoteContentHash: varchar("remoteContentHash", { length: 256 }),
    /** 本地 Tool id（正式 Tool 表）。 */
    localToolId: varchar("localToolId", { length: 36 })
      .notNull()
      .references(() => toolTable.id),
    /** 本地 ToolProvider id（正式 ToolProvider 表）。 */
    localProviderId: varchar("localProviderId", { length: 36 }).references(
      () => toolProviderTable.id,
    ),
    /** 本地 toolKey（冗余存储，用于展示与冲突检查）。 */
    localName: varchar("localName", { length: 128 }).notNull(),
    syncState: varchar("syncState", { length: 32 }).notNull().default("active"),
    lastSyncedAt: datetime("lastSyncedAt", { mode: "date", fsp: 3 }),
    lastCheckedAt: datetime("lastCheckedAt", { mode: "date", fsp: 3 }),
    lastError: text("lastError"),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantRemoteAssetUq: uniqueIndex("ToolSyncBinding_tenant_remoteAssetId_uq").on(
      t.tenantId,
      t.remoteAssetId,
    ),
    tenantLocalToolIdx: index("ToolSyncBinding_tenant_localTool_idx").on(t.tenantId, t.localToolId),
    tenantSyncStateIdx: index("ToolSyncBinding_tenant_syncState_idx").on(t.tenantId, t.syncState),
  }),
);

export type ToolSyncBinding = InferSelectModel<typeof toolSyncBindingTable>;
export type NewToolSyncBinding = InferInsertModel<typeof toolSyncBindingTable>;
