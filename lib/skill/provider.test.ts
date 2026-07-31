/**
 * SkillProvider 测试（02 文档 §六.1）。
 *
 * 02 文档后只有 LocalDbSkillProvider（运行时本地化）,EnterpriseSkillProvider 已删除。
 * 覆盖：
 * - LocalDbSkillProvider：从本地 DB active skill 映射 SkillSummary。
 * - source 字段：本地自建 skill → local;同步 skill → capability-market。
 * - 无 currentVersion 的 skill 跳过;无 active skill 返回空数组。
 * - listActiveSkillsForMatching 已按来源过滤同步 skill（非 active 映射不进入候选）,
 *   本测试只验证映射层,来源过滤在 queries 层覆盖。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── mock ─────────────────────────────────────────────────

vi.mock("@/lib/db/queries", () => ({
  listActiveSkillsForMatching: vi.fn(),
  getCurrentSkillVersion: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { listActiveSkillsForMatching, getCurrentSkillVersion } = await import("@/lib/db/queries");

import { LocalDbSkillProvider, __setSkillProviderForTest } from "@/lib/skill/provider";

describe("LocalDbSkillProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __setSkillProviderForTest(null);
  });

  afterEach(() => {
    __setSkillProviderForTest(null);
  });

  it("本地自建 skill（source=local）+ currentVersion → 映射为 SkillSummary", async () => {
    vi.mocked(listActiveSkillsForMatching).mockResolvedValue([
      {
        id: "skill-1",
        name: "zfl-requirement",
        description: "需求引导",
        category: "requirement",
        visibility: "public",
        status: "active",
        currentVersionId: "ver-1",
        source: "local",
      } as never,
    ]);
    vi.mocked(getCurrentSkillVersion).mockResolvedValue({
      id: "ver-1",
      commitSha: "abc123",
      version: 3,
    } as never);

    const provider = new LocalDbSkillProvider();
    const skills = await provider.listAvailableSkills();

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

  it("同步 skill（source=capability-market）→ source 透传为 capability-market", async () => {
    vi.mocked(listActiveSkillsForMatching).mockResolvedValue([
      {
        id: "skill-sync",
        name: "deploy-review",
        description: "部署审查",
        category: "deploy",
        visibility: "public",
        status: "active",
        currentVersionId: "ver-sync-1",
        source: "capability-market",
      } as never,
    ]);
    vi.mocked(getCurrentSkillVersion).mockResolvedValue({
      id: "ver-sync-1",
      commitSha: "def456",
      version: 1,
    } as never);

    const provider = new LocalDbSkillProvider();
    const skills = await provider.listAvailableSkills();

    expect(skills).toHaveLength(1);
    const s = skills[0]!;
    expect(s.source).toBe("capability-market");
    expect(s.namespace).toBe("capability-market");
    expect(s.contentHash).toBe("def456");
    // 运行时读取路径与 local 一致（commitSha 来自本地 git 快照）
    expect(s.skillId).toBe("skill-sync");
  });

  it("skill 无 currentVersion → 跳过（无可用版本不进入候选）", async () => {
    vi.mocked(listActiveSkillsForMatching).mockResolvedValue([
      { id: "skill-1", name: "x", currentVersionId: null, source: "local" } as never,
    ]);
    vi.mocked(getCurrentSkillVersion).mockResolvedValue(null);

    const provider = new LocalDbSkillProvider();
    const skills = await provider.listAvailableSkills();
    expect(skills).toHaveLength(0);
  });

  it("DB 无 active skill → 返回空数组（基础 agent 运行）", async () => {
    vi.mocked(listActiveSkillsForMatching).mockResolvedValue([]);

    const provider = new LocalDbSkillProvider();
    const skills = await provider.listAvailableSkills();
    expect(skills).toEqual([]);
  });
});
