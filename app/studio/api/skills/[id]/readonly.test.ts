import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 同步 Skill 只读拦截测试（02 文档 §7.2）。
 * 验证 source=capability-market 的 skill 调写接口 → 403 synced_skill_readonly。
 * 覆盖：PUT（改身份）、DELETE（归档）、versions POST、publish、rollback、files PUT。
 * unsync 单独测。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({
  getSkillById: vi.fn(),
  getSkillVersion: vi.fn(),
  updateSkill: vi.fn(),
  archiveSkill: vi.fn(),
  setCurrentVersion: vi.fn(),
  getMaxSkillVersionNumber: vi.fn(),
  getSkillVersionByCommitSha: vi.fn(),
  getCurrentSkillVersion: vi.fn(),
  createSkillVersion: vi.fn(),
  getSyncMappingByLocalSkill: vi.fn(),
  updateSyncMapping: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/queries", () => queries);
vi.mock("@/lib/studio/admin-audit", () => ({ recordAdminAudit: vi.fn() }));
vi.mock("@/lib/skill/repo", () => ({
  SkillRepoError: class extends Error {},
  SkillValidationError: class extends Error {},
  readSkillFile: vi.fn(),
  writeSkillFile: vi.fn(),
  commitSkillVersion: vi.fn(),
  getSkillHeadSha: vi.fn(),
  listSkillFiles: vi.fn(),
  validateSkill: vi.fn(),
}));
vi.mock("@/lib/skill/frontmatter", () => ({
  parseSkillMd: vi.fn(),
  buildSkillMd: vi.fn(),
}));

import { PUT as FilesPut } from "@/app/studio/api/skills/[id]/files/route";
import { POST as PublishPost } from "@/app/studio/api/skills/[id]/publish/route";
import { POST as RollbackPost } from "@/app/studio/api/skills/[id]/rollback/route";
import { DELETE, PUT } from "@/app/studio/api/skills/[id]/route";
import { POST as UnsyncPost } from "@/app/studio/api/skills/[id]/unsync/route";
import { POST as VersionsPost } from "@/app/studio/api/skills/[id]/versions/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };
const syncedSkill = {
  id: "s1",
  name: "deploy-review",
  source: "capability-market",
  ownerUserId: "u1",
  currentVersionId: "v1",
};
const localSkill = {
  id: "s2",
  name: "my-skill",
  source: "local",
  ownerUserId: "u1",
  currentVersionId: "v1",
};

function req(
  method: string,
  id: string,
  body?: unknown,
): { req: NextRequest; params: Promise<{ id: string }> } {
  const r = new NextRequest(`http://localhost/studio/api/skills/${id}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { req: r, params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
  rbac.hasPermission.mockResolvedValue(true); // admin
});

describe("同步 Skill 只读拦截（02 文档 §7.2）", () => {
  it("PUT 改身份 → 403 synced_skill_readonly", async () => {
    queries.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("PUT", "s1", { description: "new" });
    const res = await PUT(r, { params });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("synced_skill_readonly");
    expect(queries.updateSkill).not.toHaveBeenCalled();
  });

  it("DELETE → 403（需走 unsync）", async () => {
    queries.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("DELETE", "s1");
    const res = await DELETE(r, { params });
    expect(res.status).toBe(403);
    expect(queries.archiveSkill).not.toHaveBeenCalled();
  });

  it("versions POST 发布新版本 → 403", async () => {
    queries.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("POST", "s1", { message: "v2" });
    const res = await VersionsPost(r, { params });
    expect(res.status).toBe(403);
    expect(queries.createSkillVersion).not.toHaveBeenCalled();
  });

  it("publish → 403", async () => {
    queries.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("POST", "s1", { versionId: "v1" });
    const res = await PublishPost(r, { params });
    expect(res.status).toBe(403);
    expect(queries.setCurrentVersion).not.toHaveBeenCalled();
  });

  it("rollback → 403", async () => {
    queries.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("POST", "s1", { versionId: "v1" });
    const res = await RollbackPost(r, { params });
    expect(res.status).toBe(403);
    expect(queries.setCurrentVersion).not.toHaveBeenCalled();
  });

  it("files PUT → 403", async () => {
    queries.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("PUT", "s1", { path: "SKILL.md", content: "x" });
    const res = await FilesPut(r, { params });
    expect(res.status).toBe(403);
  });

  it("本地自建 Skill → 放行（不拦截）", async () => {
    queries.getSkillById.mockResolvedValue(localSkill);
    const { req: r, params } = req("PUT", "s2", { description: "new" });
    const res = await PUT(r, { params });
    expect(res.status).not.toBe(403);
    expect(queries.updateSkill).toHaveBeenCalled();
  });
});

describe("POST /studio/api/skills/[id]/unsync（02 文档 §7.2 取消同步）", () => {
  it("同步 Skill → archive + 映射标 not_found", async () => {
    queries.getSkillById.mockResolvedValue(syncedSkill);
    queries.getSyncMappingByLocalSkill.mockResolvedValue({ id: "m1", remoteAssetId: "asset-1" });
    const { req: r, params } = req("POST", "s1");
    const res = await UnsyncPost(r, { params });
    expect(res.status).toBe(200);
    expect(queries.archiveSkill).toHaveBeenCalledWith("s1");
    expect(queries.updateSyncMapping).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ syncState: "not_found" }),
    );
  });

  it("本地自建 Skill → 403 not_synced_skill", async () => {
    queries.getSkillById.mockResolvedValue(localSkill);
    const { req: r, params } = req("POST", "s2");
    const res = await UnsyncPost(r, { params });
    expect(res.status).toBe(403);
    expect(queries.archiveSkill).not.toHaveBeenCalled();
  });

  it("非 admin → 403", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    queries.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("POST", "s1");
    const res = await UnsyncPost(r, { params });
    expect(res.status).toBe(403);
  });
});
