import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * sync-service 测试（02 文档 §5，关口02 02-4 Tenant 化）。
 *
 * mock 正式 skill-queries + skill-sync-queries + capability-market-client + artifact-import，
 * 验证编排逻辑（tenant-scoped，runSync({tenantId, actorUserId})）：
 * - 首次导入：建 skill(sourceType=capability_market) + v1 + publish + 绑定 active
 * - hash 不变：uptodate,不创建版本
 * - 远端更新：建新 SkillVersion + publish + 绑定 active
 * - contentRef 去重：同 commit 已存在则不重复建版本
 * - name 冲突：跳过,记 conflict
 * - 远端下线（不在 syncable 列表）：旧绑定标 not_found
 * - checkUpdates=blocked：绑定标 blocked
 */

const TENANT = "tenant-1";
const ACTOR = "user-1";

// ─── mock 正式 skill-queries（保留 contentHashFromGitSha 真实实现）────────
const skillQryMocks = vi.hoisted(() => ({
  createSkill: vi.fn(),
  createSkillVersion: vi.fn(),
  getSkillByKey: vi.fn(),
  getSkillVersionByContentRef: vi.fn(),
  publishSkillVersion: vi.fn(),
}));
vi.mock("@/lib/capability/skill-queries", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    createSkill: skillQryMocks.createSkill,
    createSkillVersion: skillQryMocks.createSkillVersion,
    getSkillByKey: skillQryMocks.getSkillByKey,
    getSkillVersionByContentRef: skillQryMocks.getSkillVersionByContentRef,
    publishSkillVersion: skillQryMocks.publishSkillVersion,
  };
});

// ─── mock 正式 skill-sync-queries ───────────────────────────
const skillSyncMocks = vi.hoisted(() => ({
  createSyncBinding: vi.fn(),
  listSyncBindings: vi.fn(),
  updateSyncBinding: vi.fn(),
}));
vi.mock("@/lib/capability/skill-sync-queries", () => skillSyncMocks);

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

function makeBinding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "m1",
    remoteAssetId: "asset-1",
    remoteName: "deploy-review",
    localSkillId: "skill-1",
    localName: "deploy-review",
    remoteVersion: "1.0.0",
    remoteContentHash: "hash-1",
    syncState: "active",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  skillQryMocks.createSkill.mockImplementation(async (p: { skillKey: string }) => ({
    id: `skill-${p.skillKey}`,
  }));
  skillQryMocks.createSkillVersion.mockResolvedValue({ id: "ver-1", versionNo: 1 });
  skillQryMocks.getSkillByKey.mockResolvedValue(null);
  skillQryMocks.getSkillVersionByContentRef.mockResolvedValue(null);
  skillQryMocks.publishSkillVersion.mockResolvedValue(undefined);
  skillSyncMocks.listSyncBindings.mockResolvedValue([]);
  skillSyncMocks.createSyncBinding.mockResolvedValue(undefined);
  skillSyncMocks.updateSyncBinding.mockResolvedValue(undefined);
  importMock.importArtifactZip.mockResolvedValue("commit-sha");
});

describe("runSync", () => {
  it("首次导入：建 skill(sourceType=capability_market) + v1 + publish + 绑定 active", async () => {
    clientMocks.listSyncableSkills.mockResolvedValue([makeRemoteAsset()]);
    // 无绑定 → 不调 checkUpdates；调 syncManifests
    clientMocks.syncManifests.mockResolvedValue([makeSyncItem("asset-1", "hash-1")]);
    clientMocks.downloadArtifact.mockResolvedValue({
      buffer: Buffer.from([]),
      contentHash: "hash-1",
      etag: "e",
    });

    const result = await runSync({ tenantId: TENANT, actorUserId: ACTOR });

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.remoteAssetId).toBe("asset-1");
    expect(skillQryMocks.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        skillKey: "deploy-review",
        sourceType: "capability_market",
        ownerUserId: ACTOR,
      }),
    );
    expect(skillQryMocks.createSkillVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: "skill-deploy-review",
        contentRef: "commit-sha",
        contentHash: expect.stringMatching(/^sha256:/),
      }),
    );
    expect(skillQryMocks.publishSkillVersion).toHaveBeenCalled();
    expect(skillSyncMocks.createSyncBinding).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ remoteAssetId: "asset-1", syncState: "active" }),
    );
  });

  it("hash 不变（checkUpdates=unchanged）→ uptodate,不下载不导入", async () => {
    skillSyncMocks.listSyncBindings.mockResolvedValue([makeBinding()]);
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

    const result = await runSync({ tenantId: TENANT, actorUserId: ACTOR });

    expect(result.uptodate).toHaveLength(1);
    expect(clientMocks.syncManifests).not.toHaveBeenCalled();
    expect(clientMocks.downloadArtifact).not.toHaveBeenCalled();
    expect(skillQryMocks.createSkillVersion).not.toHaveBeenCalled();
    expect(skillSyncMocks.updateSyncBinding).toHaveBeenCalledWith(
      TENANT,
      "m1",
      expect.objectContaining({ syncState: "active" }),
    );
  });

  it("远端更新（checkUpdates=changed）→ 建新 SkillVersion + publish + 绑定 active", async () => {
    skillSyncMocks.listSyncBindings.mockResolvedValue([
      makeBinding({ remoteContentHash: "hash-old" }),
    ]);
    skillQryMocks.createSkillVersion.mockResolvedValue({ id: "ver-2", versionNo: 2 });
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

    const result = await runSync({ tenantId: TENANT, actorUserId: ACTOR });

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]?.oldHash).toBe("hash-old");
    expect(result.updated[0]?.newHash).toBe("hash-new");
    expect(result.updated[0]?.localVersion).toBe(2);
    expect(skillQryMocks.createSkillVersion).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: "skill-1" }),
    );
    expect(skillQryMocks.publishSkillVersion).toHaveBeenCalled();
    expect(skillSyncMocks.updateSyncBinding).toHaveBeenCalledWith(
      TENANT,
      "m1",
      expect.objectContaining({ syncState: "active", remoteContentHash: "hash-new" }),
    );
  });

  it("contentRef 去重：同 commit 已存在版本则复用,不重复建版本", async () => {
    skillSyncMocks.listSyncBindings.mockResolvedValue([
      makeBinding({ remoteContentHash: "hash-old" }),
    ]);
    skillQryMocks.getSkillVersionByContentRef.mockResolvedValue({
      id: "ver-existing",
      versionNo: 3,
    } as never);
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

    const result = await runSync({ tenantId: TENANT, actorUserId: ACTOR });

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]?.localVersion).toBe(3);
    expect(skillQryMocks.createSkillVersion).not.toHaveBeenCalled();
    expect(skillQryMocks.publishSkillVersion).not.toHaveBeenCalled();
  });

  it("name 冲突（远端 name 与本地自建 skill 冲突）→ 跳过,记 conflict,不请求 manifest", async () => {
    clientMocks.listSyncableSkills.mockResolvedValue([makeRemoteAsset({ name: "deploy-review" })]);
    skillQryMocks.getSkillByKey.mockResolvedValue({ id: "local-deploy" } as never);

    const result = await runSync({ tenantId: TENANT, actorUserId: ACTOR });

    expect(result.conflict).toHaveLength(1);
    expect(result.conflict[0]?.remoteName).toBe("deploy-review");
    expect(result.conflict[0]?.reason).toContain("冲突");
    expect(clientMocks.syncManifests).not.toHaveBeenCalled();
    expect(clientMocks.downloadArtifact).not.toHaveBeenCalled();
    expect(skillQryMocks.createSkill).not.toHaveBeenCalled();
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

    const result = await runSync({ tenantId: TENANT, actorUserId: ACTOR });

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.remoteAssetId).toBe("asset-1");
    expect(result.conflict).toHaveLength(1);
    expect(result.conflict[0]?.remoteAssetId).toBe("asset-2");
    expect(clientMocks.syncManifests).toHaveBeenCalledWith(["asset-1"]);
    expect(skillQryMocks.createSkill).toHaveBeenCalledTimes(1);
  });

  it("远端下线（旧绑定对应 asset 不在 syncable 列表）→ 绑定标 not_found", async () => {
    skillSyncMocks.listSyncBindings.mockResolvedValue([
      makeBinding({ remoteAssetId: "asset-gone", localSkillId: "skill-gone", localName: "gone" }),
    ]);
    clientMocks.listSyncableSkills.mockResolvedValue([]);

    const result = await runSync({ tenantId: TENANT, actorUserId: ACTOR });

    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]?.remoteAssetId).toBe("asset-gone");
    expect(skillSyncMocks.updateSyncBinding).toHaveBeenCalledWith(
      TENANT,
      "m1",
      expect.objectContaining({ syncState: "not_found" }),
    );
  });

  it("checkUpdates=blocked → 绑定标 blocked,不下载", async () => {
    skillSyncMocks.listSyncBindings.mockResolvedValue([makeBinding()]);
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

    const result = await runSync({ tenantId: TENANT, actorUserId: ACTOR });

    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.reason).toBe("block_sync");
    expect(skillSyncMocks.updateSyncBinding).toHaveBeenCalledWith(
      TENANT,
      "m1",
      expect.objectContaining({ syncState: "blocked" }),
    );
    expect(clientMocks.downloadArtifact).not.toHaveBeenCalled();
  });

  it("artifact 下载 404 → 绑定标 not_found,记 blocked", async () => {
    skillSyncMocks.listSyncBindings.mockResolvedValue([
      makeBinding({ remoteContentHash: "hash-old" }),
    ]);
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

    const result = await runSync({ tenantId: TENANT, actorUserId: ACTOR });

    expect(result.blocked).toHaveLength(1);
    expect(skillSyncMocks.updateSyncBinding).toHaveBeenCalledWith(
      TENANT,
      "m1",
      expect.objectContaining({ syncState: "not_found" }),
    );
  });

  it("sync manifests 批量失败 → 逐项记 failed,不中断整次同步", async () => {
    skillSyncMocks.listSyncBindings.mockResolvedValue([
      makeBinding({ remoteContentHash: "hash-old" }),
    ]);
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

    const result = await runSync({ tenantId: TENANT, actorUserId: ACTOR });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.remoteAssetId).toBe("asset-1");
    expect(result.failed[0]?.reason).toContain("sync manifests 失败");
    expect(skillSyncMocks.updateSyncBinding).toHaveBeenCalledWith(
      TENANT,
      "m1",
      expect.objectContaining({ syncState: "error" }),
    );
    expect(clientMocks.downloadArtifact).not.toHaveBeenCalled();
  });
});
