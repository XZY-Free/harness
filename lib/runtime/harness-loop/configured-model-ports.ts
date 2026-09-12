import { getChatModel } from "@/lib/ai/provider";
import { aiConfig } from "@/lib/config";
import { TRUNCATED_FINISH_REASONS, collectModelText } from "@/lib/runtime/model-text-stream";
import { generateObject, streamText } from "ai";
import { z } from "zod";
import { HARNESS_NEXT_ACTION_SCHEMA } from "./action-schema";
import type { HarnessDecisionPort, HarnessFinalResponsePort } from "./loop";

export function configuredDecisionPort(modelRef: string): HarnessDecisionPort {
  return {
    async decideNextAction(view, abortSignal) {
      if (!aiConfig.apiKey) throw new Error("LLM_API_KEY 未配置");
      const { object } = await generateObject({
        model: getChatModel(modelRef),
        schema: HARNESS_NEXT_ACTION_SCHEMA,
        prompt: [
          "你是 SnowHarness 的行动决策器。每步只返回一个符合 Schema 的 json 对象，不输出正文或隐藏推理。",
          `必须严格匹配这份 json schema：${JSON.stringify(z.toJSONSchema(HARNESS_NEXT_ACTION_SCHEMA))}`,
          "只有 observations 足以支持回答时才返回 respond；用户 preferred Agent 只是候选，不表示必须调用。",
          JSON.stringify(view),
        ].join("\n\n"),
        abortSignal,
      });
      return object;
    },
  };
}

export function configuredFinalResponsePort(modelRef: string): HarnessFinalResponsePort {
  return {
    async generateFinalResponse(view, emitDelta, abortSignal) {
      if (!aiConfig.apiKey) throw new Error("LLM_API_KEY 未配置");
      const run = () =>
        streamText({
          model: getChatModel(modelRef),
          prompt: [
            "根据当前用户目标与已完成 observations 生成最终可见回答。不得声称执行过 actionHistory 中不存在或未 completed 的行动。",
            JSON.stringify(view),
          ].join("\n\n"),
          maxOutputTokens: aiConfig.maxOutputTokens || undefined,
          abortSignal,
        });
      let collected = await collectModelText(run().fullStream, emitDelta);
      if (TRUNCATED_FINISH_REASONS.has(collected.finishReason)) {
        // 流异常终结（截断/连接早断）：静默重试一次（不重复向 UI 发射 delta），
        // 仍异常则抛错由执行链按失败关闭，禁止把残缺正文当完整回答落库。
        collected = await collectModelText(run().fullStream);
        if (TRUNCATED_FINISH_REASONS.has(collected.finishReason)) {
          throw new Error(`模型正文异常终结(finish_reason=${collected.finishReason})`);
        }
      }
      return collected.text;
    },
  };
}
