import { db } from "@/lib/db/client";
import {
  type PolicyConfigRow,
  type Skill,
  type SkillSyncState,
  type SkillVersion,
  policyConfig,
  skill,
  skillSyncMapping,
  skillVersion,
} from "@/lib/db/schema";
import { type SQL, and, asc, desc, eq, isNull, or } from "drizzle-orm";

/**
 * ：Agent Studio 后台只读 / 聚合查询。
 *
 * 与 `lib/db/queries.ts`（单 thread CRUD + 写函数）分离：studio 是跨 thread / 跨 skill 的
 * 后台视角，索引诉求与语义不同，独立目录便于单测与后续切片复用。
 *
 * 本模块**只读**（select），写操作（archive / publish / rollback）复用 queries.ts 的既有函数，
 * 不在此重复写路径。
 */

// ─── Skills ──────────────────────────────────────────────────

/**
 * 列 skill（含 currentVersionId），按 createdAt desc。
 *
 * ownerUserId 权限隔离。
 * - 不传 filter → 全量(admin 视角,看所有 skill)。
 * - 传 filter → 返回 ownerUserId 匹配的 skill + 公共 skill(ownerUserId null)。
 * member 只能看自己 ownerUserId 的 + 公共的,不能看他人的。
 *
 * activeOnly 软删过滤。
 * - 不传(默认 false)→ 含 archived(studio 管理页需看归档 skill 以管理/恢复)。
 * - activeOnly=true → 仅 active(chat 选择器 / skill 匹配等"可用 skill"场景)。
 * skill 软删统一用 status=archived(archiveSkill),不另用 deletedAt 列(避免双轨)。
 *
 * @param filter { ownerUserId } 限定 owner;includePublic=true 同时包含公共(ownerUserId null)
 * @param opts.activeOnly 仅返回 status=active 的 skill(过滤归档软删)
 */
export async function listSkills(
  filter?: {
    ownerUserId: string;
    includePublic?: boolean;
  },
  opts?: { activeOnly?: boolean },
): Promise<Skill[]> {
  const conds: SQL[] = [];
  if (filter) {
    const ownerCond = eq(skill.ownerUserId, filter.ownerUserId);
    if (filter.includePublic) {
      conds.push(or(ownerCond, isNull(skill.ownerUserId)) as SQL);
    } else {
      conds.push(ownerCond);
    }
  }
  if (opts?.activeOnly) {
    conds.push(eq(skill.status, "active"));
  }
  return db
    .select()
    .from(skill)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(skill.createdAt));
}

/** 列某 skill 的全部版本，按 version asc。 */
export async function listSkillVersions(skillId: string): Promise<SkillVersion[]> {
  return db
    .select()
    .from(skillVersion)
    .where(eq(skillVersion.skillId, skillId))
    .orderBy(asc(skillVersion.version));
}

/**
 * Studio 列表行：Skill + 同步映射摘要（02 文档 ）。
 * 同步 Skill 才有 syncState / remote 信息;本地自建 Skill 这些字段为 null。
 */
export type SkillListRow = Skill & {
  syncState: SkillSyncState | null;
  remoteAssetId: string | null;
  remoteVersion: string | null;
  remoteContentHash: string | null;
  lastSyncedAt: Date | null;
};

/**
 * 列 skill + 同步映射摘要（left join,本地自建 skill 的映射字段为 null）。
 * 用于 Studio 列表展示来源 / 同步状态 / 最近同步时间。
 */
export async function listSkillsWithSync(
  filter?: {
    ownerUserId: string;
    includePublic?: boolean;
  },
  opts?: { activeOnly?: boolean },
): Promise<SkillListRow[]> {
  const conds: SQL[] = [];
  if (filter) {
    const ownerCond = eq(skill.ownerUserId, filter.ownerUserId);
    if (filter.includePublic) {
      conds.push(or(ownerCond, isNull(skill.ownerUserId)) as SQL);
    } else {
      conds.push(ownerCond);
    }
  }
  if (opts?.activeOnly) {
    conds.push(eq(skill.status, "active"));
  }
  const rows = await db
    .select({
      skill,
      syncState: skillSyncMapping.syncState,
      remoteAssetId: skillSyncMapping.remoteAssetId,
      remoteVersion: skillSyncMapping.remoteVersion,
      remoteContentHash: skillSyncMapping.remoteContentHash,
      lastSyncedAt: skillSyncMapping.lastSyncedAt,
    })
    .from(skill)
    .leftJoin(skillSyncMapping, eq(skillSyncMapping.localSkillId, skill.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(skill.createdAt));
  return rows.map((r) => ({
    ...r.skill,
    syncState: r.syncState,
    remoteAssetId: r.remoteAssetId,
    remoteVersion: r.remoteVersion,
    remoteContentHash: r.remoteContentHash,
    lastSyncedAt: r.lastSyncedAt,
  }));
}

/** 取单个 skill 的同步映射摘要（详情页展示）。无映射返回 null。 */
export async function getSkillSyncInfo(skillId: string): Promise<{
  syncState: SkillSyncState;
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
      syncState: skillSyncMapping.syncState,
      remoteAssetId: skillSyncMapping.remoteAssetId,
      remoteName: skillSyncMapping.remoteName,
      remoteDisplayName: skillSyncMapping.remoteDisplayName,
      remoteVersion: skillSyncMapping.remoteVersion,
      remoteContentHash: skillSyncMapping.remoteContentHash,
      lastSyncedAt: skillSyncMapping.lastSyncedAt,
      lastError: skillSyncMapping.lastError,
    })
    .from(skillSyncMapping)
    .where(eq(skillSyncMapping.localSkillId, skillId))
    .limit(1);
  return row ?? null;
}

// ─── Policy（Stage E，只读展示） ─────────────────────────────

/** 列 PolicyConfig 全部行（key → JSON value），按 key 升序。 */
export async function getPolicyConfigRows(): Promise<PolicyConfigRow[]> {
  return db.select().from(policyConfig).orderBy(asc(policyConfig.key));
}
