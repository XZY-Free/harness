import { getChatModel } from "@/lib/ai/provider";
/**
 * 会话压缩产出方（③ M6）。
 *
 * 背景：`contextCheckpoint`（checkpointType=compression）**有消费方**（initial-checkpoint-source
 * 把压缩摘要作为 Invocation 初始压缩材料），但**无产出方**——压缩点从未生成，
 * 长会话只能靠预算裁剪（selectFragmentsByBudget）硬丢历史。
 *
 * 本模块补齐产出侧：会话积压越过预算阈值时，用 LLM 把较早历史压成结构化摘要
 * （保留目标/约束/决定/状态，去除重复日志与无意义进度），落为 compression checkpoint。
 *
 * 对标：
 * - Claude Code /compact：保留架构决定与未决问题，丢弃冗余工具输出。
 * - Codex compact_prompt：**保留用户约束与禁止项、当前任务状态、关键决定及理由**。
 * - Constraint Pinning：约束类内容不参与压缩（由 selectFragmentsByBudget 的
 *   TIER_MANDATORY 保证——本模块只压缩**对话历史**）。
 *
 * 成本：压缩是低频事件（会话级，通常一次），单次 LLM 调用；模型端口可注入（测试用 mock）。
 */
import { aiConfig, contextConfig } from "@/lib/config";
import {
  computeSourceRangesHash,
  computeSummaryHash,
  createContextCheckpoint,
} from "@/lib/context/checkpoint-queries";
import type { SourceRange } from "@/lib/persistence/schema/context-checkpoint";
import { generateText } from "ai";
import { z } from "zod";

/** 压缩输入：一段对话历史（已按时间序）。 */
export interface CompactionInput {
  tenantId: string;
  invocationId: string;
  /** 待压缩的较早历史（原文）。 */
  history: string;
  /** 保留原文的最近 N 条（不参与压缩）。 */
  retainedSummary: string;
  /** 来源消息范围（用于 checkpoint 溯源与幂等）。 */
  sourceRanges: SourceRange[];
  /** 估算 token。 */
  tokenAccounting: { input: number; retained: number };
}

/** 压缩结果。 */
export interface CompactionResult {
  checkpointId: string;
  summary: string;
  compressedTokens: number;
}

/**
 * 是否应触发压缩（对标 Codex 60% 早触发 + 本仓三级阈值）。
 *
 * @param estimatedTokens 当前上下文估算
 * @param contextWindowTokens 模型窗口
 */
export function shouldCompactContext(
  estimatedTokens: number,
  contextWindowTokens: number,
): boolean {
  return estimatedTokens >= contextWindowTokens * contextConfig.budgetThreshold;
}

/** 压缩摘要模型端口（可注入 mock，守成本红线）。 */
export interface CompactionModelPort {
  summarize(input: { history: string; retainedSummary: string }): Promise<string>;
}

/** 真实模型：结构化压缩提示（对标 Codex compact_prompt / Claude Code Compact Instructions）。 */
export function configuredCompactionPort(modelRef: string): CompactionModelPort {
  return {
    async summarize(input) {
      if (!aiConfig.apiKey) throw new Error("LLM_API_KEY 未配置");
      const { text } = await generateText({
        model: getChatModel(modelRef),
        prompt: [
          "把下面这段较早的对话历史压缩成一份**结构化摘要**，供后续回合继续工作时使用。",
          "**必须保留**：",
          "1. 当前任务目标与验收标准；",
          "2. 用户明确给出的约束与禁止项（逐条保留，不得改写或省略）；",
          "3. 已做的关键决定及其理由；",
          "4. 未解决的问题、失败的尝试与精确错误信息；",
          "5. 已读写/修改的文件路径或资源引用。",
          "**应当丢弃**：冗余的工具输出、重复的探索性读取、已解决的子任务细节、无意义的进度日志。",
          "用简洁条目输出，不要复述整段对话。",
          `\\n【较早历史】\\n${input.history}`,
          `\\n【最近的保留内容（仅作上下文，不重复摘要）】\\n${input.retainedSummary}`,
        ].join("\\n"),
      });
      return text.trim();
    },
  };
}

/**
 * 执行一次会话压缩：生成摘要 → 落 compression checkpoint。
 *
 * @returns 压缩结果（含 checkpointId）；摘要为空则抛错（不落空 checkpoint）。
 */
export async function compactConversation(
  input: CompactionInput,
  deps: { modelPort?: CompactionModelPort; modelRef?: string } = {},
): Promise<CompactionResult> {
  const port = deps.modelPort ?? configuredCompactionPort(deps.modelRef ?? aiConfig.chatModel);
  const summary = await port.summarize({
    history: input.history,
    retainedSummary: input.retainedSummary,
  });
  if (!summary) throw new Error("压缩摘要为空，拒绝落空 checkpoint");

  const summaryHash = computeSummaryHash(summary);
  const compressedTokens = Math.max(
    0,
    input.tokenAccounting.input - input.tokenAccounting.retained,
  );
  const checkpoint = await createContextCheckpoint({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    checkpointType: "compression",
    sourceRanges: input.sourceRanges,
    summaryRedacted: summary,
    summaryHash,
    tokenAccounting: {
      input: input.tokenAccounting.input,
      retained: input.tokenAccounting.retained,
      compressed: compressedTokens,
    },
  });
  return { checkpointId: checkpoint.id, summary, compressedTokens };
}

/** 供测试/可观测的压缩配置快照。 */
export function compactionConfigSnapshot(): { budgetThreshold: number } {
  return { budgetThreshold: contextConfig.budgetThreshold };
}

/** 校验摘要结构（保留项齐备性粗检）。 */
export const COMPACTION_SUMMARY_SCHEMA = z.object({
  goal: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  openIssues: z.array(z.string()).optional(),
  touchedPaths: z.array(z.string()).optional(),
});
