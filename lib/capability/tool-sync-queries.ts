/**
 * ToolSyncBinding 仓储。
 *
 * 事实源：lib/persistence/schema/tool-sync.ts。
 *
 * 表达 remote capability asset（tool / mcp）与本地 Tool / ToolProvider 的同步绑定。
 * 所有查询按 tenantId 隔离；syncState 只由 tenant-scoped 的 runToolSync 更新。
 *
 * 运行时（catalog loadAuthorizedTools）只把 syncState=active 的同步 Tool 纳入候选。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  type ToolSyncAssetType,
  type ToolSyncBinding,
  type ToolSyncState,
  toolSyncBindingTable,
} from "@/lib/persistence/schema/tool-sync";
import { and, asc, eq } from "drizzle-orm";

/** 绑定不存在（或跨租户不可见）。 */
export class ToolSyncBindingNotFoundError extends Error {
  constructor(public readonly bindingId: string) {
    super(`ToolSyncBinding 不存在或跨租户不可见: ${bindingId}`);
    this.name = "ToolSyncBindingNotFoundError";
  }
}

// ─── 查询 ──────────────────────────────────────────────────

/** 列出租户内全部同步绑定（按 createdAt 升序）。 */
export async function listToolSyncBindings(tenantId: string): Promise<ToolSyncBinding[]> {
  return db
    .select()
    .from(toolSyncBindingTable)
    .where(eq(toolSyncBindingTable.tenantId, tenantId))
    .orderBy(asc(toolSyncBindingTable.createdAt));
}

/** 按远端资产 id 取绑定（租户内唯一）。 */
export async function getToolSyncBindingByRemoteAsset(params: {
  tenantId: string;
  remoteAssetId: string;
}): Promise<ToolSyncBinding | null> {
  const [row] = await db
    .select()
    .from(toolSyncBindingTable)
    .where(
      and(
        eq(toolSyncBindingTable.tenantId, params.tenantId),
        eq(toolSyncBindingTable.remoteAssetId, params.remoteAssetId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 按本地 Tool id 取绑定（unsync / Studio 展示）。一个本地 Tool 至多一条绑定。 */
export async function getToolSyncBindingByLocalTool(params: {
  tenantId: string;
  localToolId: string;
}): Promise<ToolSyncBinding | null> {
  const [row] = await db
    .select()
    .from(toolSyncBindingTable)
    .where(
      and(
        eq(toolSyncBindingTable.tenantId, params.tenantId),
        eq(toolSyncBindingTable.localToolId, params.localToolId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 列出租户内 syncState=active 的同步 localToolId（catalog 候选过滤用）。 */
export async function listActiveSyncLocalToolIds(tenantId: string): Promise<string[]> {
  const rows = await db
    .select({ localToolId: toolSyncBindingTable.localToolId })
    .from(toolSyncBindingTable)
    .where(
      and(
        eq(toolSyncBindingTable.tenantId, tenantId),
        eq(toolSyncBindingTable.syncState, "active"),
      ),
    );
  return rows.map((r) => r.localToolId);
}

// ─── 写入 ──────────────────────────────────────────────────

/** 创建同步绑定。 */
export async function createToolSyncBinding(
  tenantId: string,
  input: {
    assetType: ToolSyncAssetType;
    remoteAssetId: string;
    remoteName: string;
    remoteDisplayName?: string | null;
    remoteVersion: string;
    remoteVersionId?: string | null;
    remoteContentHash?: string | null;
    localToolId: string;
    localProviderId?: string | null;
    localName: string;
    syncState?: ToolSyncState;
    lastSyncedAt?: Date | null;
  },
): Promise<ToolSyncBinding> {
  const id = randomUUID();
  await db.insert(toolSyncBindingTable).values({
    id,
    tenantId,
    assetType: input.assetType,
    remoteAssetId: input.remoteAssetId,
    remoteName: input.remoteName,
    remoteDisplayName: input.remoteDisplayName ?? null,
    remoteVersion: input.remoteVersion,
    remoteVersionId: input.remoteVersionId ?? null,
    remoteContentHash: input.remoteContentHash ?? null,
    localToolId: input.localToolId,
    localProviderId: input.localProviderId ?? null,
    localName: input.localName,
    syncState: input.syncState ?? "active",
    lastSyncedAt: input.lastSyncedAt ?? null,
  });

  const created = await getToolSyncBindingByRemoteAsset({
    tenantId,
    remoteAssetId: input.remoteAssetId,
  });
  if (!created) {
    throw new Error(
      `createToolSyncBinding: 行未找到（tenantId=${tenantId} remoteAssetId=${input.remoteAssetId}）`,
    );
  }
  return created;
}

/** 更新同步绑定（部分字段）。 */
export async function updateToolSyncBinding(
  tenantId: string,
  bindingId: string,
  patch: {
    remoteName?: string;
    remoteDisplayName?: string | null;
    remoteVersion?: string;
    remoteVersionId?: string | null;
    remoteContentHash?: string | null;
    localProviderId?: string | null;
    localName?: string;
    syncState?: ToolSyncState;
    lastSyncedAt?: Date | null;
    lastCheckedAt?: Date | null;
    lastError?: string | null;
  },
): Promise<ToolSyncBinding> {
  await getToolSyncBindingByIdOrThrow({ tenantId, bindingId });
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.remoteName !== undefined) updates.remoteName = patch.remoteName;
  if (patch.remoteDisplayName !== undefined) updates.remoteDisplayName = patch.remoteDisplayName;
  if (patch.remoteVersion !== undefined) updates.remoteVersion = patch.remoteVersion;
  if (patch.remoteVersionId !== undefined) updates.remoteVersionId = patch.remoteVersionId;
  if (patch.remoteContentHash !== undefined) updates.remoteContentHash = patch.remoteContentHash;
  if (patch.localProviderId !== undefined) updates.localProviderId = patch.localProviderId;
  if (patch.localName !== undefined) updates.localName = patch.localName;
  if (patch.syncState !== undefined) updates.syncState = patch.syncState;
  if (patch.lastSyncedAt !== undefined) updates.lastSyncedAt = patch.lastSyncedAt;
  if (patch.lastCheckedAt !== undefined) updates.lastCheckedAt = patch.lastCheckedAt;
  if (patch.lastError !== undefined) updates.lastError = patch.lastError;

  await db
    .update(toolSyncBindingTable)
    .set(updates)
    .where(
      and(eq(toolSyncBindingTable.tenantId, tenantId), eq(toolSyncBindingTable.id, bindingId)),
    );
  return getToolSyncBindingByIdOrThrow({ tenantId, bindingId });
}

// ─── 内部工具 ──────────────────────────────────────────────

async function getToolSyncBindingByIdOrThrow(params: {
  tenantId: string;
  bindingId: string;
}): Promise<ToolSyncBinding> {
  const [row] = await db
    .select()
    .from(toolSyncBindingTable)
    .where(
      and(
        eq(toolSyncBindingTable.tenantId, params.tenantId),
        eq(toolSyncBindingTable.id, params.bindingId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ToolSyncBindingNotFoundError(params.bindingId);
  }
  return row;
}
