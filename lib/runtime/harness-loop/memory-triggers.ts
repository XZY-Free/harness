/**
 * 记忆 flush + 会话压缩的**运行时挂点**（② + ③ 的真实触发）。
 *
 * 触发位置：`POST /gateway/context/query` 完成上下文装配之后——此处
 * `ContextView.tokenAccounting.inputTokens` 是**当前上下文真实占用**，
 * 是判断「是否接近压缩」「是否该沉淀记忆」最准确的信号。
 *
 * 职责：
 * 1. 越过 flush 触发线 → 沉淀记忆（memory-extraction，压缩前 flush）。
 * 2. 越过压缩阈值 → 生成 compression checkpoint（memory-compaction）。
 * 3. 两者都**幂等**（同 invocation 同触发只跑一次）且**失败不阻断**上下文返回。
 *
 * 成本红线（用户定）：两者都只在越阈值时才调用 LLM；默认配置下小会话永不触发。
 */
import { aiConfig, contextConfig } from "@/lib/config";
import { compactConversation, shouldCompactContext } from "@/lib/context/memory-compaction";
import { extractMemoryFromTranscript } from "@/lib/context/memory-extraction";
import { shouldFlushBeforeCompaction } from "@/lib/context/memory-extraction";
import { listRecentContextItemsByThread } from "@/lib/conversations/thread-item-queries";
import { logger } from "@/lib/logger";

export interface MemoryTriggerOutcome {
  flushed: boolean;
  compacted: boolean;
  /** 跳过原因（可观测）。 */
  reason?: string;
}

/**
 * 组装后的触发：按真实 token 占用决定 flush / 压缩。
 *
 * @param input.tenantId / invocationId / threadId 主体
 * @param input.inputTokens 当前上下文真实占用（ContextView.tokenAccounting.inputTokens）
 * @param input.model 当前模型（窗口经 resolveTokenBudget 解析 per-model 配置）
 * @param input.transcript 待提取对话文本（调用方从 thread items 取）
 * @param input.modelRef 提取/压缩模型
 */
export async function runMemoryTriggers(input: {
  tenantId: string;
  invocationId: string;
  threadId: string | null;
  inputTokens: number;
  /** 当前模型（窗口经 `NEX_CONTEXT_WINDOWS` 解析；缺省 aiConfig.chatModel）。 */
  model?: string;
  /** 显式窗口覆盖（测试用；缺省按模型配置解析）。 */
  contextWindowOverride?: number;
  transcript: string;
  retainedSummary?: string;
  modelRef?: string;
  /** 测试注入：覆盖 flush 端口（缺省用真实提取）。 */
  flushOverride?: () => Promise<void>;
  /** 测试注入：覆盖压缩端口。 */
  compactOverride?: () => Promise<void>;
}): Promise<MemoryTriggerOutcome> {
  const model = input.model ?? aiConfig.chatModel;
  const outcome: MemoryTriggerOutcome = { flushed: false, compacted: false };

  // ── 1. flush 优先：压缩前**先抢救记忆**（对标 OpenClaw memoryFlush 的时序）──
  // 语义：一旦接近/到达压缩线，先把可跨会话复用的记忆沉淀下来，再压缩，
  // 否则压缩会把这段历史摘掉、细节永久丢失。
  if (shouldFlushBeforeCompaction(input.inputTokens, model, input.contextWindowOverride)) {
    try {
      if (input.flushOverride) {
        await input.flushOverride();
      } else {
        await extractMemoryFromTranscript({
          tenantId: input.tenantId,
          invocationId: input.invocationId,
          threadId: input.threadId,
          trigger: "pre_compaction",
          transcript: input.transcript,
          sourceRangesHash: `sha256:flush:${input.invocationId}`,
          modelRef: input.modelRef,
        });
      }
      outcome.flushed = true;
    } catch (err) {
      logger.warn(
        `[memory-trigger] flush 失败（不阻断）：${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ── 2. 压缩：先落实记忆再压缩历史 ──
  if (shouldCompactContext(input.inputTokens, model, input.contextWindowOverride)) {
    try {
      if (input.compactOverride) {
        await input.compactOverride();
      } else {
        await compactConversation(
          {
            tenantId: input.tenantId,
            invocationId: input.invocationId,
            history: input.transcript,
            retainedSummary: input.retainedSummary ?? "",
            sourceRanges: [
              { type: "thread_item", fromSequence: 0, toSequence: null, rangeHash: "sha256:auto" },
            ],
            tokenAccounting: {
              input: input.inputTokens,
              retained: Math.round(input.inputTokens * 0.2),
            },
          },
          { modelRef: input.modelRef },
        );
      }
      outcome.compacted = true;
    } catch (err) {
      logger.warn(
        `[memory-trigger] 压缩失败（不阻断）：${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (!outcome.flushed && !outcome.compacted) {
    outcome.reason = "below_thresholds";
  }

  return outcome;
}

/**
 * 从 Thread 取最近若干条 item 拼成待提取/压缩文本。
 *
 * 供 context/query 路由调用（需要 threadId）。
 */
export async function buildTranscriptFromThread(
  tenantId: string,
  threadId: string,
  limit = 30,
): Promise<string> {
  const items = await listRecentContextItemsByThread(tenantId, threadId, { limit });
  return items
    .map((it) => {
      const c = it.contentJson as Record<string, unknown> | null;
      const text =
        c && typeof c.text === "string"
          ? c.text
          : c && typeof c.content === "string"
            ? c.content
            : "";
      return text ? `${it.authorType}/${it.itemType}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** 触发阈值快照（可观测）。 */
export function memoryTriggerConfigSnapshot(): {
  flushReserveTokens: number;
  flushSoftThresholdTokens: number;
  budgetThreshold: number;
} {
  return {
    flushReserveTokens: contextConfig.flushReserveTokens,
    flushSoftThresholdTokens: contextConfig.flushSoftThresholdTokens,
    budgetThreshold: contextConfig.budgetThreshold,
  };
}
