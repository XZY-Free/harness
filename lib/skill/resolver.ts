/**
 * SkillResolver：每个 ThreadRun 独立决定本轮是否使用 Skill（V8 Skill Run Resolver）。
 *
 * 设计目标（方案 §四 / §五.2-3 / §六.1）：
 * - **Run 级解析**：每次用户消息触发 run，都重新解析；不沿用 thread 旧选择。
 * - **Skill 可选**：无匹配返回空数组 → 基础 agent 运行；**不回退默认 skill**。
 * - **UI 选择只是输入信号**：Resolver 采纳 `availableSkills` 中存在的 UI 选择，
 * 不适用的（已下线/权限外）记入 `ignoredUiSelectedSkillIds`。
 * - **Resume 沿用原版本**：恢复未完成 run 时使用原 run 的 `ThreadRunSkill`，
 * 不重新决策（方案约束 6）。
 * - **纯函数**：Resolver 不读 DB、不读完整 `SKILL.md`；resume 数据由调用方加载后传入。
 * - 关键词匹配复用 `lib/skill/matcher` 的 `pickBestSkill`（降级为 resolver 内部工具）。
 *
 * 本模块是纯函数 + 类型定义，无副作用，便于单测。
 */

import { type MatchableSkill, buildMatchText, pickBestSkill } from "@/lib/skill/matcher";
import type { SkillSummary } from "@/lib/skill/provider";

/** Skill 在本轮 run 中的角色（第一轮只实现 primary）。 */
export type SkillRole = "primary" | "supporting";

/** 选择的来源：resolver（本轮决策）/ resume（沿用原 run）/ system_policy（平台策略）。 */
export type SkillSelectionSource = "resolver" | "resume" | "system_policy";

/** 本轮实际选中的 SkillVersion（方案 §五.3）。 */
export interface SelectedSkillVersion {
  skillId: string;
  skillVersionId: string;
  role: SkillRole;
  source: SkillSelectionSource;
  /** 简短解释，供审计和 Studio 展示。 */
  reason: string;
  /** 版本内容 hash，便于版本可追溯。 */
  contentHash: string | null;
}

/** Resolver 输出（方案 §五.3）。 */
export interface SkillResolverOutput {
  /** 本轮实际使用的 SkillVersion，允许空数组（基础 agent）。 */
  selectedSkillVersions: SelectedSkillVersion[];
  /** 本轮决策的整体理由。 */
  decisionReason: string;
  /** 用户选了但本轮未采用的 skillId（如已下线、权限外）。 */
  ignoredUiSelectedSkillIds: string[];
}

/** 本轮用户消息摘要（文本 + 附件文件名）。 */
export interface UserMessageInput {
  text: string;
  attachmentFilenames?: string[];
}

/** Resolver 输入（方案 §五.2）。 */
export interface SkillResolverInput {
  threadId: string;
  runId: string;
  /** 本轮用户消息文本和附件摘要。 */
  userMessage: UserMessageInput;
  /** UI 当前选择，允许空数组、单选、多选。 */
  uiSelectedSkillIds: string[];
  /** 企业 Skill 平台 / 本地 Provider 返回的可用 Skill 摘要（唯一候选集合）。 */
  availableSkills: SkillSummary[];
  /** 恢复未完成 run 时传入，用于沿用原 SkillVersion。 */
  resumeFromRunId?: string;
  /**
   * 调用方从原 run 加载的 `ThreadRunSkill` 选择（resume 路径）。
   * Resolver 保持纯函数：不在内部读 DB，由 chat route 在阶段 3 加载后传入。
   * 仅当 `resumeFromRunId` 存在时生效。
   */
  resumedSkillVersions?: SelectedSkillVersion[];
}

/**
 * 为本轮 run 解析应使用的 Skill（纯函数）。
 *
 * 决策顺序：
 * 1. **resume**：`resumeFromRunId` 存在 → 沿用 `resumedSkillVersions`（无则基础 agent），
 * 忽略本轮 UI 选择（恢复场景必须沿用原版本，不重新决策）。
 * 2. **UI 选择**：非空 → 采纳 `availableSkills` 中存在的选择；全部失效则降级到自动匹配。
 * 3. **自动匹配**：无 UI 选择（或全部失效）→ 对 `modelInvocable` skill 做关键词匹配。
 * 4. **无匹配**：返回空数组 → 基础 agent（不回退默认 skill）。
 */
export function resolveSkillForRun(input: SkillResolverInput): SkillResolverOutput {
  // 1. resume：沿用原 run 的 SkillVersion
  if (input.resumeFromRunId) {
    const resumed = input.resumedSkillVersions ?? [];
    if (resumed.length > 0) {
      return {
        selectedSkillVersions: resumed.map((v) => ({ ...v, source: "resume" })),
        decisionReason: `resume_from_run:${input.resumeFromRunId}（沿用原 SkillVersion）`,
        // resume 时忽略本轮 UI 选择：恢复必须沿用原版本，不重新决策
        ignoredUiSelectedSkillIds: input.uiSelectedSkillIds,
      };
    }
    return {
      selectedSkillVersions: [],
      decisionReason: `resume_from_run:${input.resumeFromRunId}（原 run 无 Skill，基础 agent）`,
      ignoredUiSelectedSkillIds: input.uiSelectedSkillIds,
    };
  }

  const ignoredFromUi: string[] = [];

  // 2. UI 选择：本轮用户显式选择，作为强信号
  if (input.uiSelectedSkillIds.length > 0) {
    const selected: SelectedSkillVersion[] = [];
    for (const id of input.uiSelectedSkillIds) {
      const sum = input.availableSkills.find((s) => s.skillId === id);
      if (!sum) {
        // 已下线 / 权限外 / 不在候选集 → 忽略
        ignoredFromUi.push(id);
        continue;
      }
      selected.push({
        skillId: sum.skillId,
        skillVersionId: sum.skillVersionId,
        role: "primary",
        source: "resolver",
        reason: "ui_selected",
        contentHash: sum.contentHash,
      });
    }
    if (selected.length > 0) {
      return {
        selectedSkillVersions: selected,
        decisionReason: `ui_selected（采纳 ${selected.length}，忽略 ${ignoredFromUi.length}）`,
        ignoredUiSelectedSkillIds: ignoredFromUi,
      };
    }
    // UI 选择全部失效 → 降级到自动匹配（ignoredFromUi 已记录，继续向下）
  }

  // 3. 自动匹配：对 modelInvocable=true 的 skill 做关键词匹配
  const matchableSummaries = input.availableSkills.filter((s) => s.modelInvocable);
  const candidates: MatchableSkill[] = matchableSummaries.map((s) => ({
    id: s.skillId,
    name: s.name,
    // whenToUse 是“使用条件”，更适合匹配；缺失时回退 description
    keywordSource: s.whenToUse || s.description,
  }));
  const matchText = buildMatchText({
    text: input.userMessage.text,
    attachmentFilenames: input.userMessage.attachmentFilenames,
  });
  const matched = pickBestSkill(matchText, candidates);
  if (matched) {
    const sum = matchableSummaries.find((s) => s.skillId === matched.id);
    if (sum) {
      return {
        selectedSkillVersions: [
          {
            skillId: sum.skillId,
            skillVersionId: sum.skillVersionId,
            role: "primary",
            source: "resolver",
            reason: "keyword_matched",
            contentHash: sum.contentHash,
          },
        ],
        decisionReason: `keyword_matched:${sum.name}`,
        ignoredUiSelectedSkillIds: ignoredFromUi,
      };
    }
  }

  // 4. 无匹配：基础 agent（不回退默认 skill）
  return {
    selectedSkillVersions: [],
    decisionReason: "no_skill_matched（基础 agent）",
    ignoredUiSelectedSkillIds: ignoredFromUi,
  };
}
