import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Skills list API 守卫与取数 + POST 建 skill 编排（02-4 正式链）。
 * mock studio-access + skill-studio-queries + skill-queries + skill/repo + admin-audit；
 * frontmatter 用真（纯函数），assertValidSkillName 用真（Agent Skills 标准校验）。
 * contentHashFromGitSha 保留真实实现（skill-queries importActual）。
 */

const studio = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
}));
const studioQueries = vi.hoisted(() => ({ listSkills: vi.fn() }));
const skillQryMocks = vi.hoisted(() => ({
  createSkill: vi.fn(),
  createSkillVersion: vi.fn(),
  getSkillByKey: vi.fn(),
  setCurrentSkillVersion: vi.fn(),
  updateSkill: vi.fn(),
}));
const repoMocks = vi.hoisted(() => ({
  writeSkillFile: vi.fn(),
  commitSkillVersion: vi.fn(),
}));
const audit = vi.hoisted(() => ({ recordAdminAudit: vi.fn() }));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studio.requireStudioAction,
  hasStudioAction: studio.hasStudioAction,
}));
vi.mock("@/lib/capability/skill-studio-queries", () => ({
  listSkills: studioQueries.listSkills,
}));
vi.mock("@/lib/capability/skill-queries", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    createSkill: skillQryMocks.createSkill,
    createSkillVersion: skillQryMocks.createSkillVersion,
    getSkillByKey: skillQryMocks.getSkillByKey,
    setCurrentSkillVersion: skillQryMocks.setCurrentSkillVersion,
    updateSkill: skillQryMocks.updateSkill,
  };
});
vi.mock("@/lib/skill/repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/skill/repo")>();
  return {
    ...actual,
    writeSkillFile: repoMocks.writeSkillFile,
    commitSkillVersion: repoMocks.commitSkillVersion,
  };
});
vi.mock("@/lib/studio/admin-audit", () => ({ recordAdminAudit: audit.recordAdminAudit }));

import { GET, POST } from "@/app/studio/api/skills/route";
import { NextRequest } from "next/server";

const PRINCIPAL = { userIdentityId: "u1", tenantId: "t1" };

beforeEach(() => {
  vi.clearAllMocks();
  studio.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
  studio.hasStudioAction.mockResolvedValue(true);
  audit.recordAdminAudit.mockResolvedValue(undefined);
});

describe("GET /studio/api/skills (Stage B)", () => {
  it("skill.read 通过 → 200 + list", async () => {
    studioQueries.listSkills.mockResolvedValue([{ id: "s1", skillKey: "build-from-idea" }]);
    const res = await GET(new NextRequest("http://localhost/studio/api/skills"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{ id: "s1", skillKey: "build-from-idea" }]);
    expect(studio.requireStudioAction).toHaveBeenCalledWith(expect.anything(), "skill.read");
  });

  it("无 skill.read → 403，不查 list", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(new NextRequest("http://localhost/studio/api/skills"));
    expect(res.status).toBe(403);
    expect(studioQueries.listSkills).not.toHaveBeenCalled();
  });
});

describe("POST /studio/api/skills（建 skill）", () => {
  it("skill.write 通过 → 200 + 编排 createSkill/writeSkillFile/commitSkillVersion/createSkillVersion/setCurrentSkillVersion", async () => {
    skillQryMocks.getSkillByKey.mockResolvedValue(null);
    skillQryMocks.createSkill.mockResolvedValue({ id: "sk-1", versionNo: 1 });
    repoMocks.writeSkillFile.mockResolvedValue("SKILL.md");
    repoMocks.commitSkillVersion.mockResolvedValue("sha-abc");
    skillQryMocks.createSkillVersion.mockResolvedValue({ id: "ver-1", versionNo: 1 });

    const req = new NextRequest("http://localhost/studio/api/skills", {
      method: "POST",
      body: JSON.stringify({
        name: "my-skill",
        description: "测试 skill",
        tools: ["readFile", "writeFile"],
        promptMd: "# 正文",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ skillId: "sk-1", versionId: "ver-1", commitSha: "sha-abc" });
    expect(studio.requireStudioAction).toHaveBeenCalledWith(expect.anything(), "skill.write");
    expect(skillQryMocks.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({ skillKey: "my-skill", description: "测试 skill" }),
    );
    expect(repoMocks.writeSkillFile).toHaveBeenCalledWith(
      "my-skill",
      "SKILL.md",
      expect.any(String),
    );
    expect(repoMocks.commitSkillVersion).toHaveBeenCalledWith("my-skill", expect.any(String));
    expect(skillQryMocks.createSkillVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: "sk-1",
        contentRef: "sha-abc",
        contentHash: expect.stringMatching(/^sha256:/),
      }),
    );
    expect(skillQryMocks.setCurrentSkillVersion).toHaveBeenCalledWith({
      tenantId: "t1",
      skillId: "sk-1",
      skillVersionId: "ver-1",
      expectedCurrentVersionId: null,
    });
  });

  it("重名 → 409", async () => {
    skillQryMocks.getSkillByKey.mockResolvedValue({ id: "existing", skillKey: "my-skill" });
    const req = new NextRequest("http://localhost/studio/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "my-skill" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    expect(skillQryMocks.createSkill).not.toHaveBeenCalled();
  });

  it("非法 name → 400", async () => {
    const req = new NextRequest("http://localhost/studio/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "Bad Name" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("无 skill.write → 403", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const req = new NextRequest("http://localhost/studio/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "my-skill" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});

// S1（11-P1-5）：发布校验阻断
describe("POST /studio/api/skills - 校验阻断", () => {
  it("commitSkillVersion 抛 SkillValidationError → 400 + 错误信息", async () => {
    skillQryMocks.getSkillByKey.mockResolvedValue(null);
    skillQryMocks.createSkill.mockResolvedValue({ id: "sk-1", versionNo: 1 });
    repoMocks.writeSkillFile.mockResolvedValue("SKILL.md");
    // 模拟校验失败
    const { SkillValidationError } = await import("@/lib/skill/repo");
    repoMocks.commitSkillVersion.mockRejectedValue(
      new SkillValidationError("SKILL.md frontmatter 缺 description 字段"),
    );

    const req = new NextRequest("http://localhost/studio/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "bad-skill", description: "" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("skill_validation_failed");
    expect(body.error.message).toContain("description");
    // 不应创建版本
    expect(skillQryMocks.createSkillVersion).not.toHaveBeenCalled();
  });

  it("commitSkillVersion 抛普通 SkillRepoError(无改动)→ 走 headSha 回退逻辑", async () => {
    skillQryMocks.getSkillByKey.mockResolvedValue(null);
    skillQryMocks.createSkill.mockResolvedValue({ id: "sk-2", versionNo: 1 });
    repoMocks.writeSkillFile.mockResolvedValue("SKILL.md");
    const { SkillRepoError } = await import("@/lib/skill/repo");
    repoMocks.commitSkillVersion.mockRejectedValue(new SkillRepoError("无改动"));
    // getSkillHeadSha 返回 null(实际 mock 用 actual,这里走真实逻辑返回 null)
    skillQryMocks.createSkillVersion.mockResolvedValue({ id: "ver-2", versionNo: 1 });

    const req = new NextRequest("http://localhost/studio/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "dup-skill", description: "测试" }),
    });
    const res = await POST(req);
    // getSkillHeadSha 返回 null(新 skill 无 HEAD) → 500
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("commit_failed");
  });
});
