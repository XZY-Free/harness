import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/skills 测试（02 文档 §六.1）。
 *
 * 02 文档后只返回本地 active Skill（LocalDbSkillProvider）,不再有企业模式。
 * 覆盖：
 * - 返回 Provider 的可用 Skill（id=skillId,name=displayName 优先）。
 * - uiVisible=false 的 Skill 被过滤。
 * - Provider 抛错 → 路由 catch 返回空列表（不 500）。
 * - displayName 为空 → name 兜底。
 * - source=local / capability-market 都能透传。
 *
 * 02-2b：授权契约迁到正式 Principal 解析（resolveStudioPrincipal）。
 */

const studio = vi.hoisted(() => ({
  resolveStudioPrincipal: vi.fn(),
}));

const providerMocks = vi.hoisted(() => ({
  listAvailableSkills: vi.fn(),
}));

vi.mock("@/lib/identity/studio-access", () => ({
  resolveStudioPrincipal: studio.resolveStudioPrincipal,
}));

vi.mock("@/lib/skill/provider", () => ({
  getSkillProvider: () => ({
    listAvailableSkills: providerMocks.listAvailableSkills,
  }),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { GET } from "@/app/api/skills/route";
import type { SkillSummary } from "@/lib/skill/provider";

/** resolveStudioPrincipal 返回的 Principal（路由只校验解析成功）。 */
const PRINCIPAL = {
  id: "u1",
  externalId: "u1",
  email: "a@b",
  name: "U",
  userIdentityId: "u1",
  tenantId: "t1",
};

function makeSummary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    skillId: "skill_test",
    skillVersionId: "ver_test_1",
    namespace: "local",
    name: "test-skill",
    displayName: "测试 Skill",
    description: "测试描述",
    whenToUse: "测试",
    tags: ["test"],
    source: "local",
    visibility: "public",
    modelInvocable: true,
    uiVisible: true,
    requiredCapabilities: [],
    contentHash: "abc123",
    version: "1",
    ...overrides,
  };
}

function req(): NextRequest {
  return new NextRequest("http://localhost/api/skills");
}

describe("GET /api/skills (02 文档本地 Provider)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    studio.resolveStudioPrincipal.mockResolvedValue(PRINCIPAL);
  });

  afterEach(() => {
    providerMocks.listAvailableSkills.mockReset();
  });

  it("未登录 → 401", async () => {
    const { resolveStudioPrincipal } = await import("@/lib/identity/studio-access");
    (resolveStudioPrincipal as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("no auth"),
    );
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("返回本地 Skill,id=skillId,name=displayName 优先", async () => {
    providerMocks.listAvailableSkills.mockResolvedValue([
      makeSummary({
        skillId: "local-1",
        displayName: "需求引导",
        name: "zfl-requirement",
        description: "引导需求",
        tags: ["requirement", "doc"],
      }),
      makeSummary({
        skillId: "local-2",
        displayName: "UI 重构",
        name: "refactor-ui",
        description: "重构前端",
        tags: [],
      }),
    ]);

    const res = await GET(req());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({
      id: "local-1",
      name: "需求引导", // displayName 优先
      description: "引导需求",
      category: "requirement", // tags[0]
    });
    expect(body.data[1]).toEqual({
      id: "local-2",
      name: "UI 重构",
      description: "重构前端",
      category: null,
    });
  });

  it("uiVisible=false 的 Skill 被过滤", async () => {
    providerMocks.listAvailableSkills.mockResolvedValue([
      makeSummary({ skillId: "visible", uiVisible: true }),
      makeSummary({ skillId: "hidden", uiVisible: false }),
    ]);

    const res = await GET(req());
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("visible");
  });

  it("Provider 返回空 → 路由返回空列表（fail-closed,不伪造默认 Skill）", async () => {
    providerMocks.listAvailableSkills.mockResolvedValue([]);

    const res = await GET(req());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("Provider 抛错 → 路由 catch 返回空列表（不 500）", async () => {
    providerMocks.listAvailableSkills.mockRejectedValue(new Error("DB down"));

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("同步 Skill（source=capability-market）也正常返回（运行时与 local 无差异）", async () => {
    providerMocks.listAvailableSkills.mockResolvedValue([
      makeSummary({
        skillId: "synced-1",
        skillVersionId: "v1",
        namespace: "capability-market",
        name: "deploy-review",
        displayName: "部署审查",
        description: "审查部署",
        tags: ["deploy"],
        source: "capability-market",
        contentHash: "def456",
        version: "1",
      }),
    ]);

    const res = await GET(req());
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      id: "synced-1",
      name: "部署审查",
      description: "审查部署",
      category: "deploy",
    });
  });

  it("displayName 为空字符串 → name 兜底", async () => {
    providerMocks.listAvailableSkills.mockResolvedValue([
      makeSummary({ skillId: "s1", displayName: "", name: "fallback-name" }),
    ]);

    const res = await GET(req());
    const body = await res.json();
    expect(body.data[0].name).toBe("fallback-name");
  });
});
