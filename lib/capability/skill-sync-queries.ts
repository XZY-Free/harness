/**
 * SkillSyncBinding 仓储（关口02 02-4 正式化）。
 *
 * 事实源：lib/persistence/schema/skill-sync.ts。
 *
 * 表达 remote capability asset 与本地 Skill / SkillVersion 的同步绑定。
 * 所有查询按 tenantId 隔离；syncState 只由 tenant-scoped 的 runSync 更新。
 *
 * 运行时（LocalDbSkillProvider）只把 syncState=active 的同步镜像纳入候选。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  type SkillSyncBinding,
  type SkillSyncState,
  skillSyncBindingTable,
} from "@/lib/persistence/schema/skill-sync";
import { and, asc, eq } from "drizzle-orm";

/** 绑定不存在（或跨租户不可见）。 */
export class SkillSyncBindingNotFoundError extends Error {
  constructor(public readonly bindingId: string) {
    super(`SkillSyncBinding 不存在或跨租户不可见: ${bindingId}`);
    this.name = "SkillSyncBindingNotFoundError";
  }
}

// ─── 查询 ──────────────────────────────────────────────────

/** 列出租户内全部同步绑定（按 createdAt 升序）。 */
export async function listSyncBindings(tenantId: string): Promise<SkillSyncBinding[]> {
  return db
    .select()
    .from(skillSyncBindingTable)
    .where(eq(skillSyncBindingTable.tenantId, tenantId))
    .orderBy(asc(skillSyncBindingTable.createdAt));
}

/** 按远端资产 id 取绑定（租户内唯一）。 */
export async function getSyncBindingByRemoteAsset(params: {
  tenantId: string;
  remoteAssetId: string;
}): Promise<SkillSyncBinding | null> {
  const [row] = await db
    .select()
    .from(skillSyncBindingTable)
    .where(
      and(
        eq(skillSyncBindingTable.tenantId, params.tenantId),
        eq(skillSyncBindingTable.remoteAssetId, params.remoteAssetId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 按本地 Skill id 取绑定（unsync / Studio 展示）。一个本地镜像至多一条绑定。 */
export async function getSyncBindingByLocalSkill(params: {
  tenantId: string;
  localSkillId: string;
}): Promise<SkillSyncBinding | null> {
  const [row] = await db
    .select()
    .from(skillSyncBindingTable)
    .where(
      and(
        eq(skillSyncBindingTable.tenantId, params.tenantId),
        eq(skillSyncBindingTable.localSkillId, params.localSkillId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 列出租户内 syncState=active 的同步镜像 localSkillId（Provider 候选过滤用）。 */
export async function listActiveSyncLocalSkillIds(tenantId: string): Promise<string[]> {
  const rows = await db
    .select({ localSkillId: skillSyncBindingTable.localSkillId })
    .from(skillSyncBindingTable)
    .where(
      and(
        eq(skillSyncBindingTable.tenantId, tenantId),
        eq(skillSyncBindingTable.syncState, "active"),
      ),
    );
  return rows.map((r) => r.localSkillId);
}

// ─── 写入 ──────────────────────────────────────────────────

/** 创建同步绑定。 */
export async function createSyncBinding(
  tenantId: string,
  input: {
    remoteAssetId: string;
    remoteName: string;
    remoteDisplayName?: string | null;
    remoteVersion: string;
    remoteVersionId?: string | null;
    remoteContentHash?: string | null;
    localSkillId: string;
    localSkillVersionId?: string | null;
    localName: string;
    syncState?: SkillSyncState;
    lastSyncedAt?: Date | null;
  },
): Promise<SkillSyncBinding> {
  const id = randomUUID();
  await db.insert(skillSyncBindingTable).values({
    id,
    tenantId,
    remoteAssetId: input.remoteAssetId,
    remoteName: input.remoteName,
    remoteDisplayName: input.remoteDisplayName ?? null,
    remoteVersion: input.remoteVersion,
    remoteVersionId: input.remoteVersionId ?? null,
    remoteContentHash: input.remoteContentHash ?? null,
    localSkillId: input.localSkillId,
    localSkillVersionId: input.localSkillVersionId ?? null,
    localName: input.localName,
    syncState: input.syncState ?? "active",
    lastSyncedAt: input.lastSyncedAt ?? null,
  });

  const created = await getSyncBindingByRemoteAsset({
    tenantId,
    remoteAssetId: input.remoteAssetId,
  });
  if (!created) {
    throw new Error(
      `createSyncBinding: 行未找到（tenantId=${tenantId} remoteAssetId=${input.remoteAssetId}）`,
    );
  }
  return created;
}

/** 更新同步绑定（部分字段）。 */
export async function updateSyncBinding(
  tenantId: string,
  bindingId: string,
  patch: {
    remoteName?: string;
    remoteDisplayName?: string | null;
    remoteVersion?: string;
    remoteVersionId?: string | null;
    remoteContentHash?: string | null;
    localSkillVersionId?: string | null;
    localName?: string;
    syncState?: SkillSyncState;
    lastSyncedAt?: Date | null;
    lastCheckedAt?: Date | null;
    lastError?: string | null;
  },
): Promise<SkillSyncBinding> {
  const existing = await getSyncBindingByIdOrThrow({ tenantId, bindingId });
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.remoteName !== undefined) updates.remoteName = patch.remoteName;
  if (patch.remoteDisplayName !== undefined) updates.remoteDisplayName = patch.remoteDisplayName;
  if (patch.remoteVersion !== undefined) updates.remoteVersion = patch.remoteVersion;
  if (patch.remoteVersionId !== undefined) updates.remoteVersionId = patch.remoteVersionId;
  if (patch.remoteContentHash !== undefined) updates.remoteContentHash = patch.remoteContentHash;
  if (patch.localSkillVersionId !== undefined)
    updates.localSkillVersionId = patch.localSkillVersionId;
  if (patch.localName !== undefined) updates.localName = patch.localName;
  if (patch.syncState !== undefined) updates.syncState = patch.syncState;
  if (patch.lastSyncedAt !== undefined) updates.lastSyncedAt = patch.lastSyncedAt;
  if (patch.lastCheckedAt !== undefined) updates.lastCheckedAt = patch.lastCheckedAt;
  if (patch.lastError !== undefined) updates.lastError = patch.lastError;

  const result = await db
    .update(skillSyncBindingTable)
    .set(updates)
    .where(
      and(eq(skillSyncBindingTable.tenantId, tenantId), eq(skillSyncBindingTable.id, bindingId)),
    );
  if (result[0].affectedRows === 0) {
    throw new SkillSyncBindingNotFoundError(bindingId);
  }
  return getSyncBindingByIdOrThrow({ tenantId, bindingId });
}

// ─── 内部工具 ──────────────────────────────────────────────

async function getSyncBindingByIdOrThrow(params: {
  tenantId: string;
  bindingId: string;
}): Promise<SkillSyncBinding> {
  const [row] = await db
    .select()
    .from(skillSyncBindingTable)
    .where(
      and(
        eq(skillSyncBindingTable.tenantId, params.tenantId),
        eq(skillSyncBindingTable.id, params.bindingId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new SkillSyncBindingNotFoundError(params.bindingId);
  }
  return row;
}
