import type { Skill } from "@/lib/db/schema";
import {
  adaptiveThreshold,
  buildMatchText,
  extractKeywords,
  invalidateStopwordCache,
  matchSkill,
} from "@/lib/skill/matcher";
import { afterEach, describe, expect, it } from "vitest";

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "s1",
    name: "test-skill",
    description: "测试 skill",
    category: null,
    visibility: "public",
    status: "active",
    currentVersionId: null,
    ownerUserId: null,
    source: "local",
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

const ZFL_SKILL = makeSkill({
  id: "zfl",
  name: "zfl-requirement",
  description:
    "完整的需求引导与原型 skill，用于 opencode/harness 中和用户聊清需求、澄清业务、" +
    "读取目标项目上下文、撰写 requirement.md / reqdoc.md / ui-spec.md，并基于内置 snow-design-mobile " +
    "生成可预览 demo.html。Use when the user wants to 做需求分析、需求调研、需求澄清、页面需求梳理、" +
    "问题驱动访谈、角色权限梳理、现有流程分析、同类页面对照、项目风格对齐、撰写需求方案、" +
    "整理需求文档、生成可评审 Markdown 需求稿、生成页面视觉规格、生成可交互 HTML 原型，" +
    "或提到 zfl-requirement、需求分析、需求调研、需求文档、需求撰写、requirement.md、reqdoc.md、" +
    'ui-spec.md、demo.html。即使用户只说"帮我整理一下这个需求""写个需求文档"' +
    '"做个需求方案""根据这个需求做个演示页"，也应触发本 skill。',
});

const BUILD_SKILL = makeSkill({
  id: "build",
  name: "build-from-idea",
  description: "从想法到上线：默认全栈生成 skill（Phase 2 行为基线）",
});

describe("extractKeywords", () => {
  it("从中文 description 提取短语", () => {
    const kws = extractKeywords("需求分析 需求文档 需求撰写");
    expect(kws).toContain("需求分析");
    expect(kws).toContain("需求文档");
    expect(kws).toContain("需求撰写");
  });

  it("从英文 description 提取标识符", () => {
    const kws = extractKeywords("Use requirement.md and ui-spec.md");
    expect(kws.map((k) => k.toLowerCase())).toContain("requirement.md");
    expect(kws.map((k) => k.toLowerCase())).toContain("ui-spec.md");
  });

  it("过滤停用词", () => {
    const kws = extractKeywords("这是一个用于生成的 skill");
    expect(kws).not.toContain("这是");
    expect(kws).not.toContain("用于");
    expect(kws).not.toContain("生成");
  });

  it("空 description 返回空数组", () => {
    expect(extractKeywords(null)).toEqual([]);
    expect(extractKeywords(undefined)).toEqual([]);
    expect(extractKeywords("")).toEqual([]);
  });
});

describe("buildMatchText", () => {
  it("拼接文本和附件文件名", () => {
    const text = buildMatchText({
      text: "帮我做需求分析",
      attachmentFilenames: ["销量快报需求.md"],
    });
    expect(text).toContain("帮我做需求分析");
    expect(text).toContain("销量快报需求.md");
  });

  it("无附件时只返回文本", () => {
    const text = buildMatchText({ text: "hello" });
    expect(text).toBe("hello");
  });
});

describe("matchSkill", () => {
  it("用户上传需求文档 → 匹配 zfl-requirement", () => {
    const text = buildMatchText({
      text: "根据这个需求做个演示页",
      attachmentFilenames: ["需求功能说明(销量快报).md"],
    });
    const matched = matchSkill(text, [ZFL_SKILL, BUILD_SKILL]);
    expect(matched?.name).toBe("zfl-requirement");
  });

  it('用户说"帮我整理一下这个需求" → 匹配 zfl-requirement', () => {
    const text = buildMatchText({ text: "帮我整理一下这个需求" });
    const matched = matchSkill(text, [ZFL_SKILL, BUILD_SKILL]);
    expect(matched?.name).toBe("zfl-requirement");
  });

  it('用户说"做一个极简的个人主页" → 不匹配 zfl，返回 null（用默认）', () => {
    const text = buildMatchText({ text: "做一个极简的个人主页，含头像、简介和社交链接" });
    const matched = matchSkill(text, [ZFL_SKILL, BUILD_SKILL]);
    expect(matched).toBeNull();
  });

  it('用户说"写个需求文档" → 匹配 zfl-requirement', () => {
    const text = buildMatchText({ text: "写个需求文档" });
    const matched = matchSkill(text, [ZFL_SKILL, BUILD_SKILL]);
    expect(matched?.name).toBe("zfl-requirement");
  });

  it("空 skill 列表 → null", () => {
    expect(matchSkill("需求分析", [])).toBeNull();
  });

  it("只有 build-from-idea → null（示例 skill 不参与旧路径匹配）", () => {
    expect(matchSkill("需求分析", [BUILD_SKILL])).toBeNull();
  });

  it("阈值：无关键词命中 → null（避免误触）", () => {
    // S1（11-P1-1）：bigram 提升召回后，"需求"从长 CJK 段提取为有效关键词，单概念匹配可能 >= 2。
    // 用完全不相关的文本测试阈值。
    const text = buildMatchText({ text: "你好世界" });
    const matched = matchSkill(text, [ZFL_SKILL, BUILD_SKILL]);
    expect(matched).toBeNull();
  });
});

// S1（11-P1-1）：Intl.Segmenter 中文真分词
describe("extractKeywords - Intl.Segmenter 分词", () => {
  it("中文句子被真分词(而非整体抽取)", () => {
    // "需求分析调研" 经 Segmenter 切出 "需求""分析""调研" 等独立词
    const kws = extractKeywords("需求分析调研 撰写文档");
    expect(kws).toContain("需求");
    expect(kws).toContain("分析");
    expect(kws).toContain("调研");
    expect(kws).toContain("撰写");
    expect(kws).toContain("文档");
  });

  it("中英混排:中文分词 + 英文标识符共存", () => {
    const kws = extractKeywords("需求分析 requirement.md ui-spec.md");
    expect(kws).toContain("需求");
    expect(kws).toContain("分析");
    expect(kws.map((k) => k.toLowerCase())).toContain("requirement.md");
    expect(kws.map((k) => k.toLowerCase())).toContain("ui-spec.md");
  });

  it("空串/null/undefined → 空数组", () => {
    expect(extractKeywords("")).toEqual([]);
    expect(extractKeywords(null)).toEqual([]);
    expect(extractKeywords(undefined)).toEqual([]);
  });

  it("纯标点/数字 → 空数组(无 word 段)", () => {
    expect(extractKeywords("--- 123 456 !!!")).toEqual([]);
  });

  it("4+ 字 CJK 段额外 bigram 补召回", () => {
    // "需求分析调研" 是 6 字连续段,bigram 应包含 "需求""求分""分析""析调""调研"
    const kws = extractKeywords("需求分析调研");
    expect(kws).toContain("需求");
    expect(kws).toContain("分析");
    expect(kws).toContain("调研");
  });
});

// S1（11-P2-1）：停用词可配置(env SNOW_SKILL_STOPWORDS)
describe("extractKeywords - 停用词可配置", () => {
  afterEach(() => {
    // 清缓存 + 恢复 env
    Reflect.deleteProperty(process.env, "SNOW_SKILL_STOPWORDS");
    invalidateStopwordCache();
  });

  it("默认停用词生效(无 env 时)", () => {
    invalidateStopwordCache();
    const kws = extractKeywords("这是一个用于生成的 skill");
    expect(kws).not.toContain("这是");
    expect(kws).not.toContain("用于");
    expect(kws).not.toContain("生成");
  });

  it("env SNOW_SKILL_STOPWORDS 叠加自定义停用词", () => {
    process.env.SNOW_SKILL_STOPWORDS = "需求分析,自定义词";
    invalidateStopwordCache();
    const kws = extractKeywords("需求分析 自定义词 撰写");
    expect(kws).not.toContain("需求分析");
    expect(kws).not.toContain("自定义词");
    expect(kws).toContain("撰写");
  });

  it("空 env 配置 → 仅默认停用词", () => {
    process.env.SNOW_SKILL_STOPWORDS = "";
    invalidateStopwordCache();
    const kws = extractKeywords("需求分析 撰写");
    expect(kws).toContain("需求分析");
    expect(kws).toContain("撰写");
  });
});

// S1（11-P1-2）：阈值自适应
describe("adaptiveThreshold", () => {
  it("skill 0-2 → threshold=2(基础值)", () => {
    expect(adaptiveThreshold(0).scoreThreshold).toBe(2);
    expect(adaptiveThreshold(1).scoreThreshold).toBe(2);
    expect(adaptiveThreshold(2).scoreThreshold).toBe(2);
  });

  it("skill 3-5 → threshold=3(更保守)", () => {
    expect(adaptiveThreshold(3).scoreThreshold).toBe(3);
    expect(adaptiveThreshold(4).scoreThreshold).toBe(3);
    expect(adaptiveThreshold(5).scoreThreshold).toBe(3);
  });

  it("skill 6-8 → threshold=4", () => {
    expect(adaptiveThreshold(6).scoreThreshold).toBe(4);
    expect(adaptiveThreshold(7).scoreThreshold).toBe(4);
    expect(adaptiveThreshold(8).scoreThreshold).toBe(4);
  });

  it("skill ≥ 12 → threshold=5(封顶 +3)", () => {
    expect(adaptiveThreshold(12).scoreThreshold).toBe(5);
    expect(adaptiveThreshold(100).scoreThreshold).toBe(5);
  });

  it("density 兜底阈值恒为 0.4", () => {
    expect(adaptiveThreshold(0).densityThreshold).toBe(0.4);
    expect(adaptiveThreshold(100).densityThreshold).toBe(0.4);
  });
});

describe("matchSkill - 阈值自适应行为", () => {
  it("skill 数量少时,低 score 也能命中", () => {
    // 1 个候选 skill,threshold=2;"需求文档"命中"需求""文档""需求文档" >= 2 → 通过
    const text = buildMatchText({ text: "需求文档" });
    const matched = matchSkill(text, [ZFL_SKILL, BUILD_SKILL]);
    expect(matched?.name).toBe("zfl-requirement");
  });

  it("skill 数量多时,低 score 不命中(更保守)", () => {
    // 构造 10 个候选 skill,threshold=4;短文本只命中少量词无法达标
    const manySkills: Skill[] = [ZFL_SKILL, BUILD_SKILL];
    for (let i = 0; i < 9; i++) {
      manySkills.push(
        makeSkill({
          id: `s${i}`,
          name: `other-skill-${i}`,
          description: `其他 skill ${i}`,
        }),
      );
    }
    // "需求" 单词命中(经 Segmenter),但 score 远达不到 threshold=5
    const text = buildMatchText({ text: "需求" });
    const matched = matchSkill(text, manySkills);
    // "需求" 在 ZFL description 中作为独立词出现,score=1,达不到 threshold=5
    // 但 density 兜底:1/N 可能 < 0.4(ZFL 关键词多)→ null
    // 这里验证多 skill 场景不会误命中
    expect(matched).toBeNull();
  });

  it("短文本高 density 兜底通过", () => {
    // 极短 skill description,关键词少,density 高 → 即使 score 低也通过
    const tinySkill = makeSkill({
      id: "tiny",
      name: "tiny-skill",
      description: "需求",
    });
    const text = buildMatchText({ text: "需求" });
    // 1 个候选,threshold=2,score=1 < 2,但 density=1/1=1 >= 0.4 → 通过
    const matched = matchSkill(text, [tinySkill, BUILD_SKILL]);
    expect(matched?.name).toBe("tiny-skill");
  });

  it("长文本低 density 不误命中", () => {
    // 长文本命中少量词,density 低,且 score 不达标 → null
    const longText = buildMatchText({
      text: "今天天气真好,我想出去散步,顺便聊聊需求的事情,但是主要是闲聊",
    });
    const matched = matchSkill(longText, [ZFL_SKILL, BUILD_SKILL]);
    // 命中"需求"等少量词,score 可能 1-2,threshold=2,density 低 → 视情况
    // 关键是不误命中(用户主要在闲聊)
    // 这里 ZFL description 含"需求""需求分析"等,longText 含"需求"→ score 至少 1
    // 但 threshold=2 且 density 低 → null
    expect(matched).toBeNull();
  });
});
