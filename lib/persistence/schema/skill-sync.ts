/**
 * 控制面 schema：SkillSyncBinding（关口02 02-4 正式化）。
 *
 * 表达 remote capability asset 与本地 Skill / SkillVersion 之间的同步绑定。
 * capability-market 同步后，本地产生一个 sourceType=capability_market 的 Skill 镜像，
 * 每次同步以该绑定记录远端版本与本地 SkillVersion 的对应关系。
 *
 * 关键约束：
 * - UNIQUE(tenantId, remoteAssetId)：租户内一个远端资产最多一条绑定。
 * - INDEX(tenantId, localSkillId)：按本地 Skill 反查绑定（unsync / 展示）。
 * - INDEX(tenantId, syncState)：按同步状态过滤。
 * - localSkillId / localSkillVersionId 引用正式 Skill / SkillVersion。
 * - 运行时（LocalDbSkillProvider）只把 syncState=active 的同步镜像纳入候选。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import { skillTable, skillVersionTable } from "@/lib/persistence/schema/skill";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { datetime, index, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

// ─── Sync State ─────────────────────────────────────────────

/**
 * 同步绑定状态。
 * - active：映射有效，本地镜像可用。
 * - blocked：远端阻止（block_sync / restriction）。
 * - not_found：远端已下线或 hide，本地镜像保留但不再更新。
 * - error：同步过程中失败（网络 / 校验 / git）。
 * - hidden：远端隐藏，本地镜像保留。
 */
export const SKILL_SYNC_STATES = ["active", "blocked", "not_found", "error", "hidden"] as const;
export type SkillSyncState = (typeof SKILL_SYNC_STATES)[number];

// ─── SkillSyncBinding ───────────────────────────────────────

export const skillSyncBindingTable = mysqlTable(
  "SkillSyncBinding",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 远端 capability asset id（capability-market asset_id）。 */
    remoteAssetId: varchar("remoteAssetId", { length: 256 }).notNull(),
    remoteName: varchar("remoteName", { length: 128 }).notNull(),
    remoteDisplayName: varchar("remoteDisplayName", { length: 256 }),
    /** 远端版本号（字符串，可比较）。 */
    remoteVersion: varchar("remoteVersion", { length: 128 }).notNull(),
    remoteVersionId: varchar("remoteVersionId", { length: 256 }),
    /** 远端 content hash（capability-market content_hash）。 */
    remoteContentHash: varchar("remoteContentHash", { length: 256 }),
    /** 本地镜像 Skill id（正式 Skill）。 */
    localSkillId: varchar("localSkillId", { length: 36 })
      .notNull()
      .references(() => skillTable.id),
    /** 本地镜像当前 SkillVersion id（正式 SkillVersion）。 */
    localSkillVersionId: varchar("localSkillVersionId", { length: 36 }).references(
      () => skillVersionTable.id,
    ),
    /** 本地镜像 skillKey（冗余存储，用于展示与冲突检查）。 */
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
    tenantRemoteAssetUq: uniqueIndex("SkillSyncBinding_tenant_remoteAssetId_uq").on(
      t.tenantId,
      t.remoteAssetId,
    ),
    tenantLocalSkillIdx: index("SkillSyncBinding_tenant_localSkill_idx").on(
      t.tenantId,
      t.localSkillId,
    ),
    tenantSyncStateIdx: index("SkillSyncBinding_tenant_syncState_idx").on(t.tenantId, t.syncState),
  }),
);

export type SkillSyncBinding = InferSelectModel<typeof skillSyncBindingTable>;
export type NewSkillSyncBinding = InferInsertModel<typeof skillSyncBindingTable>;
