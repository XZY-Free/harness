import type { SkillSummary } from "@/lib/skill/provider";
import { resolveSkillForRun } from "@/lib/skill/resolver";
import { describe, expect, it } from "vitest";

function makeSummary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    skillId: "zfl",
    skillVersionId: "zfl-v1",
    namespace: "local",
    name: "zfl-requirement",
    displayName: "zfl-requirement",
    description: "需求引导 skill",
    whenToUse:
      "用于需求分析、需求调研、需求澄清、撰写 requirement.md / reqdoc.md / ui-spec.md，" +
      "或提到需求文档、需求撰写、需求分析。",
    tags: ["requirement"],
    source: "local",
    visibility: "public",
    modelInvocable: true,
    uiVisible: true,
    requiredCapabilities: [],
    contentHash: "sha-zfl-1",
    version: "1",
    ...overrides,
  };
}

const ZFL = makeSummary();
const ORDER = makeSummary({
  skillId: "order",
  skillVersionId: "order-v1",
  name: "order-debug",
  displayName: "订单排查",
  description: "订单排查 skill",
  whenToUse: "用于订单退款失败、订单状态排查、查订单问题。",
  tags: ["order"],
  contentHash: "sha-order-1",
});

function run(args: {
  userMessage?: { text: string; attachmentFilenames?: string[] };
  uiSelectedSkillIds?: string[];
  availableSkills?: SkillSummary[];
  resumeFromRunId?: string;
  resumedSkillVersions?: Parameters<typeof resolveSkillForRun>[0]["resumedSkillVersions"];
}) {
  return resolveSkillForRun({
    threadId: "t1",
    runId: "r1",
    userMessage: args.userMessage ?? { text: "" },
    uiSelectedSkillIds: args.uiSelectedSkillIds ?? [],
    availableSkills: args.availableSkills ?? [ZFL, ORDER],
    resumeFromRunId: args.resumeFromRunId,
    resumedSkillVersions: args.resumedSkillVersions,
  });
}

describe("resolveSkillForRun - 基础 agent（无 Skill）", () => {
  it("无 UI 选择 + 消息不匹配任何 skill → 空数组（不回退默认 skill）", () => {
    const out = run({ userMessage: { text: "今天天气真好" } });
    expect(out.selectedSkillVersions).toEqual([]);
    expect(out.decisionReason).toContain("基础 agent");
    expect(out.ignoredUiSelectedSkillIds).toEqual([]);
  });

  it("availableSkills 为空 → 空数组", () => {
    const out = run({
      userMessage: { text: "写个需求文档" },
      availableSkills: [],
    });
    expect(out.selectedSkillVersions).toEqual([]);
  });
});

describe("resolveSkillForRun - 自动匹配", () => {
  it("无 UI 选择 + 消息命中需求关键词 → 选中 zfl-requirement", () => {
    const out = run({ userMessage: { text: "帮我写个需求文档" } });
    expect(out.selectedSkillVersions).toHaveLength(1);
    expect(out.selectedSkillVersions[0]?.skillId).toBe("zfl");
    expect(out.selectedSkillVersions[0]?.source).toBe("resolver");
    expect(out.selectedSkillVersions[0]?.reason).toBe("keyword_matched");
    expect(out.selectedSkillVersions[0]?.contentHash).toBe("sha-zfl-1");
    expect(out.ignoredUiSelectedSkillIds).toEqual([]);
  });

  it("附件文件名参与匹配", () => {
    // 文本本身不含需求关键词（"做个演示" 不命中），靠附件文件名 "需求文档草稿.md"
    // 命中 "需求文档" / "需求" / "文档" 多个关键词，证明附件参与匹配。
    const out = run({
      userMessage: { text: "根据这个做个演示", attachmentFilenames: ["需求文档草稿.md"] },
    });
    expect(out.selectedSkillVersions[0]?.skillId).toBe("zfl");
  });

  it("modelInvocable=false 的 skill 不参与自动匹配", () => {
    const nonInvocable = makeSummary({
      skillId: "manual-only",
      name: "manual-only",
      whenToUse: "需求分析 需求文档",
      modelInvocable: false,
    });
    const out = run({
      userMessage: { text: "写个需求文档" },
      availableSkills: [nonInvocable],
    });
    expect(out.selectedSkillVersions).toEqual([]);
  });
});

describe("resolveSkillForRun - UI 选择信号", () => {
  it("UI 单选 + skill 在候选集 → 采纳", () => {
    const out = run({
      userMessage: { text: "查一下订单 1001 退款失败" },
      uiSelectedSkillIds: ["order"],
    });
    expect(out.selectedSkillVersions).toHaveLength(1);
    expect(out.selectedSkillVersions[0]?.skillId).toBe("order");
    expect(out.selectedSkillVersions[0]?.reason).toBe("ui_selected");
    expect(out.ignoredUiSelectedSkillIds).toEqual([]);
  });

  it("UI 多选 + 都在候选集 → 采纳多个（结构支持多选）", () => {
    const out = run({
      userMessage: { text: "随便聊聊" },
      uiSelectedSkillIds: ["zfl", "order"],
    });
    expect(out.selectedSkillVersions).toHaveLength(2);
    expect(out.selectedSkillVersions.map((s) => s.skillId).sort()).toEqual(["order", "zfl"]);
  });

  it("UI 选了已下线/权限外 skill → 记入 ignored，降级到自动匹配", () => {
    const out = run({
      userMessage: { text: "帮我写个需求文档" },
      uiSelectedSkillIds: ["ghost-skill"],
    });
    // ghost-skill 不在候选集 → ignored；消息命中 zfl → 自动匹配选中 zfl
    expect(out.ignoredUiSelectedSkillIds).toEqual(["ghost-skill"]);
    expect(out.selectedSkillVersions[0]?.skillId).toBe("zfl");
    expect(out.selectedSkillVersions[0]?.reason).toBe("keyword_matched");
  });

  it("UI 选择全部失效 + 消息也不匹配 → 空数组，ignored 仍记录", () => {
    const out = run({
      userMessage: { text: "今天天气真好" },
      uiSelectedSkillIds: ["ghost-skill"],
    });
    expect(out.selectedSkillVersions).toEqual([]);
    expect(out.ignoredUiSelectedSkillIds).toEqual(["ghost-skill"]);
  });
});

describe("resolveSkillForRun - resume 沿用原版本", () => {
  it("resume + 有原 SkillVersion → 沿用，source=resume，忽略 UI 选择", () => {
    const out = run({
      userMessage: { text: "继续" },
      uiSelectedSkillIds: ["order"], // resume 时本轮 UI 选择应被忽略
      resumeFromRunId: "old-run-1",
      resumedSkillVersions: [
        {
          skillId: "zfl",
          skillVersionId: "zfl-v1",
          role: "primary",
          source: "resolver",
          reason: "keyword_matched",
          contentHash: "sha-zfl-1",
        },
      ],
    });
    expect(out.selectedSkillVersions).toHaveLength(1);
    expect(out.selectedSkillVersions[0]?.skillId).toBe("zfl");
    expect(out.selectedSkillVersions[0]?.skillVersionId).toBe("zfl-v1");
    expect(out.selectedSkillVersions[0]?.source).toBe("resume");
    // resume 忽略本轮 UI 选择
    expect(out.ignoredUiSelectedSkillIds).toEqual(["order"]);
  });

  it("resume + 原 run 无 Skill → 基础 agent，不重新决策", () => {
    const out = run({
      userMessage: { text: "继续" },
      resumeFromRunId: "old-run-2",
      resumedSkillVersions: [],
    });
    expect(out.selectedSkillVersions).toEqual([]);
    expect(out.decisionReason).toContain("基础 agent");
  });

  it("resume 沿用原 contentHash（skill 升级后旧 run 仍读旧版本）", () => {
    const out = run({
      userMessage: { text: "继续" },
      resumeFromRunId: "old-run-3",
      resumedSkillVersions: [
        {
          skillId: "zfl",
          skillVersionId: "zfl-v1",
          role: "primary",
          source: "resolver",
          reason: "keyword_matched",
          contentHash: "sha-zfl-old",
        },
      ],
    });
    expect(out.selectedSkillVersions[0]?.contentHash).toBe("sha-zfl-old");
    expect(out.selectedSkillVersions[0]?.skillVersionId).toBe("zfl-v1");
  });
});
