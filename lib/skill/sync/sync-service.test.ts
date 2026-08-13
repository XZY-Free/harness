import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * sync-service 测试（02 文档 §5）。
 * mock capability-market-client + db queries + artifact-import,验证编排逻辑：
 * - 首次导入：建 skill(source=capability-market) + v1 + 映射 active
 * - hash 不变：uptodate,不创建版本
 * - 远端更新：建新 SkillVersion + 切 current + 映射 active
 * - name 冲突：跳过,记 conflict
 * - 远端下线（不在 syncable 列表）：旧映射标 not_found
 * - checkUpdates=blocked：映射标 blocked
 */

// ─── mock db queries ────────────────────────────────────────
const dbMocks = vi.hoisted(() => ({
  listAllSyncMappings: vi.fn(),
  getSyncMappingByRemoteAsset: vi.fn(),
  getSkillByName: vi.fn(),
  getCurrentSkillVersion: vi.fn(),
  getMaxSkillVersionNumber: vi.fn(),
  createSkill: vi.fn(),
  createSkillVersion: vi.fn(),
  createSyncMapping: vi.fn(),
  updateSyncMapping: vi.fn(),
  setCurrentVersion: vi.fn(),
}));
vi.mock("@/lib/db/queries", () => dbMocks);
// P1-7: sync-service 现用 db.transaction 包三步写入;mock client 提供空 tx
vi.mock("@/lib/db/client", () => ({
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// ─── mock client ────────────────────────────────────────────
const clientMocks = vi.hoisted(() => ({
  listSyncableSkills: vi.fn(),
  checkUpdates: vi.fn(),
  syncManifests: vi.fn(),
  downloadArtifact: vi.fn(),
}));
vi.mock("@/lib/skill/sync/capability-market-client", () => clientMocks);

// ─── mock artifact-import（不真写磁盘）────────────────────
const importMock = vi.hoisted(() => ({ importArtifactZip: vi.fn() }));
vi.mock("@/lib/skill/sync/artifact-import", () => ({
  ArtifactImportError: class extends Error {},
  importArtifactZip: importMock.importArtifactZip,
}));

import { runSync } from "@/lib/skill/sync/sync-service";

function makeRemoteAsset(
  overrides: Partial<{
    asset_id: string;
    name: string;
    display_name: string | null;
    description: string | null;
    category: string | null;
  }> = {},
) {
  return {
    asset_id: "asset-1",
    asset_type: "skill",
    name: "deploy-review",
    display_name: "部署审查",
    description: "审查部署",
    category: "deploy",
    latest_version: "1.0.0",
    resolved_version: "1.0.0",
    resolved_version_id: "rv-1",
    resolved_content_hash: "hash-1",
    access_state: "allowed" as const,
    restriction_type: null,
    rule_id: null,
    tags: null,
    ...overrides,
  };
}

function makeSyncItem(assetId: string, hash: string, version = "1.0.0") {
  return {
    asset_id: assetId,
    asset_type: "skill",
    asset_name: assetId,
    resolved_version: version,
    version_id: `v-${assetId}`,
    content_hash: hash,
    version_state: "published",
    risk_level: null,
    package_size: 100,
    etag: "e",
    artifact_download_path: `/api/capabilities/${assetId}/versions/${version}/artifact`,
    skill_detail: {
      entry_file: "SKILL.md",
      runtime_requirements: null,
      permission_policy: null,
      tags: null,
    },
    tool_detail: null,
    rule_id: null,
    restriction_type: null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  dbMocks.listAllSyncMappings.mockResolvedValue([]);
  dbMocks.getSkillByName.mockResolvedValue(null);
  dbMocks.getCurrentSkillVersion.mockResolvedValue(null);
  dbMocks.getMaxSkillVersionNumber.mockResolvedValue(0);
  dbMocks.createSkill.mockImplementation(async (p: { name: string; source?: string }) => ({
    id: `skill-${p.name}`,
    name: p.name,
    source: p.source ?? "local",
  }));
  dbMocks.createSkillVersion.mockImplementation(
    async (p: { skillId: string; version: number; commitSha: string }) => ({
      id: `ver-${p.skillId}-${p.version}`,
      skillId: p.skillId,
      version: p.version,
      commitSha: p.commitSha,
    }),
  );
  dbMocks.updateSyncMapping.mockResolvedValue(undefined);
  dbMocks.createSyncMapping.mockResolvedValue(undefined);
  dbMocks.setCurrentVersion.mockResolvedValue(undefined);
  importMock.importArtifactZip.mockResolvedValue("commit-sha");
});

describe("runSync", () => {
  it("首次导入：建 skill(source=capability-market) + v1 + 映射 active", async () => {
    clientMocks.listSyncableSkills.mockResolvedValue([makeRemoteAsset()]);
    // 无映射 → 不调 checkUpdates；调 syncManifests
    clientMocks.syncManifests.mockResolvedValue([makeSyncItem("asset-1", "hash-1")]);
    clientMocks.downloadArtifact.mockResolvedValue({
      buffer: Buffer.from([]),
      contentHash: "hash-1",
      etag: "e",
    });

    const result = await runSync();

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.remoteAssetId).toBe("asset-1");
    expect(dbMocks.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "deploy-review", source: "capability-market" }),
      expect.anything(),
    );
    expect(dbMocks.createSkillVersion).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1, commitSha: "commit-sha" }),
      expect.anything(),
    );
    expect(dbMocks.setCurrentVersion).toHaveBeenCalledWith(
      "skill-deploy-review",
      "ver-skill-deploy-review-1",
      undefined,
      expect.anything(),
    );
    expect(dbMocks.createSyncMapping).toHaveBeenCalledWith(
      expect.objectContaining({ remoteAssetId: "asset-1", syncState: "active" }),
      expect.anything(),
    );
  });

  it("hash 不变（checkUpdates=unchanged）→ uptodate,不下载不导入", async () => {
    const mapping = {
      id: "m1",
      remoteAssetId: "asset-1",
      localSkillId: "skill-1",
      localName: "deploy-review",
      remoteVersion: "1.0.0",
      remoteContentHash: "hash-1",
      syncState: "active",
    };
    dbMocks.listAllSyncMappings.mockResolvedValue([mapping]);
    clientMocks.listSyncableSkills.mockResolvedValue([makeRemoteAsset()]);
    clientMocks.checkUpdates.mockResolvedValue([
      {
        asset_id: "asset-1",
        status: "unchanged",
        latest_version: "1.0.0",
        latest_content_hash: "hash-1",
        rule_id: null,
        restriction_type: null,
        error_code: null,
        requested_version: "1.0.0",
        requested_content_hash: "hash-1",
      },
    ]);

    const result = await runSync();

    expect(result.uptodate).toHaveLength(1);
    expect(clientMocks.syncManifests).not.toHaveBeenCalled();
    expect(clientMocks.downloadArtifact).not.toHaveBeenCalled();
    expect(dbMocks.createSkillVersion).not.toHaveBeenCalled();
    expect(dbMocks.updateSyncMapping).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ syncState: "active" }),
    );
  });

  it("远端更新（checkUpdates=changed）→ 建新 SkillVersion + 切 current", async () => {
    const mapping = {
      id: "m1",
      remoteAssetId: "asset-1",
      localSkillId: "skill-1",
      localName: "deploy-review",
      remoteVersion: "1.0.0",
      remoteContentHash: "hash-old",
      syncState: "active",
    };
    dbMocks.listAllSyncMappings.mockResolvedValue([mapping]);
    dbMocks.getMaxSkillVersionNumber.mockResolvedValue(1);
    clientMocks.listSyncableSkills.mockResolvedValue([makeRemoteAsset()]);
    clientMocks.checkUpdates.mockResolvedValue([
      {
        asset_id: "asset-1",
        status: "changed",
        latest_version: "2.0.0",
        latest_content_hash: "hash-new",
        rule_id: null,
        restriction_type: null,
        error_code: null,
        requested_version: "1.0.0",
        requested_content_hash: "hash-old",
      },
    ]);
    clientMocks.syncManifests.mockResolvedValue([makeSyncItem("asset-1", "hash-new", "2.0.0")]);
    clientMocks.downloadArtifact.mockResolvedValue({
      buffer: Buffer.from([]),
      contentHash: "hash-new",
      etag: "e",
    });

    const result = await runSync();

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]?.oldHash).toBe("hash-old");
    expect(result.updated[0]?.newHash).toBe("hash-new");
    expect(result.updated[0]?.localVersion).toBe(2);
    expect(dbMocks.createSkillVersion).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: "skill-1", version: 2 }),
      expect.anything(),
    );
    expect(dbMocks.setCurrentVersion).toHaveBeenCalledWith(
      "skill-1",
      "ver-skill-1-2",
      undefined,
      expect.anything(),
    );
    expect(dbMocks.updateSyncMapping).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ syncState: "active", remoteContentHash: "hash-new" }),
      expect.anything(),
    );
  });

  it("远端更新按历史最大版本号递增,不依赖 currentVersionId", async () => {
    const mapping = {
      id: "m1",
      remoteAssetId: "asset-1",
      localSkillId: "skill-1",
      localName: "deploy-review",
      remoteVersion: "1.0.0",
      remoteContentHash: "hash-old",
      syncState: "active",
    };
    dbMocks.listAllSyncMappings.mockResolvedValue([mapping]);
    dbMocks.getCurrentSkillVersion.mockResolvedValue({ id: "ver-old", version: 1 });
    dbMocks.getMaxSkillVersionNumber.mockResolvedValue(5);
    clientMocks.listSyncableSkills.mockResolvedValue([makeRemoteAsset()]);
    clientMocks.checkUpdates.mockResolvedValue([
      {
        asset_id: "asset-1",
        status: "changed",
        latest_version: "2.0.0",
        latest_content_hash: "hash-new",
        rule_id: null,
        restriction_type: null,
        error_code: null,
        requested_version: "1.0.0",
        requested_content_hash: "hash-old",
      },
    ]);
    clientMocks.syncManifests.mockResolvedValue([makeSyncItem("asset-1", "hash-new", "2.0.0")]);
    clientMocks.downloadArtifact.mockResolvedValue({
      buffer: Buffer.from([]),
      contentHash: "hash-new",
      etag: "e",
    });

    const result = await runSync();

    expect(result.updated[0]?.localVersion).toBe(6);
    expect(dbMocks.createSkillVersion).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: "skill-1", version: 6 }),
      expect.anything(),
    );
  });

  it("name 冲突（远端 name 与本地自建 skill 冲突）→ 跳过,记 conflict,不请求 manifest", async () => {
    clientMocks.listSyncableSkills.mockResolvedValue([makeRemoteAsset({ name: "deploy-review" })]);
    dbMocks.getSkillByName.mockResolvedValue({
      id: "local-deploy",
      name: "deploy-review",
      source: "local",
    });

    const result = await runSync();

    expect(result.conflict).toHaveLength(1);
    expect(result.conflict[0]?.remoteName).toBe("deploy-review");
    expect(result.conflict[0]?.reason).toContain("冲突");
    expect(clientMocks.syncManifests).not.toHaveBeenCalled();
    expect(clientMocks.downloadArtifact).not.toHaveBeenCalled();
    expect(dbMocks.createSkill).not.toHaveBeenCalled();
  });

  it("同一批远端新 asset 的 name 冲突 → 只导入第一项,第二项单独记 conflict", async () => {
    clientMocks.listSyncableSkills.mockResolvedValue([
      makeRemoteAsset({ asset_id: "asset-1", name: "deploy-review" }),
      makeRemoteAsset({ asset_id: "asset-2", name: "deploy-review" }),
    ]);
    clientMocks.syncManifests.mockResolvedValue([makeSyncItem("asset-1", "hash-1")]);
    clientMocks.downloadArtifact.mockResolvedValue({
      buffer: Buffer.from([]),
      contentHash: "hash-1",
      etag: "e",
    });

    const result = await runSync();

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.remoteAssetId).toBe("asset-1");
    expect(result.conflict).toHaveLength(1);
    expect(result.conflict[0]?.remoteAssetId).toBe("asset-2");
    expect(clientMocks.syncManifests).toHaveBeenCalledWith(["asset-1"]);
    expect(dbMocks.createSkill).toHaveBeenCalledTimes(1);
  });

  it("远端下线（旧映射对应 asset 不在 syncable 列表）→ 映射标 not_found", async () => {
    const mapping = {
      id: "m1",
      remoteAssetId: "asset-gone",
      localSkillId: "skill-gone",
      localName: "gone",
      remoteVersion: "1.0.0",
      remoteContentHash: "h",
      syncState: "active",
    };
    dbMocks.listAllSyncMappings.mockResolvedValue([mapping]);
    clientMocks.listSyncableSkills.mockResolvedValue([]);

    const result = await runSync();

    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]?.remoteAssetId).toBe("asset-gone");
    expect(dbMocks.updateSyncMapping).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ syncState: "not_found" }),
    );
  });

  it("checkUpdates=blocked → 映射标 blocked,不下载", async () => {
    const mapping = {
      id: "m1",
      remoteAssetId: "asset-1",
      localSkillId: "skill-1",
      localName: "deploy-review",
      remoteVersion: "1.0.0",
      remoteContentHash: "hash-1",
      syncState: "active",
    };
    dbMocks.listAllSyncMappings.mockResolvedValue([mapping]);
    clientMocks.listSyncableSkills.mockResolvedValue([makeRemoteAsset()]);
    clientMocks.checkUpdates.mockResolvedValue([
      {
        asset_id: "asset-1",
        status: "blocked",
        latest_version: null,
        latest_content_hash: null,
        rule_id: "r1",
        restriction_type: "block_sync",
        error_code: "DENIED_BLOCK_SYNC",
        requested_version: "1.0.0",
        requested_content_hash: "hash-1",
      },
    ]);

    const result = await runSync();

    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.reason).toBe("block_sync");
    expect(dbMocks.updateSyncMapping).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ syncState: "blocked" }),
    );
    expect(clientMocks.downloadArtifact).not.toHaveBeenCalled();
  });

  it("artifact 下载 404 → 映射标 not_found,记 blocked", async () => {
    const mapping = {
      id: "m1",
      remoteAssetId: "asset-1",
      localSkillId: "skill-1",
      localName: "deploy-review",
      remoteVersion: "1.0.0",
      remoteContentHash: "hash-old",
      syncState: "active",
    };
    dbMocks.listAllSyncMappings.mockResolvedValue([mapping]);
    clientMocks.listSyncableSkills.mockResolvedValue([makeRemoteAsset()]);
    clientMocks.checkUpdates.mockResolvedValue([
      {
        asset_id: "asset-1",
        status: "changed",
        latest_version: "2.0.0",
        latest_content_hash: "hash-new",
        rule_id: null,
        restriction_type: null,
        error_code: null,
        requested_version: "1.0.0",
        requested_content_hash: "hash-old",
      },
    ]);
    clientMocks.syncManifests.mockResolvedValue([makeSyncItem("asset-1", "hash-new", "2.0.0")]);
    clientMocks.downloadArtifact.mockResolvedValue(null);

    const result = await runSync();

    expect(result.blocked).toHaveLength(1);
    expect(dbMocks.updateSyncMapping).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ syncState: "not_found" }),
    );
  });

  it("sync manifests 批量失败 → 逐项记 failed,不中断整次同步", async () => {
    const mapping = {
      id: "m1",
      remoteAssetId: "asset-1",
      localSkillId: "skill-1",
      localName: "deploy-review",
      remoteVersion: "1.0.0",
      remoteContentHash: "hash-old",
      syncState: "active",
    };
    dbMocks.listAllSyncMappings.mockResolvedValue([mapping]);
    clientMocks.listSyncableSkills.mockResolvedValue([makeRemoteAsset()]);
    clientMocks.checkUpdates.mockResolvedValue([
      {
        asset_id: "asset-1",
        status: "changed",
        latest_version: "2.0.0",
        latest_content_hash: "hash-new",
        rule_id: null,
        restriction_type: null,
        error_code: null,
        requested_version: "1.0.0",
        requested_content_hash: "hash-old",
      },
    ]);
    clientMocks.syncManifests.mockRejectedValue(new Error("market down"));

    const result = await runSync();

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.remoteAssetId).toBe("asset-1");
    expect(result.failed[0]?.reason).toContain("sync manifests 失败");
    expect(dbMocks.updateSyncMapping).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ syncState: "error" }),
    );
    expect(clientMocks.downloadArtifact).not.toHaveBeenCalled();
  });
});
