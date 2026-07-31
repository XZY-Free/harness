/**
 * Skill 关键词匹配工具（V8 Skill Run Resolver 的内部能力）。
 *
 * 设计原则：
 * - **零 LLM 调用**（默认）：纯关键词匹配，不花 token、不增延迟。LLM 兜底可选开关。
 * - **基于关键词来源文本**：skill 作者在 description / whenToUse 里已经写了大量触发词
 *   （如 zfl-requirement 含"需求分析""需求文档""需求撰写"等），直接复用，不另维护关键词表。
 * - **降级为 Resolver 内部工具**：本模块只负责“在本轮消息文本上找最匹配的 skill”，
 *   **不再承担 thread 固化 / 默认 build-from-idea 兜底语义**。是否使用、是否固化由
 *   `lib/skill/resolver.ts` 在 run 级决定（方案 §六.1）。
 * - `pickBestSkill` 是与 DB 模型无关的通用核心，`Skill` / `SkillSummary` 都可适配后调用。
 * - `matchSkill(Skill[])` 是旧 chat 路径的兼容包装（过滤 build-from-idea），阶段 8 清理
 *   旧 chat 路径后可移除；新 Resolver 走 `pickBestSkill`。
 */

import { skillStopwordsConfig } from "@/lib/config";
import type { Skill } from "@/lib/db/schema";

/**
 * 通用匹配候选：与 DB 模型解耦。
 * - `id`：调用方用于回查完整对象的稳定 ID。
 * - `keywordSource`：关键词提取来源（Skill.description 或 SkillSummary.whenToUse）。
 */
export interface MatchableSkill {
  id: string;
  name: string;
  keywordSource: string | null;
}

/**
 * 默认中文停用词(无领域区分度,匹配会误触)。
 *
 * S1（11-P2-1）：本表与 skillStopwordsConfig.custom 合并,运行时通过 stopwordSet() 取合并集。
 * 用 module 级缓存避免每次 extractKeywords 重建 Set。
 */
const DEFAULT_CN_STOPWORDS = new Set([
  "用于",
  "这是",
  "一个",
  "本",
  "阶段",
  "完整",
  "基于",
  "内置",
  "生成",
  "可预览",
  "可交互",
  "可评审",
  "真实",
  "项目",
  "页面",
  "风格",
  "实现",
  "覆盖",
  "负责",
  "把",
  "用户的",
  "逐步",
  "逼近",
  "沉淀",
  "结构化",
  "目标",
  "不是",
  "落点",
  "而是",
  "取证",
  "来源",
  "面向",
  "某个",
  "既有",
  "必须",
  "先读取",
  "再按",
  "完成",
  "设计与",
  "执行",
  "必须严格",
  "严格按",
  "以下顺序",
  "不能跳过",
  "不能并行",
  "不能颠倒",
  // 分词后会冒出的常见虚词
  "的",
  "了",
  "是",
  "在",
  "和",
  "与",
  "或",
  "并",
  "由",
  "从",
  "到",
  "对",
  "为",
  "以",
  "及",
  "等",
  "中",
  "上",
  "下",
  "里",
  "也",
  "都",
  "还",
  "就",
  "只",
  "能",
  "要",
  "会",
  "可",
  "被",
  "把",
  "该",
  "其",
  "之",
  "而",
  "则",
  "若",
  "如",
  "即",
  "已",
  "需",
  "应",
  "将",
]);

/** 默认英文停用词。 */
const DEFAULT_EN_STOPWORDS = new Set([
  "use",
  "when",
  "the",
  "user",
  "wants",
  "to",
  "and",
  "or",
  "for",
  "with",
  "from",
  "in",
  "on",
  "at",
  "by",
  "an",
  "a",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "as",
  "of",
  "opencode",
  "harness",
  "skill",
  "phase",
]);

/**
 * 合并后的停用词集合(默认 + env 自定义)。缓存避免重建。
 *
 * 缓存失效：env 在测试中可能被改写,提供 invalidateStopwordCache() 显式失效。
 * 生产环境 env 一次性读取,缓存永久有效。
 */
let cachedStopwords: Set<string> | null = null;

function stopwordSet(): Set<string> {
  if (cachedStopwords) return cachedStopwords;
  const merged = new Set<string>();
  for (const w of DEFAULT_CN_STOPWORDS) merged.add(w);
  for (const w of DEFAULT_EN_STOPWORDS) merged.add(w);
  for (const w of skillStopwordsConfig.custom) merged.add(w);
  cachedStopwords = merged;
  return merged;
}

/** 测试用：清停用词缓存(改 env 后强制重建)。 */
export function invalidateStopwordCache(): void {
  cachedStopwords = null;
}

/**
 * CJK 字符判定(用于区分 Segmenter 切出的 word 是否为中文)。
 * 范围覆盖 CJK 统一表意文字 + 扩展 A(常见)+ 兼容表意文字。
 */
function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK 统一表意文字
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK 扩展 A
    (codePoint >= 0xf900 && codePoint <= 0xfaff) // CJK 兼容表意文字
  );
}

/**
 * S1（11-P1-1）：用 Intl.Segmenter（Node 原生 ICU 分词,支持 zh,无依赖）对 CJK 文本做真分词。
 *
 * 替代原正则 [一-龥]{2,8} 抽取——原方案对"需求分析"这种紧挨着的多词会整体抽出,
 * 无法切分"需求"和"分析";真分词能把"需求分析"切成 ["需求","分析"] 两个独立词,
 * 召回更准。对 4+ 字 CJK 段额外补 bigram 兜底召回(Segmenter 偶尔切得过细时仍能命中)。
 *
 * Node 18+ 全平台原生可用（ICU 完整）。happy-dom/node 测试环境同样可用。
 */
function segmentCn(text: string): string[] {
  // Intl.Segmenter 在 Node 18+ 全平台可用;若环境缺失(老 Node)退回正则兜底,不抛错。
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
    const matches = text.match(/[一-龥]{2,8}/g);
    return matches ?? [];
  }
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const out: string[] = [];
  for (const seg of segmenter.segment(text)) {
    // 只取 word 段(跳过标点/空白/无意义符号);单字过滤(无区分度,且 bigram 会覆盖)
    if (seg.isWordLike && seg.segment.length >= 2) {
      // 仅保留 CJK 段(英文走另一个分支)
      const cp = seg.segment.codePointAt(0) ?? 0;
      if (isCjkCodePoint(cp)) {
        out.push(seg.segment);
      }
    }
  }
  return out;
}

/**
 * 从 skill.description 提取匹配关键词。
 *
 * zfl-requirement 的 description 经过精心设计，含大量自然语言触发词：
 * "需求分析、需求调研、需求澄清、需求文档、需求撰写、requirement.md、reqdoc.md、
 * ui-spec.md、demo.html、帮我整理一下这个需求、写个需求文档" 等。
 *
 * 提取策略(S1 11-P1-1 重构):
 * 1. CJK 段用 Intl.Segmenter 真分词 → 得到 ["需求","分析","调研",...] 等独立词
 * 2. 4+ 字 CJK 段额外 bigram 补召回(Segmenter 切细时仍能命中"需求分析"整体)
 * 3. 英文标识符:含字母/数字/点/连字符的 token(如 requirement.md、ui-spec、demo.html)
 * 4. 过滤停用词(默认 + env SNOW_SKILL_STOPWORDS 自定义)
 */
export function extractKeywords(description: string | null | undefined): string[] {
  if (!description) return [];
  const keywords = new Set<string>();
  const stopwords = stopwordSet();

  // 中文:Segmenter 真分词 + bigram 补召回
  const cnWords = segmentCn(description);
  for (const w of cnWords) {
    if (stopwords.has(w)) continue;
    keywords.add(w);
    // S1（11-P1-1）：4+ 字 CJK 段额外 bigram(Segmenter 偶尔切得过细,bigram 兜底召回)
    if (w.length >= 4) {
      for (let i = 0; i < w.length - 1; i++) {
        const bg = w.slice(i, i + 2);
        if (!stopwords.has(bg)) keywords.add(bg);
      }
    }
  }
  // 兜底:正则抽取未分词器切出的连续 CJK 段(覆盖 Segmenter 不识别的稀有词组合)
  const cnRawMatches = description.match(/[一-龥]{2,8}/g);
  if (cnRawMatches) {
    for (const m of cnRawMatches) {
      if (stopwords.has(m)) continue;
      keywords.add(m);
      if (m.length >= 4) {
        for (let i = 0; i < m.length - 1; i++) {
          const bg = m.slice(i, i + 2);
          if (!stopwords.has(bg)) keywords.add(bg);
        }
      }
    }
  }

  // 英文标识符:含字母/数字/点/连字符的 token(如 requirement.md、ui-spec、demo.html)
  const enMatches = description.match(/[a-zA-Z][a-zA-Z0-9._-]{2,}/g);
  if (enMatches) {
    for (const m of enMatches) {
      const lower = m.toLowerCase();
      if (stopwords.has(lower)) continue;
      keywords.add(lower);
    }
  }

  return Array.from(keywords);
}

/** 提取用户消息文本（含附件文件名）用于匹配。 */
export function buildMatchText(args: {
  text: string;
  attachmentFilenames?: string[];
}): string {
  const parts = [args.text];
  if (args.attachmentFilenames && args.attachmentFilenames.length > 0) {
    parts.push(...args.attachmentFilenames);
  }
  return parts.join(" ").toLowerCase();
}

/**
 * S1（11-P1-2）：自适应匹配阈值。
 *
 * 设计考虑：
 * 1. **skill 数量**：候选 skill 越多,误命中概率越高,阈值应提高(更保守)。
 *    例如只有 1 个 skill 时,bestScore=1 已足够;有 10 个 skill 时,1 命中可能是巧合。
 * 2. **文本长度**：长文本里关键词密度天然低(用户啰嗦),按绝对阈值不公;按密度归一更合理。
 *    但纯密度阈值对极短文本("需求文档"4 字命中 2 词,density=0.5 但 score 仅 2)不公平。
 *    → 采用 score 绝对阈值 + density 兜底的双轨：score 够高 OR density 够高都通过。
 * 3. **命中关键词分布**：单一关键词重复命中不增加 score(已用 Set 去重),
 *    故 score 本身已反映"命中了几个不同关键词",无需额外处理。
 *
 * 公式：
 * - base = 2(最小可接受命中数;单概念场景"需求文档"应至少命中 2 个相关词)
 * - skill 越多越保守:threshold = base + floor(max(0, skillCount - 2) / 3)
 *   (skill ≤ 2 时 threshold=2;3-5 时 =3;6-8 时 =4;...)
 * - density 兜底:若 score < threshold 但 density ≥ 0.4,且 score ≥ 1,仍通过
 *   (短文本"需求文档"命中 2/2 = 1.0 density,即使 threshold=3 也通过)
 *
 * @param skillCount 候选 skill 数(不含 build-from-idea)
 * @returns { scoreThreshold, densityThreshold }
 */
export function adaptiveThreshold(skillCount: number): {
  scoreThreshold: number;
  densityThreshold: number;
} {
  const base = 2;
  // skill 越多越保守(每 3 个 skill 提高 1 分阈值,封顶 +3 避免阈值过高完全拒命中)
  // skill 0-2 → +0;3-5 → +1;6-8 → +2;9-11 → +3;≥12 → +3(封顶)
  const extra = Math.min(3, Math.floor(Math.max(0, skillCount) / 3));
  return {
    scoreThreshold: base + extra,
    // density 兜底:命中关键词占该 skill 全部关键词的比例 ≥ 40% 视为强信号
    densityThreshold: 0.4,
  };
}

/**
 * 通用关键词匹配核心（Resolver 内部工具，与 DB 模型解耦）。
 *
 * 算法：
 * 1. 遍历候选，从 `keywordSource` 提取关键词
 * 2. 统计用户消息文本命中的关键词数
 * 3. 取命中数最高且 > 0 的候选（平局用关键词命中率 density 作 tiebreaker）
 * 4. 自适应阈值——score 或 density 任一达标即通过
 *
 * @returns 匹配到的候选，或 null（无匹配，调用方走基础 agent，**不回退默认 skill**）。
 */
export function pickBestSkill(
  userText: string,
  candidates: MatchableSkill[],
): MatchableSkill | null {
  if (candidates.length === 0) return null;
  const lowerText = userText.toLowerCase();

  // 候选数用于阈值自适应（候选越多越保守）
  const { scoreThreshold, densityThreshold } = adaptiveThreshold(candidates.length);

  let best: MatchableSkill | null = null;
  let bestScore = 0;
  // 平局时用关键词命中率（命中数/总关键词数）作 tiebreaker
  let bestDensity = 0;

  for (const c of candidates) {
    const keywords = extractKeywords(c.keywordSource);
    let score = 0;
    for (const kw of keywords) {
      if (lowerText.includes(kw.toLowerCase())) {
        score++;
      }
    }

    const density = keywords.length > 0 ? score / keywords.length : 0;
    if (score > bestScore || (score === bestScore && density > bestDensity)) {
      bestScore = score;
      bestDensity = density;
      best = c;
    }
  }

  // 自适应阈值——score 达标 OR density 达标(短文本兜底)任一通过
  if (bestScore === 0) return null;
  if (bestScore >= scoreThreshold) return best;
  if (bestDensity >= densityThreshold && bestScore >= 1) return best;

  return null;
}

/**
 * 旧 chat 路径的兼容包装：在 `Skill[]` 上做关键词匹配。
 *
 * - 过滤 `build-from-idea`（旧“示例 skill 不参与匹配”约定的兼容保留）。
 * - 阶段 3 chat 路径改走 Resolver + `pickBestSkill` 后，本函数仅剩历史调用；
 *   阶段 8 清理旧路径时一并移除。
 *
 * @returns 匹配到的 skill，或 null（调用方旧逻辑回退默认；新模型下应走基础 agent）。
 */
export function matchSkill(userText: string, skills: Skill[]): Skill | null {
  if (skills.length === 0) return null;
  const candidates: MatchableSkill[] = skills
    .filter((s) => s.name !== "build-from-idea")
    .map((s) => ({ id: s.id, name: s.name, keywordSource: s.description }));
  const best = pickBestSkill(userText, candidates);
  if (!best) return null;
  return skills.find((s) => s.id === best.id) ?? null;
}

/**
 * S1（11-P1-3）：LLM 兜底 skill 匹配（可选）。
 *
 * 关键词匹配失败时，若 skillMatcherConfig.llmFallback=on，调 generateText 让 LLM 从
 * skill 列表中选最匹配的。返回 skill id 或 null。
 *
 * 注意：本函数不自动调用——由 chat route 在 matchSkill 返回 null 后显式调用。
 * 默认 off，启用需设 SNOW_SKILL_LLM_FALLBACK=on + 配置 LLM。
 */
export async function matchSkillWithLlm(userText: string, skills: Skill[]): Promise<Skill | null> {
  const { skillMatcherConfig } = await import("@/lib/config");
  if (!skillMatcherConfig.llmFallback) return null;
  if (skills.length === 0) return null;

  try {
    const { getChatModel } = await import("@/lib/ai/provider");
    const { generateText } = await import("ai");
    const { aiConfig } = await import("@/lib/config");
    const model = getChatModel(aiConfig.chatModel);
    const skillList = skills
      .filter((s) => s.name !== "build-from-idea")
      .map((s) => `- ${s.name}: ${s.description ?? ""}`)
      .join("\n");
    const { text } = await generateText({
      model,
      system:
        "从以下 skill 列表中选最匹配用户意图的一个。只输出 skill name（不含描述），若无匹配输出 NONE。",
      prompt: `用户意图: ${userText}\n\nSkill 列表:\n${skillList}`,
    });
    const matchedName = text.trim();
    if (matchedName === "NONE" || !matchedName) return null;
    return skills.find((s) => s.name === matchedName) ?? null;
  } catch {
    return null;
  }
}
