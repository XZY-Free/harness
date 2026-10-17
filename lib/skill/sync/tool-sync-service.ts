/**
 * Tool / MCP 同步编排（市场定义落地）。
 *
 * 与 skill 同步（runSync）平行的入口：skill 需下载 zip + 内容快照缓存；
 * tool / mcp 的落地形态是**本地 DB 定义行**（Provider + Tool + SchemaRevision），
 * 无需 artifact 缓存（执行归 capm）。两者共享 capm 列表/绑定/冲突处理模式。
 *
 * 流程（每类资产各自一轮）：
 *   1. 拉 capm 可同步列表（listSyncableAssets(type)）；
 *   2. 检查已有绑定；无变更跳过（check-updates 语义用 content_hash 比对）；
 *   3. syncManifests 取 detail（tool_detail / mcp_detail）；
 *   4. 落本地定义（importMarketAsset，满足 catalog 三道门）；
 *   5. upsert ToolSyncBinding（锚点 = localProviderId）。
 */
import {
  createToolSyncBinding,
  getToolSyncBindingByRemoteAsset,
  listToolSyncBindings,
  updateToolSyncBinding,
} from "@/lib/capability/tool-sync-queries";
import { logger } from "@/lib/logger";
import type {
  CapabilityListItem,
  CheckUpdatesItem,
  SyncItem,
} from "@/lib/skill/sync/capability-market-client";
import {
  checkUpdates,
  listSyncableAssets,
  syncManifests,
} from "@/lib/skill/sync/capability-market-client";
import {
  ToolSyncImportError,
  ensureCapmConnection,
  importMarketAsset,
} from "@/lib/skill/sync/market-asset-import";

export interface ToolSyncTenantContext {
  tenantId: string;
  actorUserId: string;
}

export interface ToolSyncResultItem {
  remoteAssetId: string;
  remoteName: string;
  assetType: "tool" | "mcp";
  localProviderId: string | null;
  localName: string | null;
  remoteVersion: string | null;
  reason: string | null;
}

export interface ToolSyncResult {
  imported: ToolSyncResultItem[];
  updated: ToolSyncResultItem[];
  uptodate: ToolSyncResultItem[];
  conflict: ToolSyncResultItem[];
  blocked: ToolSyncResultItem[];
  failed: ToolSyncResultItem[];
}

let toolSyncInProgress = false;

/**
 * 执行一次 tool / mcp 手动同步（两个类型各跑一轮）。
 * 并发时直接抛错，不排队（与 runSync 一致）。
 */
export async function runToolSync(tenant: ToolSyncTenantContext): Promise<ToolSyncResult> {
  if (toolSyncInProgress) {
    throw new Error("工具同步正在进行中，请稍后再试");
  }
  toolSyncInProgress = true;
  try {
    const result: ToolSyncResult = {
      imported: [],
      updated: [],
      uptodate: [],
      conflict: [],
      blocked: [],
      failed: [],
    };
    // capm 专用 Connection（endpointRef = capm base），一次同步内复用
    const connectionId = await ensureCapmConnection({
      tenantId: tenant.tenantId,
      actorUserId: tenant.actorUserId,
      existingConnectionId: null,
    });
    for (const assetType of ["tool", "mcp"] as const) {
      await syncOneType(tenant, assetType, connectionId, result);
    }
    return result;
  } finally {
    toolSyncInProgress = false;
  }
}

async function syncOneType(
  tenant: ToolSyncTenantContext,
  assetType: "tool" | "mcp",
  connectionId: string | null,
  result: ToolSyncResult,
): Promise<void> {
  const { tenantId, actorUserId } = tenant;
  let remoteAssets: CapabilityListItem[];
  try {
    remoteAssets = await listSyncableAssets(assetType);
  } catch (e) {
    logger.warn(`[tool-sync] 拉取 ${assetType} 列表失败`, {
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  if (remoteAssets.length === 0) return;

  const bindings = (await listToolSyncBindings(tenantId)).filter((b) => b.assetType === assetType);
  const byAsset = new Map(bindings.map((b) => [b.remoteAssetId, b]));

  // check-updates：仅对已有绑定
  const mapped = remoteAssets.filter((a) => byAsset.has(a.asset_id));
  const checkItems = mapped
    .map((a) => {
      const b = byAsset.get(a.asset_id);
      if (!b?.remoteVersion || !b.remoteContentHash) return null;
      return { asset_id: a.asset_id, version: b.remoteVersion, content_hash: b.remoteContentHash };
    })
    .filter(Boolean) as Array<{ asset_id: string; version: string; content_hash: string }>;
  const checkMap = new Map<string, CheckUpdatesItem>();
  if (checkItems.length > 0) {
    const checked = await checkUpdates(checkItems).catch(() => null);
    if (checked) for (const c of checked) checkMap.set(c.asset_id, c);
  }

  // 决定需 sync 的资产
  const toSync: string[] = [];
  for (const asset of remoteAssets) {
    const b = byAsset.get(asset.asset_id);
    if (!b) {
      toSync.push(asset.asset_id);
      continue;
    }
    const check = checkMap.get(asset.asset_id);
    if (check && check.status === "unchanged") {
      await updateToolSyncBinding(tenantId, b.id, {
        lastCheckedAt: new Date(),
        syncState: "active",
        lastError: null,
      });
      result.uptodate.push(toItem(asset, assetType, b, null));
      continue;
    }
    if (check && check.status === "not_found") {
      await updateToolSyncBinding(tenantId, b.id, {
        syncState: "not_found",
        lastCheckedAt: new Date(),
        lastError: check.error_code ?? "not_found",
      });
      result.blocked.push(toItem(asset, assetType, b, check.error_code ?? "not_found"));
      continue;
    }
    if (check && check.status === "blocked") {
      await updateToolSyncBinding(tenantId, b.id, {
        syncState: "blocked",
        lastCheckedAt: new Date(),
        lastError: check.error_code ?? "blocked",
      });
      result.blocked.push(toItem(asset, assetType, b, check.restriction_type ?? "blocked"));
      continue;
    }
    toSync.push(asset.asset_id);
  }
  if (toSync.length === 0) return;

  // syncManifests 取 detail
  let synced: SyncItem[];
  try {
    synced = await syncManifests(toSync);
  } catch (e) {
    const message = `sync manifests 失败：${e instanceof Error ? e.message : String(e)}`;
    for (const assetId of toSync) {
      const asset = remoteAssets.find((a) => a.asset_id === assetId);
      if (!asset) continue;
      const b = byAsset.get(assetId);
      if (b)
        await updateToolSyncBinding(tenantId, b.id, { syncState: "error", lastError: message });
      result.failed.push(toItem(asset, assetType, b ?? null, message));
    }
    return;
  }

  for (const item of synced) {
    const asset = remoteAssets.find((a) => a.asset_id === item.asset_id);
    if (!asset) continue;
    const b = byAsset.get(item.asset_id);
    if (item.error_code) {
      if (b) {
        await updateToolSyncBinding(tenantId, b.id, {
          syncState: "error",
          lastError: item.error_message ?? item.error_code,
        });
      }
      result.failed.push(
        toItem(asset, assetType, b ?? null, item.error_message ?? item.error_code),
      );
      continue;
    }
    try {
      const imported = await importMarketAsset({
        tenantId,
        actorUserId,
        item,
        connectionId,
        isUpdate: Boolean(b),
      });
      if (b) {
        await updateToolSyncBinding(tenantId, b.id, {
          remoteName: item.asset_name,
          remoteVersion: item.resolved_version,
          remoteVersionId: item.version_id,
          remoteContentHash: item.content_hash,
          localToolId: imported.toolId,
          localName: imported.toolKey,
          syncState: "active",
          lastSyncedAt: new Date(),
          lastCheckedAt: new Date(),
          lastError: null,
        });
        result.updated.push({
          remoteAssetId: item.asset_id,
          remoteName: item.asset_name,
          assetType,
          localProviderId: imported.providerId,
          localName: imported.toolKey,
          remoteVersion: item.resolved_version,
          reason: null,
        });
      } else {
        await createToolSyncBinding(tenantId, {
          assetType,
          remoteAssetId: item.asset_id,
          remoteName: item.asset_name,
          remoteDisplayName: asset.display_name,
          remoteVersion: item.resolved_version,
          remoteVersionId: item.version_id,
          remoteContentHash: item.content_hash,
          localProviderId: imported.providerId,
          localToolId: imported.toolId,
          localName: imported.toolKey,
          lastSyncedAt: new Date(),
        });
        result.imported.push({
          remoteAssetId: item.asset_id,
          remoteName: item.asset_name,
          assetType,
          localProviderId: imported.providerId,
          localName: imported.toolKey,
          remoteVersion: item.resolved_version,
          reason: null,
        });
      }
    } catch (e) {
      const message =
        e instanceof ToolSyncImportError
          ? e.message
          : `导入失败：${e instanceof Error ? e.message : String(e)}`;
      if (b)
        await updateToolSyncBinding(tenantId, b.id, { syncState: "error", lastError: message });
      result.failed.push(toItem(asset, assetType, b ?? null, message));
    }
  }
}

function toItem(
  asset: CapabilityListItem,
  assetType: "tool" | "mcp",
  binding: { localProviderId: string; localName: string } | null,
  reason: string | null,
): ToolSyncResultItem {
  return {
    remoteAssetId: asset.asset_id,
    remoteName: asset.name,
    assetType,
    localProviderId: binding?.localProviderId ?? null,
    localName: binding?.localName ?? null,
    remoteVersion: asset.resolved_version,
    reason,
  };
}
