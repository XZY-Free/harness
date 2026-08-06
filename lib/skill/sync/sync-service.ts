/**
 * capability-market 同步编排服务（02 文档 §五）。
 *
 * 流程（02 文档 ）：
 * 1. 分页拉取 syncable Skill（listSyncableSkills）。
 * 2. 读本地全部 SkillSyncMapping,按 remoteAssetId 索引。
 * 3. 对每个远端 asset：
 * - 已有映射 → checkUpdates 比较 hash：
 * · unchanged → 更新 lastCheckedAt,记 uptodate
 * · changed → sync + download + importArtifactZip(原 localName) → 新 SkillVersion + 切 current → 映射 active
 * · blocked/not_found → 更新映射 syncState（blocked/hidden/not_found）,记 blocked/not_found
 * - 无映射 → 检查 name 冲突：
 * · 远端 name 与本地 skill.name(任意 source) 或另一映射 localName 冲突 → 记 name_conflict,不导入
 * · 不冲突 → sync + download + importArtifactZip → 建 skill(source=capability-market) + SkillVersion v1 + 切 current + 建映射 active
 * 4. 远端不再出现的旧映射 → 标 not_found（不删本地,不进候选）。
 * 5. hash 不变不创建新版本（checkUpdates unchanged 短路）。
 * 6. 单 asset 失败 → 记 failed + lastError,不中断整体。
 *
 * 并发：模块级 mutex,同一时刻只跑一个 runSync。
 *
 * 不做：定时任务、双向同步、自动改名、物理删除历史。
 */

import { db } from "@/lib/db/client";
import {
 createSkill,
 createSkillVersion,
 createSyncMapping,
 getMaxSkillVersionNumber,
 getSkillByName,
 listAllSyncMappings,
 setCurrentVersion,
 updateSyncMapping,
} from "@/lib/db/queries";
import { logger } from "@/lib/logger";
import { ArtifactImportError, importArtifactZip } from "@/lib/skill/sync/artifact-import";
import {
 type CapabilityListItem,
 type CheckUpdatesItem,
 type SyncItem,
 checkUpdates,
 downloadArtifact,
 listSyncableSkills,
 syncManifests,
} from "@/lib/skill/sync/capability-market-client";

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
 * @throws endpoint 未配置或列表接口失败时整体失败
 */
export async function runSync(): Promise<SyncResult> {
 if (syncInProgress) {
 throw new Error("同步正在进行中,请稍后再试");
 }
 syncInProgress = true;
 try {
 return await runSyncInternal();
 } finally {
 syncInProgress = false;
 }
}

async function runSyncInternal(): Promise<SyncResult> {
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
 // 2. 读本地全部映射
 const mappings = await listAllSyncMappings();
 const mappingByAsset = new Map(mappings.map((m) => [m.remoteAssetId, m]));
 const existingLocalNames = new Set(mappings.map((m) => m.localName).filter(Boolean) as string[]);

 // 用于 name 冲突检查：本地所有 skill name（含 local 与已同步）
 // 一次性查询会 N 次,这里按需在冲突检查时 getSkillByName

 // 3. 批量 check-updates：仅对已有映射的资产
 const mappedAssets = remoteAssets.filter((a) => mappingByAsset.has(a.asset_id));
 const checkItems = mappedAssets
 .map((a) => {
 const m = mappingByAsset.get(a.asset_id)!;
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

 // 4. 需要拉 manifest 的资产：无映射且无 name 冲突的 + 已映射但 checkUpdates=changed/未知 的
 const toSync: string[] = [];
 for (const asset of remoteAssets) {
 const m = mappingByAsset.get(asset.asset_id);
 if (!m) {
 const conflictReason = await checkNameConflict(asset.name, existingLocalNames);
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
 await updateSyncMapping(m.id, {
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
 await updateSyncMapping(m.id, {
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
 await updateSyncMapping(m.id, {
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
 await markMappingError(m, new Error(message));
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
 if (!syncMap.has(asset.asset_id)) continue;
 const syncItem = syncMap.get(asset.asset_id)!;
 if (syncItem.error_code) {
 // sync 单项失败
 const m = mappingByAsset.get(asset.asset_id);
 if (m) {
 await updateSyncMapping(m.id, {
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
 let artifact;
 try {
 artifact = await downloadArtifact(asset.asset_id, syncItem.resolved_version);
 } catch (e) {
 await markMappingError(existingMapping, e);
 result.failed.push(toFailedItem(asset, syncItem, existingMapping, e, "下载失败"));
 continue;
 }
 if (artifact === null) {
 // 404：资产/版本不存在或被 hide
 await updateMappingNotFound(existingMapping);
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
 await markMappingError(existingMapping, e);
 result.failed.push(toFailedItem(asset, syncItem, existingMapping, e, "导入失败"));
 continue;
 }
 throw e;
 }

 // 6c. 建/更新本地 Skill + SkillVersion + 映射
 if (existingMapping) {
 // 更新：创建新 SkillVersion + 切 current + 更新映射
 const localSkillId = existingMapping.localSkillId!;
 const versionNum = await nextLocalVersionNumber(localSkillId);
 // 三步 DB 写入包进单事务,防中途失败致 git 已 commit 但 DB 无版本/映射仍指旧版
 const version = await db.transaction(async (tx) => {
 const v = await createSkillVersion(
 { skillId: localSkillId, version: versionNum, commitSha, status: "active" },
 tx,
 );
 await setCurrentVersion(localSkillId, v.id, undefined, tx);
 await updateSyncMapping(
 existingMapping.id,
 {
 remoteName: asset.name,
 remoteDisplayName: asset.display_name,
 remoteVersion: syncItem.resolved_version,
 remoteVersionId: syncItem.version_id,
 remoteContentHash: syncItem.content_hash,
 localSkillVersionId: v.id,
 syncState: "active",
 lastSyncedAt: new Date(),
 lastCheckedAt: new Date(),
 lastError: null,
 },
 tx,
 );
 return v;
 });
 result.updated.push({
 remoteAssetId: asset.asset_id,
 remoteName: asset.name,
 localSkillId,
 localName,
 remoteVersion: syncItem.resolved_version,
 oldHash: existingMapping.remoteContentHash,
 newHash: syncItem.content_hash,
 localVersion: versionNum,
 reason: null,
 });
 } else {
 // 首次导入：建 Skill + SkillVersion v1 + 切 current + 建映射
 // 四步 DB 写入包进单事务
 const { sk, version } = await db.transaction(async (tx) => {
 const s = await createSkill(
 {
 name: asset.name,
 description: asset.description,
 category: asset.category,
 visibility: "public",
 source: "capability-market",
 },
 tx,
 );
 const v = await createSkillVersion(
 { skillId: s.id, version: 1, commitSha, status: "active" },
 tx,
 );
 await setCurrentVersion(s.id, v.id, undefined, tx);
 await createSyncMapping(
 {
 remoteAssetId: asset.asset_id,
 remoteName: asset.name,
 remoteDisplayName: asset.display_name,
 remoteVersion: syncItem.resolved_version,
 remoteVersionId: syncItem.version_id,
 remoteContentHash: syncItem.content_hash,
 localSkillId: s.id,
 localSkillVersionId: v.id,
 localName: asset.name,
 syncState: "active",
 },
 tx,
 );
 return { sk: s, version: v };
 });
 existingLocalNames.add(asset.name);
 result.imported.push({
 remoteAssetId: asset.asset_id,
 remoteName: asset.name,
 localSkillId: sk.id,
 localName: asset.name,
 remoteVersion: syncItem.resolved_version,
 oldHash: null,
 newHash: syncItem.content_hash,
 localVersion: 1,
 reason: null,
 });
 }
 }

 // 7. 远端不再出现的旧映射 → 标 not_found
 const remoteAssetIds = new Set(remoteAssets.map((a) => a.asset_id));
 for (const m of mappings) {
 if (remoteAssetIds.has(m.remoteAssetId)) continue;
 if (m.syncState === "not_found") continue; // 已是 not_found,跳过
 await updateSyncMapping(m.id, {
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
 * name 冲突检查（02 文档 ）：
 * - 远端 name 与本地自建 skill 冲突 → 冲突
 * - 远端 name 与另一映射 localName 冲突 → 冲突
 * 返回冲突原因字符串,无冲突返回 null。
 */
async function checkNameConflict(
 remoteName: string,
 existingLocalNames: Set<string>,
): Promise<string | null> {
 if (existingLocalNames.has(remoteName)) {
 return `与本地已存在的 Skill「${remoteName}」冲突`;
 }
 const localSkill = await getSkillByName(remoteName);
 if (localSkill) {
 return `与本地自建 Skill「${remoteName}」冲突,需改映射名或取消同步`;
 }
 return null;
}

/** 取本地 skill 下一个版本号（当前最大 +1）。 */
async function nextLocalVersionNumber(skillId: string): Promise<number> {
 return (await getMaxSkillVersionNumber(skillId)) + 1;
}

async function markMappingError(mapping: { id: string } | undefined, err: unknown): Promise<void> {
 if (!mapping) return;
 const msg = err instanceof Error ? err.message : String(err);
 await updateSyncMapping(mapping.id, {
 syncState: "error",
 lastCheckedAt: new Date(),
 lastError: msg,
 }).catch(() => {});
}

async function updateMappingNotFound(mapping: { id: string } | undefined): Promise<void> {
 if (!mapping) return;
 await updateSyncMapping(mapping.id, {
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
