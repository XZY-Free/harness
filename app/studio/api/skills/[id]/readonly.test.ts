import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 同步 Skill 只读拦截测试（02 文档 §7.2）。
 * 验证 source=capability_market 的 skill 调写接口 → 403 synced_skill_readonly。
 * 覆盖：PUT（改身份）、DELETE（归档）、versions POST、publish、rollback、files PUT。
 * unsync 单独测。
 *
 * 02-4：路由已迁到正式 skill-queries / skill-sync-queries / skill-studio-queries；
 * owner 检查走真实 assertSkillWriteAccess（hasStudioAction mock=admin→放行），
 * 只读拦截走真实 rejectSyncedSkillWrite（读 sourceType）。
 * contentHashFromGitSha 保留真实实现（skill-queries importActual）。
 */

const studio = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
  resolveStudioPrincipal: vi.fn(),
}));
const skillQryMocks = vi.hoisted(() => ({
  getSkillById: vi.fn(),
  getSkillVersionById: vi.fn(),
  updateSkill: vi.fn(),
  createSkillVersion: vi.fn(),
  setCurrentSkillVersion: vi.fn(),
}));
const skillSyncMocks = vi.hoisted(() => ({
  getSyncBindingByLocalSkill: vi.fn(),
  updateSyncBinding: vi.fn(),
}));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studio.requireStudioAction,
  hasStudioAction: studio.hasStudioAction,
  resolveStudioPrincipal: studio.resolveStudioPrincipal,
}));
vi.mock("@/lib/capability/skill-queries", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getSkillById: skillQryMocks.getSkillById,
    getSkillVersionById: skillQryMocks.getSkillVersionById,
    updateSkill: skillQryMocks.updateSkill,
    createSkillVersion: skillQryMocks.createSkillVersion,
    setCurrentSkillVersion: skillQryMocks.setCurrentSkillVersion,
  };
});
vi.mock("@/lib/capability/skill-sync-queries", () => ({
  getSyncBindingByLocalSkill: skillSyncMocks.getSyncBindingByLocalSkill,
  updateSyncBinding: skillSyncMocks.updateSyncBinding,
}));
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

const PRINCIPAL = { userIdentityId: "u1", tenantId: "t1" };
const syncedSkill = {
  id: "s1",
  skillKey: "deploy-review",
  sourceType: "capability_market",
  ownerUserId: "u1",
  currentVersionId: "v1",
  versionNo: 1,
};
const localSkill = {
  id: "s2",
  skillKey: "my-skill",
  sourceType: "local",
  ownerUserId: "u1",
  currentVersionId: "v1",
  versionNo: 1,
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
  studio.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
  studio.hasStudioAction.mockResolvedValue(true); // admin
});

describe("同步 Skill 只读拦截（02 文档 §7.2）", () => {
  it("PUT 改身份 → 403 synced_skill_readonly", async () => {
    skillQryMocks.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("PUT", "s1", { description: "new" });
    const res = await PUT(r, { params });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("synced_skill_readonly");
    expect(skillQryMocks.updateSkill).not.toHaveBeenCalled();
  });

  it("DELETE → 403（需走 unsync）", async () => {
    skillQryMocks.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("DELETE", "s1");
    const res = await DELETE(r, { params });
    expect(res.status).toBe(403);
    expect(skillQryMocks.updateSkill).not.toHaveBeenCalled();
  });

  it("versions POST 发布新版本 → 403", async () => {
    skillQryMocks.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("POST", "s1", { message: "v2" });
    const res = await VersionsPost(r, { params });
    expect(res.status).toBe(403);
    expect(skillQryMocks.createSkillVersion).not.toHaveBeenCalled();
  });

  it("publish → 403", async () => {
    skillQryMocks.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("POST", "s1", { versionId: "v1" });
    const res = await PublishPost(r, { params });
    expect(res.status).toBe(403);
    expect(skillQryMocks.setCurrentSkillVersion).not.toHaveBeenCalled();
  });

  it("rollback → 403", async () => {
    skillQryMocks.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("POST", "s1", { versionId: "v1" });
    const res = await RollbackPost(r, { params });
    expect(res.status).toBe(403);
    expect(skillQryMocks.setCurrentSkillVersion).not.toHaveBeenCalled();
  });

  it("files PUT → 403", async () => {
    skillQryMocks.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("PUT", "s1", { path: "SKILL.md", content: "x" });
    const res = await FilesPut(r, { params });
    expect(res.status).toBe(403);
  });

  it("本地自建 Skill → 放行（不拦截）", async () => {
    skillQryMocks.getSkillById.mockResolvedValue(localSkill);
    const { req: r, params } = req("PUT", "s2", { description: "new" });
    const res = await PUT(r, { params });
    expect(res.status).not.toBe(403);
    expect(skillQryMocks.updateSkill).toHaveBeenCalled();
  });
});

describe("POST /studio/api/skills/[id]/unsync（02 文档 §7.2 取消同步）", () => {
  it("同步 Skill → updateSkill(disabled) + 绑定标 not_found", async () => {
    skillQryMocks.getSkillById.mockResolvedValue(syncedSkill);
    skillSyncMocks.getSyncBindingByLocalSkill.mockResolvedValue({
      id: "m1",
      remoteAssetId: "asset-1",
    });
    const { req: r, params } = req("POST", "s1");
    const res = await UnsyncPost(r, { params });
    expect(res.status).toBe(200);
    expect(skillQryMocks.updateSkill).toHaveBeenCalledWith({
      tenantId: "t1",
      skillId: "s1",
      lifecycleState: "disabled",
      expectedVersionNo: 1,
    });
    expect(skillSyncMocks.updateSyncBinding).toHaveBeenCalledWith(
      "t1",
      "m1",
      expect.objectContaining({ syncState: "not_found" }),
    );
  });

  it("本地自建 Skill → 403 not_synced_skill", async () => {
    skillQryMocks.getSkillById.mockResolvedValue(localSkill);
    const { req: r, params } = req("POST", "s2");
    const res = await UnsyncPost(r, { params });
    expect(res.status).toBe(403);
    expect(skillQryMocks.updateSkill).not.toHaveBeenCalled();
  });

  it("非 admin → 403", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    skillQryMocks.getSkillById.mockResolvedValue(syncedSkill);
    const { req: r, params } = req("POST", "s1");
    const res = await UnsyncPost(r, { params });
    expect(res.status).toBe(403);
  });
});
