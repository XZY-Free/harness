import {
  adaptiveThreshold,
  buildMatchText,
  extractKeywords,
  invalidateStopwordCache,
} from "@/lib/skill/matcher";
import { afterEach, describe, expect, it } from "vitest";

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
