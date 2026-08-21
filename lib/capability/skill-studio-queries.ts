/**
 * Studio skill 聚合查询（关口02 02-4 正式化）。
 *
 * 从 legacy `lib/db/studio-queries.ts` 的 4 个 skill 查询迁移而来，改为 tenant-scoped，
 * 对齐 `lib/capability/skill-queries.ts` 风格，基于正式 skillTable / skillVersionTable / skillSyncBindingTable。
 *
 * 本模块**只读**（select）；写操作（archive / publish / rollback）复用
 * `lib/capability/skill-queries.ts` / `lib/capability/skill-sync-queries.ts` 的既有函数。
 */
import { db } from "@/lib/db/client";
import {
  type Skill,
  type SkillVersion,
  skillTable,
  skillVersionTable,
} from "@/lib/persistence/schema/skill";
import { skillSyncBindingTable } from "@/lib/persistence/schema/skill-sync";
import { type SQL, and, desc, eq, isNull, or } from "drizzle-orm";

// ─── Skills ──────────────────────────────────────────────────

/**
 * 列 skill（含 currentVersionId），按 createdAt desc。
 *
 * ownerUserId 权限隔离。
 * - 不传 filter → 全量(admin 视角,看所有 skill)。
 * - 传 filter → 返回 ownerUserId 匹配的 skill + 公共 skill(ownerUserId null)。
 * member 只能看自己 ownerUserId 的 + 公共的,不能看他人的。
 *
 * activeOnly 过滤。
 * - 不传(默认 false)→ 含 disabled(studio 管理页需看归档 skill 以管理/恢复)。
 * - activeOnly=true → 仅 enabled(chat 选择器 / skill 匹配等"可用 skill"场景)。
 *
 * @param tenantId 租户隔离
 * @param filter { ownerUserId } 限定 owner;includePublic=true 同时包含公共(ownerUserId null)
 * @param opts.activeOnly 仅返回 lifecycleState=enabled 的 skill
 */
export async function listSkills(
  tenantId: string,
  filter?: {
    ownerUserId: string;
    includePublic?: boolean;
  },
  opts?: { activeOnly?: boolean },
): Promise<Skill[]> {
  const conds: SQL[] = [eq(skillTable.tenantId, tenantId), isNull(skillTable.deletedAt)];
  if (filter) {
    const ownerCond = eq(skillTable.ownerUserId, filter.ownerUserId);
    if (filter.includePublic) {
      conds.push(or(ownerCond, isNull(skillTable.ownerUserId)) as SQL);
    } else {
      conds.push(ownerCond);
    }
  }
  if (opts?.activeOnly) {
    conds.push(eq(skillTable.lifecycleState, "enabled"));
  }
  return db
    .select()
    .from(skillTable)
    .where(and(...conds))
    .orderBy(desc(skillTable.createdAt));
}

/** 列某 skill 的全部版本，按 versionNo 降序（tenant-scoped）。 */
export async function listSkillVersions(
  tenantId: string,
  skillId: string,
): Promise<SkillVersion[]> {
  const rows = await db
    .select({ version: skillVersionTable })
    .from(skillVersionTable)
    .innerJoin(skillTable, eq(skillVersionTable.skillId, skillTable.id))
    .where(and(eq(skillTable.tenantId, tenantId), eq(skillVersionTable.skillId, skillId)))
    .orderBy(desc(skillVersionTable.versionNo));
  return rows.map((r) => r.version);
}

/**
 * Studio 列表行：Skill + 同步绑定摘要（02 文档）。
 * 同步 Skill 才有 syncState / remote 信息;本地自建 Skill 这些字段为 null。
 */
export type SkillListRow = Skill & {
  syncState: string | null;
  remoteAssetId: string | null;
  remoteVersion: string | null;
  remoteContentHash: string | null;
  lastSyncedAt: Date | null;
};

/**
 * 列 skill + 同步绑定摘要（left join,本地自建 skill 的绑定字段为 null）。
 * 用于 Studio 列表展示来源 / 同步状态 / 最近同步时间。
 */
export async function listSkillsWithSync(
  tenantId: string,
  filter?: {
    ownerUserId: string;
    includePublic?: boolean;
  },
  opts?: { activeOnly?: boolean },
): Promise<SkillListRow[]> {
  const conds: SQL[] = [eq(skillTable.tenantId, tenantId), isNull(skillTable.deletedAt)];
  if (filter) {
    const ownerCond = eq(skillTable.ownerUserId, filter.ownerUserId);
    if (filter.includePublic) {
      conds.push(or(ownerCond, isNull(skillTable.ownerUserId)) as SQL);
    } else {
      conds.push(ownerCond);
    }
  }
  if (opts?.activeOnly) {
    conds.push(eq(skillTable.lifecycleState, "enabled"));
  }
  const rows = await db
    .select({
      skill: skillTable,
      syncState: skillSyncBindingTable.syncState,
      remoteAssetId: skillSyncBindingTable.remoteAssetId,
      remoteVersion: skillSyncBindingTable.remoteVersion,
      remoteContentHash: skillSyncBindingTable.remoteContentHash,
      lastSyncedAt: skillSyncBindingTable.lastSyncedAt,
    })
    .from(skillTable)
    .leftJoin(skillSyncBindingTable, eq(skillSyncBindingTable.localSkillId, skillTable.id))
    .where(and(...conds))
    .orderBy(desc(skillTable.createdAt));
  return rows.map((r) => ({
    ...r.skill,
    syncState: r.syncState,
    remoteAssetId: r.remoteAssetId,
    remoteVersion: r.remoteVersion,
    remoteContentHash: r.remoteContentHash,
    lastSyncedAt: r.lastSyncedAt,
  }));
}

/** 取单个 skill 的同步绑定摘要（详情页展示）。无绑定返回 null。 */
export async function getSkillSyncInfo(
  tenantId: string,
  skillId: string,
): Promise<{
  syncState: string;
  remoteAssetId: string;
  remoteName: string | null;
  remoteDisplayName: string | null;
  remoteVersion: string | null;
  remoteContentHash: string | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
} | null> {
  const [row] = await db
    .select({
      syncState: skillSyncBindingTable.syncState,
      remoteAssetId: skillSyncBindingTable.remoteAssetId,
      remoteName: skillSyncBindingTable.remoteName,
      remoteDisplayName: skillSyncBindingTable.remoteDisplayName,
      remoteVersion: skillSyncBindingTable.remoteVersion,
      remoteContentHash: skillSyncBindingTable.remoteContentHash,
      lastSyncedAt: skillSyncBindingTable.lastSyncedAt,
      lastError: skillSyncBindingTable.lastError,
    })
    .from(skillSyncBindingTable)
    .where(
      and(
        eq(skillSyncBindingTable.tenantId, tenantId),
        eq(skillSyncBindingTable.localSkillId, skillId),
      ),
    )
    .limit(1);
  return row ?? null;
}
