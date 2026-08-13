import { randomUUID } from "node:crypto";
import { estimateTokens } from "@/lib/context/budget-estimation";
import { type ContextPackage, buildContextPackage } from "@/lib/context/package-builder";
import type { SubagentDefinition, ThreadPlan, ThreadPlanItem, ToolRun } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";

/**
 * Stage B：子代理 scoped context package 派生。
 *
 * 命门（计划执行规矩 §3）：**子代理不看父历史**。本函数只构造裁剪后的合成消息
 *（goal + contextHints + 相关 snippet + 可选 plan 片段 / 工具证据），**不传父 Message 表
 * 原始历史**。复用 a buildContextPackage，裁剪在 input 层，builder 零改动。
 *
 * includeHistory=true 时，调用方应传入已裁剪的父历史摘要（字符串）或最近合成消息，
 * 本函数只负责将其注入合成上下文，不直接读取父 Message 表。
 *
 * 为什么 tokenBudget=Infinity：buildContextPackage 在触发压缩时会向 input.threadId 的
 * ContextSummary 表写摘要行。子代理上下文是预裁剪的合成消息（短），无需 a 压缩；
 * 用 Infinity 走 builder 零回归直通路径（不触发压缩、不落库），避免把子代理合成历史的
 * 摘要写进父 thread 的 ContextSummary 表污染父上下文。预裁剪（maxSnippets）在 input 层完成。
 */

/** 子代理上下文裁剪策略（与 SubagentDefinition.contextPolicy 同形）。 */
export type SubagentContextPolicy = {
  /** 是否包含父历史——默认 false（命门：子代理不看父历史）。 */
  includeHistory?: boolean;
  /** 是否包含父 active plan 的 scoped 片段。 */
  includePlan?: boolean;
  /** 是否包含最近工具证据 snippet。 */
  includeToolEvidence?: boolean;
  /** 注入的最大 snippet 条数。 */
  maxSnippets?: number;
  /** includeHistory=true 时最多取最近多少条父消息做摘要（默认 10）。 */
  maxHistoryMessages?: number;
};

export type BuildSubagentContextArgs = {
  parentThreadId: string;
  goal: string;
  /** 父给子代理的上下文提示（相关路径/约束/已知信息）。 */
  contextHints?: string[];
  definition: SubagentDefinition;
  /** 父当前 active plan（includePlan 时取其条目片段）。 */
  activePlan?: ThreadPlan | null;
  planItems?: ThreadPlanItem[];
  /** 父最近工具证据（includeToolEvidence 时按 maxSnippets 裁剪后注入）。 */
  recentToolEvidence?: ToolRun[];
  /** 父历史摘要（includeHistory 时注入）。必须已裁剪/脱敏，非原始 Message 表。 */
  parentHistorySummary?: string;
  model: string;
};

/** 从父工具证据提取可读 snippet 文本（命令/路径/退出码摘要）。 */
function toolEvidenceSnippet(tr: ToolRun): string {
  const input = (tr.input ?? {}) as Record<string, unknown>;
  const parts: string[] = [`[${tr.toolName}]`];
  if (typeof input.path === "string") parts.push(`path=${input.path}`);
  if (typeof input.command === "string") parts.push(`cmd=${input.command}`);
  if (tr.status === "failed") parts.push("失败");
  return parts.join(" ");
}

/**
 * 构造子代理上下文包。返回的 messages 只含合成消息，不含父 Message 表原始历史。
 */
export async function buildSubagentContextPackage(
  args: BuildSubagentContextArgs,
): Promise<ContextPackage> {
  const policy = (args.definition.contextPolicy ?? {}) as SubagentContextPolicy;
  const maxSnippets = policy.maxSnippets ?? 5;

  const sections: string[] = [];
  sections.push(`# 子代理目标\n${args.goal}`);

  if (args.contextHints && args.contextHints.length > 0) {
    sections.push(`# 上下文提示\n${args.contextHints.map((h) => `- ${h}`).join("\n")}`);
  }

  if (policy.includePlan && args.activePlan) {
    const items = (args.planItems ?? []).map((it) => `- [${it.status}] ${it.title}`).join("\n");
    sections.push(`# 父计划片段（${args.activePlan.title}）\n${items || "(无条目)"}`);
  }

  if (policy.includeToolEvidence && args.recentToolEvidence && args.recentToolEvidence.length > 0) {
    const snippets = args.recentToolEvidence.slice(0, maxSnippets).map(toolEvidenceSnippet);
    sections.push(
      `# 相关工具证据（最近 ${snippets.length} 条）\n${snippets.map((s) => `- ${s}`).join("\n")}`,
    );
  }

  if (policy.includeHistory && args.parentHistorySummary) {
    sections.push(`# 父历史摘要（已裁剪/脱敏）\n${args.parentHistorySummary}`);
  }

  // 命门：history 只含这一条合成 user 消息，绝不包含父 Message 表原始消息。
  // includeHistory 默认 false；即便 true，也依赖调用方传入已裁剪摘要（本函数不接受父原始历史入参）。
  // token 限流。原 tokenBudget=Infinity 无上限，长 goal/多 snippet 可能把子代理
  // 上下文撑大。这里在 input 层预裁剪：超 SUBAGENT_CONTEXT_TOKEN_BUDGET 时优先丢 toolEvidence/plan
  // 段（保留 goal + hints 核心）。仍用 Infinity 传 builder（不触发压缩、不向父 ContextSummary 落库）。
  const SUBAGENT_CONTEXT_TOKEN_BUDGET = 16_000;
  let body = sections.join("\n\n");
  if (estimateTokens(body) > SUBAGENT_CONTEXT_TOKEN_BUDGET) {
    // 逐步丢弃非核心段（toolEvidence → plan → history summary），直到达标或只剩 goal+hints
    const dropOrder = ["# 相关工具证据", "# 父计划片段", "# 父历史摘要"];
    for (const marker of dropOrder) {
      if (estimateTokens(body) <= SUBAGENT_CONTEXT_TOKEN_BUDGET) break;
      const idx = body.indexOf(marker);
      if (idx >= 0) {
        const nextSection = body.indexOf("\n# ", idx + 1);
        body =
          nextSection >= 0 ? body.slice(0, idx) + body.slice(nextSection + 1) : body.slice(0, idx);
      }
    }
    // 仍超标 → 硬截断
    if (estimateTokens(body) > SUBAGENT_CONTEXT_TOKEN_BUDGET) {
      body = `${body.slice(0, SUBAGENT_CONTEXT_TOKEN_BUDGET * 3)}\n\n[...子代理上下文超 token 预算，已截断...]`;
    }
  }
  const syntheticHistory: ChatMessage[] = [
    {
      id: randomUUID(),
      role: "user",
      parts: [{ type: "text", text: body }],
      createdAt: new Date(),
    } as unknown as ChatMessage,
  ];

  // Infinity tokenBudget → builder 零回归直通路径，不触发压缩、不向父 ContextSummary 表落库。
  return buildContextPackage({
    threadId: args.parentThreadId,
    model: args.model,
    history: syntheticHistory,
    tokenBudget: Number.POSITIVE_INFINITY,
    // 不传 toolRuns / planEvents / statusChanges / threadStatus / memories → 不触发任何压缩路径
  });
}
