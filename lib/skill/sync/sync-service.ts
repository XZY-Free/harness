/**
 * capability-market 同步编排服务（02 文档 §五，关口02 02-4 Tenant 化）。
 *
 * 流程（02 文档 ）：
 * 1. 分页拉取 syncable Skill（listSyncableSkills）。
 * 2. 读本地全部 SkillSyncBinding,按 remoteAssetId 索引。
 * 3. 对每个远端 asset：
 * - 已有绑定 → checkUpdates 比较 hash：
 * · unchanged → 更新 lastCheckedAt,记 uptodate
 * · changed → sync + download + importArtifactZip(原 localName) → 新 SkillVersion + 切 current → 绑定 active
 * · blocked/not_found → 更新绑定 syncState（blocked/hidden/not_found）,记 blocked/not_found
 * - 无绑定 → 检查 name 冲突：
 * · 远端 name 与本地 skill.skillKey(任意 source) 或另一绑定 localName 冲突 → 记 name_conflict,不导入
 * · 不冲突 → sync + download + importArtifactZip → 建 skill(source=capability_market) + SkillVersion v1 + 切 current + 建绑定 active
 * 4. 远端不再出现的旧绑定 → 标 not_found（不删本地,不进候选）。
 * 5. hash 不变不创建新版本（checkUpdates unchanged 短路）。
 * 6. 单 asset 失败 → 记 failed + lastError,不中断整体。
 *
 * 并发：模块级 mutex,同一时刻只跑一个 runSync。
 *
 * Tenant 化：本服务只接受 tenantContext（tenantId + actorUserId），所有 DB 读写
 * 经正式 skill / skill-sync 仓储按 tenantId 隔离；禁止全局扫描（02-4 契约 §8.4）。
 *
 * 原子性说明：legacy 版用单事务包裹多步 DB 写入；正式 skill-queries 走全局 db、
 * 不暴露事务注入，故改为逐语句写入。git 已 commit 而 DB 未落时，下次同步经
 * getSkillVersionByContentRef 去重，避免同一 commit 重复建版本。
 *
 * 不做：定时任务、双向同步、自动改名、物理删除历史。
 */

import { contentHashFromGitSha } from "@/lib/capability/skill-queries";
import {
  createSkill,
  createSkillVersion,
  getSkillByKey,
  getSkillVersionByContentRef,
  publishSkillVersion,
} from "@/lib/capability/skill-queries";
import {
  createSyncBinding,
  listSyncBindings,
  updateSyncBinding,
} from "@/lib/capability/skill-sync-queries";
import { logger } from "@/lib/logger";
import { ArtifactImportError, importArtifactZip } from "@/lib/skill/sync/artifact-import";
import {
  type ArtifactDownload,
  type CapabilityListItem,
  type CheckUpdatesItem,
  type SyncItem,
  checkUpdates,
  downloadArtifact,
  listSyncableSkills,
  syncManifests,
} from "@/lib/skill/sync/capability-market-client";

/** 同步执行上下文（tenant-scoped）。 */
export interface SyncTenantContext {
  tenantId: string;
  /** 触发同步的 actor（userIdentityId 或 serviceId），写入 createSkill.ownerUserId / createSkillVersion.createdBy。 */
  actorUserId: string;
}

/** 同步结果项（用于 Studio 分组展示）。 */
export interface SyncResultItem {
  remoteAssetId: string;
  remoteName: string | null;
  localSkillId: string | null;
  localName: string | null;
  /** 远端版本号。 */
  remoteVersion: string | null;
  /** 旧 content hash（更新场景）。 */
  oldHash: string | null;
  /** 新 content hash。 */
  newHash: string | null;
  /** 本地新版本号（创建/更新时）。 */
  localVersion: number | null;
  /** 失败/冲突/阻止原因。 */
  reason: string | null;
}

/** 同步结果（按分类分组,02 文档 ）。 */
export interface SyncResult {
  /** 首次导入成功。 */
  imported: SyncResultItem[];
  /** 远端有更新,本地已生成新版本。 */
  updated: SyncResultItem[];
  /** hash 未变,无需导入。 */
  uptodate: SyncResultItem[];
  /** name 冲突,未导入（必须单独提示用户处理）。 */
  conflict: SyncResultItem[];
  /** 远端阻止（block_sync / hide / not_found）。 */
  blocked: SyncResultItem[];
  /** 同步失败（网络 / 校验 / git 等）。 */
  failed: SyncResultItem[];
  /** 旧映射对应远端已下线,本地标 not_found。 */
  missing: SyncResultItem[];
}

// 模块级 mutex：同一时刻只跑一个 runSync
let syncInProgress = false;

/**
 * 执行一次手动同步。并发时直接返回错误,不排队。
 * @param tenant 同步执行上下文（tenantId + actorUserId）
 * @throws endpoint 未配置或列表接口失败时整体失败
 */
export async function runSync(tenant: SyncTenantContext): Promise<SyncResult> {
  if (syncInProgress) {
    throw new Error("同步正在进行中,请稍后再试");
  }
  syncInProgress = true;
  try {
    return await runSyncInternal(tenant);
  } finally {
    syncInProgress = false;
  }
}

async function runSyncInternal(tenant: SyncTenantContext): Promise<SyncResult> {
  const { tenantId, actorUserId } = tenant;
  // 每次同步新建数组,避免浅拷贝共享引用导致跨调用累积
  const result: SyncResult = {
    imported: [],
    updated: [],
    uptodate: [],
    conflict: [],
    blocked: [],
    failed: [],
    missing: [],
  };

  // 1. 拉取远端可同步列表（整体失败则抛错）
  const remoteAssets = await listSyncableSkills();
  // 2. 读本地全部绑定（tenant-scoped）
  const mappings = await listSyncBindings(tenantId);
  const mappingByAsset = new Map(mappings.map((m) => [m.remoteAssetId, m]));
  const existingLocalNames = new Set(mappings.map((m) => m.localName).filter(Boolean) as string[]);

  // 3. 批量 check-updates：仅对已有绑定的资产
  const mappedAssets = remoteAssets.filter((a) => mappingByAsset.has(a.asset_id));
  const checkItems = mappedAssets
    .map((a) => {
      const m = mappingByAsset.get(a.asset_id);
      if (!m) return null;
      if (!m.remoteVersion || !m.remoteContentHash) return null;
      return { asset_id: a.asset_id, version: m.remoteVersion, content_hash: m.remoteContentHash };
    })
    .filter(Boolean) as Array<{ asset_id: string; version: string; content_hash: string }>;

  const checkMap = new Map<string, CheckUpdatesItem>();
  if (checkItems.length > 0) {
    const checked = await checkUpdates(checkItems).catch((e) => {
      // check-updates 整体失败：把已映射资产全标 failed,继续处理无映射资产
      logger.warn("[sync] check-updates 失败,已映射资产转为逐个 sync", {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    });
    if (checked) for (const c of checked) checkMap.set(c.asset_id, c);
  }

  const conflictAssetIds = new Set<string>();

  // 4. 需要拉 manifest 的资产：无绑定且无 name 冲突的 + 已绑定但 checkUpdates=changed/未知 的
  const toSync: string[] = [];
  for (const asset of remoteAssets) {
    const m = mappingByAsset.get(asset.asset_id);
    if (!m) {
      const conflictReason = await checkNameConflict(tenantId, asset.name, existingLocalNames);
      if (conflictReason) {
        conflictAssetIds.add(asset.asset_id);
        result.conflict.push({
          remoteAssetId: asset.asset_id,
          remoteName: asset.name,
          localSkillId: null,
          localName: null,
          remoteVersion: asset.resolved_version,
          oldHash: null,
          newHash: asset.resolved_content_hash,
          localVersion: null,
          reason: conflictReason,
        });
        continue;
      }
      // 批内占用 name：同一次同步里后续远端 asset 若使用相同 name,必须跳过并单独提示冲突。
      existingLocalNames.add(asset.name);
      toSync.push(asset.asset_id);
      continue;
    }
    const check = checkMap.get(asset.asset_id);
    if (!check) {
      // check-updates 失败,降级为重新 sync
      toSync.push(asset.asset_id);
      continue;
    }
    if (check.status === "unchanged") {
      // hash 不变,不导入
      await updateSyncBinding(tenantId, m.id, {
        lastCheckedAt: new Date(),
        syncState: "active",
        lastError: null,
      });
      result.uptodate.push({
        remoteAssetId: asset.asset_id,
        remoteName: asset.name,
        localSkillId: m.localSkillId,
        localName: m.localName,
        remoteVersion: m.remoteVersion,
        oldHash: m.remoteContentHash,
        newHash: m.remoteContentHash,
        localVersion: null,
        reason: null,
      });
      continue;
    }
    if (check.status === "blocked") {
      // block_sync：标 blocked,不删本地
      await updateSyncBinding(tenantId, m.id, {
        syncState: "blocked",
        lastCheckedAt: new Date(),
        lastError: check.error_code ?? "blocked",
      });
      result.blocked.push({
        remoteAssetId: asset.asset_id,
        remoteName: asset.name,
        localSkillId: m.localSkillId,
        localName: m.localName,
        remoteVersion: m.remoteVersion,
        oldHash: m.remoteContentHash,
        newHash: null,
        localVersion: null,
        reason: check.restriction_type ?? "blocked",
      });
      continue;
    }
    if (check.status === "not_found") {
      // hide 或下线 → not_found
      await updateSyncBinding(tenantId, m.id, {
        syncState: "not_found",
        lastCheckedAt: new Date(),
        lastError: check.error_code ?? "not_found",
      });
      result.blocked.push({
        remoteAssetId: asset.asset_id,
        remoteName: asset.name,
        localSkillId: m.localSkillId,
        localName: m.localName,
        remoteVersion: m.remoteVersion,
        oldHash: m.remoteContentHash,
        newHash: null,
        localVersion: null,
        reason: check.error_code ?? "not_found",
      });
      continue;
    }
    // changed → 需要 sync + 下载
    toSync.push(asset.asset_id);
  }

  // 5. 批量 sync manifests
  const syncMap = new Map<string, SyncItem>();
  if (toSync.length > 0) {
    try {
      const synced = await syncManifests(toSync);
      for (const s of synced) syncMap.set(s.asset_id, s);
    } catch (e) {
      const message = `sync manifests 失败：${e instanceof Error ? e.message : String(e)}`;
      for (const assetId of toSync) {
        const asset = remoteAssets.find((a) => a.asset_id === assetId);
        if (!asset) continue;
        const m = mappingByAsset.get(assetId);
        await markMappingError(tenantId, m, new Error(message));
        result.failed.push({
          remoteAssetId: asset.asset_id,
          remoteName: asset.name,
          localSkillId: m?.localSkillId ?? null,
          localName: m?.localName ?? null,
          remoteVersion: asset.resolved_version,
          oldHash: m?.remoteContentHash ?? null,
          newHash: asset.resolved_content_hash,
          localVersion: null,
          reason: message,
        });
      }
    }
  }

  // 6. 逐个处理：下载 artifact + 导入 + 建版本
  for (const asset of remoteAssets) {
    if (conflictAssetIds.has(asset.asset_id)) continue;
    const syncItem = syncMap.get(asset.asset_id);
    if (!syncItem) continue;
    if (syncItem.error_code) {
      // sync 单项失败
      const m = mappingByAsset.get(asset.asset_id);
      if (m) {
        await updateSyncBinding(tenantId, m.id, {
          syncState: "error",
          lastError: syncItem.error_message ?? syncItem.error_code,
        });
      }
      result.failed.push({
        remoteAssetId: asset.asset_id,
        remoteName: asset.name,
        localSkillId: m?.localSkillId ?? null,
        localName: m?.localName ?? null,
        remoteVersion: null,
        oldHash: m?.remoteContentHash ?? null,
        newHash: null,
        localVersion: null,
        reason: syncItem.error_message ?? syncItem.error_code,
      });
      continue;
    }

    const existingMapping = mappingByAsset.get(asset.asset_id);

    // 6a. 下载 artifact
    let artifact: ArtifactDownload | null;
    try {
      artifact = await downloadArtifact(asset.asset_id, syncItem.resolved_version);
    } catch (e) {
      await markMappingError(tenantId, existingMapping, e);
      result.failed.push(toFailedItem(asset, syncItem, existingMapping, e, "下载失败"));
      continue;
    }
    if (artifact === null) {
      // 404：资产/版本不存在或被 hide
      await updateMappingNotFound(tenantId, existingMapping);
      result.blocked.push(
        toFailedItem(
          asset,
          syncItem,
          existingMapping,
          new Error("artifact 不存在或被隐藏"),
          "not_found",
        ),
      );
      continue;
    }

    // 6b. 导入 zip + commit
    const localName = existingMapping?.localName ?? asset.name;
    let commitSha: string;
    try {
      commitSha = await importArtifactZip(artifact.buffer, localName);
    } catch (e) {
      if (e instanceof ArtifactImportError) {
        await markMappingError(tenantId, existingMapping, e);
        result.failed.push(toFailedItem(asset, syncItem, existingMapping, e, "导入失败"));
        continue;
      }
      throw e;
    }

    // 6c. 建/更新本地 Skill + SkillVersion + 绑定
    if (existingMapping) {
      // 更新：创建新 SkillVersion + 切 current + 更新绑定
      const localSkillId = existingMapping.localSkillId;
      const version = await createSyncVersion({
        tenantId,
        skillId: localSkillId,
        commitSha,
        actorUserId,
        localName,
      });
      if (!version) {
        await markMappingError(tenantId, existingMapping, new Error("同步绑定缺少 localSkillId"));
        result.failed.push(
          toFailedItem(
            asset,
            syncItem,
            existingMapping,
            new Error("同步绑定缺少 localSkillId"),
            "本地绑定损坏",
          ),
        );
        continue;
      }
      await updateSyncBinding(tenantId, existingMapping.id, {
        remoteName: asset.name,
        remoteDisplayName: asset.display_name,
        remoteVersion: syncItem.resolved_version,
        remoteVersionId: syncItem.version_id,
        remoteContentHash: syncItem.content_hash,
        localSkillVersionId: version.id,
        syncState: "active",
        lastSyncedAt: new Date(),
        lastCheckedAt: new Date(),
        lastError: null,
      });
      result.updated.push({
        remoteAssetId: asset.asset_id,
        remoteName: asset.name,
        localSkillId,
        localName,
        remoteVersion: syncItem.resolved_version,
        oldHash: existingMapping.remoteContentHash,
        newHash: syncItem.content_hash,
        localVersion: version.versionNo,
        reason: null,
      });
    } else {
      // 首次导入：建 Skill + SkillVersion v1 + 切 current + 建绑定
      const skill = await createSkill({
        tenantId,
        skillKey: asset.name,
        displayName: asset.display_name || asset.name,
        description: asset.description,
        ownerUserId: actorUserId,
        visibilityScope: "tenant",
        sourceType: "capability_market",
        createdBy: actorUserId,
      });
      const version = await createSkillVersion({
        tenantId,
        skillId: skill.id,
        contentRef: commitSha,
        contentHash: contentHashFromGitSha(commitSha),
        sourceType: "capability_market",
        sourceRef: asset.asset_id,
        createdBy: actorUserId,
      });
      await publishSkillVersion({
        tenantId,
        skillVersionId: version.id,
        publishedBy: actorUserId,
      });
      await createSyncBinding(tenantId, {
        remoteAssetId: asset.asset_id,
        remoteName: asset.name,
        remoteDisplayName: asset.display_name,
        remoteVersion: syncItem.resolved_version,
        remoteVersionId: syncItem.version_id,
        remoteContentHash: syncItem.content_hash,
        localSkillId: skill.id,
        localSkillVersionId: version.id,
        localName: asset.name,
        syncState: "active",
        lastSyncedAt: new Date(),
      });
      existingLocalNames.add(asset.name);
      result.imported.push({
        remoteAssetId: asset.asset_id,
        remoteName: asset.name,
        localSkillId: skill.id,
        localName: asset.name,
        remoteVersion: syncItem.resolved_version,
        oldHash: null,
        newHash: syncItem.content_hash,
        localVersion: version.versionNo,
        reason: null,
      });
    }
  }

  // 7. 远端不再出现的旧绑定 → 标 not_found
  const remoteAssetIds = new Set(remoteAssets.map((a) => a.asset_id));
  for (const m of mappings) {
    if (remoteAssetIds.has(m.remoteAssetId)) continue;
    if (m.syncState === "not_found") continue; // 已是 not_found,跳过
    await updateSyncBinding(tenantId, m.id, {
      syncState: "not_found",
      lastCheckedAt: new Date(),
      lastError: "asset 不在远端 syncable 列表",
    });
    result.missing.push({
      remoteAssetId: m.remoteAssetId,
      remoteName: m.remoteName,
      localSkillId: m.localSkillId,
      localName: m.localName,
      remoteVersion: m.remoteVersion,
      oldHash: m.remoteContentHash,
      newHash: null,
      localVersion: null,
      reason: "远端已下线",
    });
  }

  return result;
}

/**
 * 为本地 Skill 创建新版本并切为当前生效（sync 更新路径）。
 * 返回 null 表示 localSkillId 缺失。contentRef 去重：同一 commit 已存在则不重复建版本。
 */
async function createSyncVersion(params: {
  tenantId: string;
  skillId: string;
  commitSha: string;
  actorUserId: string;
  localName: string;
}): Promise<{ id: string; versionNo: number } | null> {
  if (!params.skillId) return null;
  const existing = await getSkillVersionByContentRef({
    tenantId: params.tenantId,
    skillId: params.skillId,
    contentRef: params.commitSha,
  });
  if (existing) {
    return { id: existing.id, versionNo: existing.versionNo };
  }
  const version = await createSkillVersion({
    tenantId: params.tenantId,
    skillId: params.skillId,
    contentRef: params.commitSha,
    contentHash: contentHashFromGitSha(params.commitSha),
    sourceType: "capability_market",
    createdBy: params.actorUserId,
  });
  await publishSkillVersion({
    tenantId: params.tenantId,
    skillVersionId: version.id,
    publishedBy: params.actorUserId,
  });
  return { id: version.id, versionNo: version.versionNo };
}

/**
 * name 冲突检查（02 文档 ）：
 * - 远端 name 与本地自建 skill 冲突 → 冲突
 * - 远端 name 与另一绑定 localName 冲突 → 冲突
 * 返回冲突原因字符串,无冲突返回 null。
 */
async function checkNameConflict(
  tenantId: string,
  remoteName: string,
  existingLocalNames: Set<string>,
): Promise<string | null> {
  if (existingLocalNames.has(remoteName)) {
    return `与本地已存在的 Skill「${remoteName}」冲突`;
  }
  const localSkill = await getSkillByKey({ tenantId, skillKey: remoteName });
  if (localSkill) {
    return `与本地自建 Skill「${remoteName}」冲突,需改映射名或取消同步`;
  }
  return null;
}

async function markMappingError(
  tenantId: string,
  mapping: { id: string } | undefined,
  err: unknown,
): Promise<void> {
  if (!mapping) return;
  const msg = err instanceof Error ? err.message : String(err);
  await updateSyncBinding(tenantId, mapping.id, {
    syncState: "error",
    lastCheckedAt: new Date(),
    lastError: msg,
  }).catch(() => {});
}

async function updateMappingNotFound(
  tenantId: string,
  mapping: { id: string } | undefined,
): Promise<void> {
  if (!mapping) return;
  await updateSyncBinding(tenantId, mapping.id, {
    syncState: "not_found",
    lastCheckedAt: new Date(),
    lastError: "artifact 不存在或被隐藏",
  }).catch(() => {});
}

function toFailedItem(
  asset: CapabilityListItem,
  syncItem: SyncItem,
  mapping:
    | { localSkillId: string | null; localName: string | null; remoteContentHash: string | null }
    | undefined,
  err: unknown,
  prefix: string,
): SyncResultItem {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    remoteAssetId: asset.asset_id,
    remoteName: asset.name,
    localSkillId: mapping?.localSkillId ?? null,
    localName: mapping?.localName ?? null,
    remoteVersion: syncItem.resolved_version,
    oldHash: mapping?.remoteContentHash ?? null,
    newHash: syncItem.content_hash,
    localVersion: null,
    reason: `${prefix}: ${msg}`,
  };
}
