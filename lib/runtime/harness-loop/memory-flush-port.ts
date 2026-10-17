/**
 * 记忆 flush 端口的生产实现（M1 的 runtime 挂点）。
 *
 * 职责：在 turn 收口时决定**是否**沉淀记忆（压缩前 flush 策略），并在需要时调用
 * 提取管线（memory-extraction）。
 *
 * 触发策略（对标 OpenClaw memoryFlush）：
 * - 估算本轮上下文 token；越过 `shouldFlushBeforeCompaction` 的触发线才 flush。
 * - 幂等由提取批次（sourceRangesHash）保证；同一 turn 重复调用不会重复提取。
 *
 * 边界：
 * - 失败静默（记忆是增强能力，不是关键路径）——由 Loop 侧 try/catch 兜底。
 * - 不在此实现 token 估算的"精确"逻辑：用 view 的客观尺寸（objective + 历史）近似；
 *   真正的压缩决策仍由上下文组装层负责。
 */
import { aiConfig, contextConfig } from "@/lib/config";
import { extractMemoryFromTranscript } from "@/lib/context/memory-extraction";
import { shouldFlushBeforeCompaction } from "@/lib/context/memory-extraction";
import type { HarnessLoopView, HarnessMemoryFlushPort } from "@/lib/runtime/harness-loop/loop";

/** 粗略 token 估算：4 字符 ≈ 1 token（与 fragment 估算一致口径）。 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 从 Loop 视图重建"待提取对话文本"。
 *
 * 取 objective + 各行动观测摘要——这些是本轮真实发生的内容；
 * 完整回合文本由调用方（装配处）在更上层拼接时补充。
 */
function transcriptFromView(view: HarnessLoopView): string {
  const lines: string[] = [`用户目标：${view.objective}`];
  return lines.join("\n");
}

/**
 * 创建记忆 flush 端口。
 *
 * @param deps 提供 modelRef 与可注入的估算器/文本构造器
 */
export function createMemoryFlushPort(deps: {
  /** 提取模型引用（缺省用 chatModel）。 */
  modelRef?: string;
  /** 当前会话上下文窗口 tokens（缺省用 128k 保守值）。 */
  contextWindowTokens?: number;
  /**
   * 当前上下文**真实占用** tokens 的估算器（由上下文装配层提供，最准确）。
   * 缺省回退到 view 客观尺寸近似（objective + 序列化视图）——此时通常不会触发，
   * 属保守安全默认（宁可不 flush，也不无谓调用 LLM）。
   */
  contextTokenEstimator?: (view: HarnessLoopView) => number;
  /** 精确的待提取文本（可选）；缺省由 view 近似。 */
  transcriptBuilder?: (view: HarnessLoopView) => string;
}): HarnessMemoryFlushPort {
  const contextWindow = deps.contextWindowTokens ?? 128_000;

  return {
    async flush(view: HarnessLoopView): Promise<void> {
      // 1. 估算当前上下文占用，判断是否越过 flush 触发线
      const estimated = deps.contextTokenEstimator
        ? deps.contextTokenEstimator(view)
        : estimateTokens(JSON.stringify(view));

      // 未接近压缩 → 不 flush，避免无谓的 LLM 调用（成本红线）
      if (!shouldFlushBeforeCompaction(estimated, contextWindow)) {
        return;
      }

      // 2. 越过触发线：执行提取（幂等由 sourceRangesHash 保证）
      const { invocationId } = view.invocation;
      const threadId = "threadId" in view.invocation ? view.invocation.threadId : null;
      const tenantId = view.invocation.tenantId;
      // 以 invocation + 触发为幂等范围（同 invocation 只提取一次）
      const sourceRangesHash = `sha256:flush:${invocationId}`;
      const transcript = (deps.transcriptBuilder ?? transcriptFromView)(view);

      await extractMemoryFromTranscript({
        tenantId,
        invocationId,
        threadId,
        trigger: "pre_compaction",
        transcript,
        sourceRangesHash,
        modelRef: deps.modelRef ?? aiConfig.chatModel,
      });
    },
  };
}

/** 供调用方查询当前 flush 配置（便于测试与可观测）。 */
export function memoryFlushConfigSnapshot(): {
  reserveTokens: number;
  softThresholdTokens: number;
} {
  return {
    reserveTokens: contextConfig.flushReserveTokens,
    softThresholdTokens: contextConfig.flushSoftThresholdTokens,
  };
}
