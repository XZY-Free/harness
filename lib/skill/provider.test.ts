/**
 * SkillProvider 测试（02 文档 §六.1，关口02 02-4 Tenant 化）。
 *
 * 02 文档后只有 LocalDbSkillProvider（运行时本地化）,EnterpriseSkillProvider 已删除。
 * 02-4：事实源迁到正式 skill 仓储（tenant-scoped），覆盖：
 * - LocalDbSkillProvider：从本地 DB enabled skill 映射 SkillSummary。
 * - source 字段：本地自建 skill → local;同步 skill → capability_market。
 * - 无 currentVersion 的 skill 跳过;无 active skill 返回空数组。
 * - listSkillsForMatching 已按来源过滤同步 skill（非 active 绑定不进入候选）,
 *   本测试只验证映射层,来源过滤在 queries 层覆盖。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── mock（正式 skill-queries）──────────────────────────────

vi.mock("@/lib/capability/skill-queries", () => ({
  listSkillsForMatching: vi.fn(),
  getCurrentSkillVersion: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { listSkillsForMatching, getCurrentSkillVersion } = await import(
  "@/lib/capability/skill-queries"
);

import { LocalDbSkillProvider, __setSkillProviderForTest } from "@/lib/skill/provider";

const TENANT = "tenant-1";

describe("LocalDbSkillProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __setSkillProviderForTest(null);
  });

  afterEach(() => {
    __setSkillProviderForTest(null);
  });

  it("本地自建 skill（sourceType=local）+ currentVersion → 映射为 SkillSummary", async () => {
    vi.mocked(listSkillsForMatching).mockResolvedValue([
      {
        id: "skill-1",
        tenantId: TENANT,
        skillKey: "zfl-requirement",
        displayName: "zfl-requirement",
        description: "需求引导",
        sourceType: "local",
        visibilityScope: "tenant",
        lifecycleState: "enabled",
        currentVersionId: "ver-1",
      } as never,
    ]);
    vi.mocked(getCurrentSkillVersion).mockResolvedValue({
      id: "ver-1",
      contentHash: "abc123",
      versionNo: 3,
    } as never);

    const provider = new LocalDbSkillProvider();
    const skills = await provider.listAvailableSkills(TENANT);

    expect(skills).toHaveLength(1);
    const s = skills[0]!;
    expect(s.skillId).toBe("skill-1");
    expect(s.skillVersionId).toBe("ver-1");
    expect(s.source).toBe("local");
    expect(s.namespace).toBe("local");
    expect(s.contentHash).toBe("abc123");
    expect(s.requiredCapabilities).toEqual([]);
    expect(s.modelInvocable).toBe(true);
    expect(s.uiVisible).toBe(true);
    expect(s.version).toBe("3");
  });

  it("同步 skill（sourceType=capability_market）→ source 透传为 capability_market", async () => {
    vi.mocked(listSkillsForMatching).mockResolvedValue([
      {
        id: "skill-sync",
        tenantId: TENANT,
        skillKey: "deploy-review",
        displayName: "deploy-review",
        description: "部署审查",
        sourceType: "capability_market",
        visibilityScope: "tenant",
        lifecycleState: "enabled",
        currentVersionId: "ver-sync-1",
      } as never,
    ]);
    vi.mocked(getCurrentSkillVersion).mockResolvedValue({
      id: "ver-sync-1",
      contentHash: "def456",
      versionNo: 1,
    } as never);

    const provider = new LocalDbSkillProvider();
    const skills = await provider.listAvailableSkills(TENANT);

    expect(skills).toHaveLength(1);
    const s = skills[0]!;
    expect(s.source).toBe("capability_market");
    expect(s.namespace).toBe("capability_market");
    expect(s.contentHash).toBe("def456");
    expect(s.skillId).toBe("skill-sync");
  });

  it("skill 无 currentVersion → 跳过（无可用版本不进入候选）", async () => {
    vi.mocked(listSkillsForMatching).mockResolvedValue([
      {
        id: "skill-1",
        tenantId: TENANT,
        skillKey: "x",
        displayName: "x",
        sourceType: "local",
        lifecycleState: "enabled",
        currentVersionId: null,
      } as never,
    ]);
    vi.mocked(getCurrentSkillVersion).mockResolvedValue(null);

    const provider = new LocalDbSkillProvider();
    const skills = await provider.listAvailableSkills(TENANT);
    expect(skills).toHaveLength(0);
  });

  it("DB 无 enabled skill → 返回空数组（基础 agent 运行）", async () => {
    vi.mocked(listSkillsForMatching).mockResolvedValue([]);

    const provider = new LocalDbSkillProvider();
    const skills = await provider.listAvailableSkills(TENANT);
    expect(skills).toEqual([]);
  });
});
