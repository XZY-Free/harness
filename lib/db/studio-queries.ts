import { db } from "@/lib/db/client";
import {
  type PolicyConfigRow,
  type Skill,
  type SkillSyncState,
  type SkillVersion,
  type Thread,
  type ThreadEvent,
  type ToolRun,
  policyConfig,
  skill,
  skillSyncMapping,
  skillVersion,
  thread,
  threadEvent,
  toolRun,
  user,
} from "@/lib/db/schema";
import { type SQL, and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";

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

// ─── Threads（Stage D） ──────────────────────────────────────

/**
 * thread 列表行：Thread 全字段 + 可读名（供后台表格显示，避免裸 ID）。
 * - `ownerName`/`ownerEmail`：thread.userId → user.{name,email}。
 */
export type ThreadListRow = Thread & {
  ownerName: string | null;
  ownerEmail: string | null;
};

/**
 * thread leftJoin user 的公共 select / from 构造。
 * user.name 与 skill.name 同名——drizzle 按列引用生成 SQL（表名限定 + AS 重命名），
 * select 键名（ownerName）即结果集字段名，无冲突。
 */
function threadListQuery() {
  return db
    .select({
      id: thread.id,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      title: thread.title,
      userId: thread.userId,
      status: thread.status,
      model: thread.model,
      previewUrl: thread.previewUrl,
      activeSkillId: thread.activeSkillId,
      activeSkillVersionId: thread.activeSkillVersionId,
      reviewState: thread.reviewState,
      runtimeType: thread.runtimeType,
      projectId: thread.projectId,
      pinnedAt: thread.pinnedAt,
      pinnedFacts: thread.pinnedFacts,
      deletedAt: thread.deletedAt,
      lastMessagePreview: thread.lastMessagePreview,
      lastMessageId: thread.lastMessageId,
      // S1：补齐 token 字段（ThreadListRow = Thread & {...} 要求，V4 加列后 select 漏选）
      promptTokens: thread.promptTokens,
      completionTokens: thread.completionTokens,
      totalTokens: thread.totalTokens,
      // per-thread CI/CD token（同上，select 漏选补齐）
      cicdApiToken: thread.cicdApiToken,
      ownerName: user.name,
      ownerEmail: user.email,
    })
    .from(thread)
    .leftJoin(user, eq(thread.userId, user.id));
}

/** 列某用户的 thread（member 视角），B-8: 按 updatedAt desc。P2-1: 过滤已软删。 */
export async function listThreadsForUser(userId: string): Promise<ThreadListRow[]> {
  return threadListQuery()
    .where(and(eq(thread.userId, userId), isNull(thread.deletedAt)))
    .orderBy(desc(thread.updatedAt), desc(thread.id));
}

/** 列全部 thread（admin 视角，thread.read.all），B-8: 按 updatedAt desc。P2-1: 过滤已软删。 */
export async function listAllThreads(): Promise<ThreadListRow[]> {
  return threadListQuery()
    .where(isNull(thread.deletedAt))
    .orderBy(desc(thread.updatedAt), desc(thread.id));
}

/** 列某 thread 的 tool run，按 startedAt asc（tool trace 用）。 */
export async function listToolRunsForThread(threadId: string): Promise<ToolRun[]> {
  return db
    .select()
    .from(toolRun)
    .where(eq(toolRun.threadId, threadId))
    .orderBy(asc(toolRun.startedAt));
}

/** 列某 thread 的全部事件（时间线用），按 sequence asc。 */
export async function listEventsForThread(threadId: string): Promise<ThreadEvent[]> {
  return db
    .select()
    .from(threadEvent)
    .where(eq(threadEvent.threadId, threadId))
    .orderBy(asc(threadEvent.sequence))
    .limit(500);
}

/**
 * 列某 thread 的 artifact 事件投影：`artifact.created` / `artifact.updated`，
 * 按 sequence asc。同时按 threadId 限定（不泄露其他 thread 的 artifact）。
 */
export async function listArtifactsForThread(threadId: string): Promise<ThreadEvent[]> {
  return db
    .select()
    .from(threadEvent)
    .where(
      and(
        eq(threadEvent.threadId, threadId),
        inArray(threadEvent.type, ["artifact.created", "artifact.updated"]),
      ),
    )
    .orderBy(asc(threadEvent.sequence));
}

/** artifact 事件类型集合（跨 thread 聚合用）。 */
const ARTIFACT_EVENT_TYPES = ["artifact.created", "artifact.updated"] as const;

/**
 * artifact 列表行：ThreadEvent 全字段 + 所属 thread 的 title（供 UI 显示，避免裸 threadId）。
 * thread 已删档 → threadTitle=null（leftJoin，admin 全表路径下 thread 可能不存在）。
 */
export type ArtifactListRow = ThreadEvent & { threadTitle: string | null };

/**
 * 跨 thread 聚合某用户可见的最近 artifact 事件（，owner-scoped）。
 *
 * - `canAll=true`（admin，thread.read.all）：全表 threadEvent where type in artifact.*，
 * 按 createdAt desc 取 limit。
 * - `canAll=false`（member）：**DB join/filter** 按 `thread.userId` 限定——
 * threadEvent innerJoin thread on threadId=thread.id，where thread.userId=userId and type in artifact.*。
 * 不预取 listThreadsForUser 再 inArray(threadIds)（避免大量 threadIds 下应用层搬运与 SQL 参数膨胀）。
 *
 * 两条路径都带出 `thread.title`（UI 显示会话名）。无匹配 → []。
 */
export async function listRecentArtifactsForUser(
  userId: string,
  canAll: boolean,
  limit: number,
): Promise<ArtifactListRow[]> {
  const types = [...ARTIFACT_EVENT_TYPES];
  if (canAll) {
    const rows = await db
      .select({
        id: threadEvent.id,
        threadId: threadEvent.threadId,
        sequence: threadEvent.sequence,
        type: threadEvent.type,
        runId: threadEvent.runId,
        payload: threadEvent.payload,
        createdAt: threadEvent.createdAt,
        threadTitle: thread.title,
      })
      .from(threadEvent)
      .leftJoin(thread, eq(threadEvent.threadId, thread.id))
      .where(inArray(threadEvent.type, types))
      .orderBy(desc(threadEvent.createdAt))
      .limit(limit);
    return rows;
  }
  const rows = await db
    .select({
      id: threadEvent.id,
      threadId: threadEvent.threadId,
      sequence: threadEvent.sequence,
      type: threadEvent.type,
      runId: threadEvent.runId,
      payload: threadEvent.payload,
      createdAt: threadEvent.createdAt,
      threadTitle: thread.title,
    })
    .from(threadEvent)
    .innerJoin(thread, eq(threadEvent.threadId, thread.id))
    .where(and(eq(thread.userId, userId), inArray(threadEvent.type, types)))
    .orderBy(desc(threadEvent.createdAt))
    .limit(limit);
  return rows;
}

// ─── Policy（Stage E，只读展示） ─────────────────────────────

/** 列 PolicyConfig 全部行（key → JSON value），按 key 升序。 */
export async function getPolicyConfigRows(): Promise<PolicyConfigRow[]> {
  return db.select().from(policyConfig).orderBy(asc(policyConfig.key));
}
