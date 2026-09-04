import { getChatModel } from "@/lib/ai/provider";
import { aiConfig } from "@/lib/config";
import { collectModelText } from "@/lib/runtime/model-text-stream";
import { generateObject, streamText } from "ai";
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
          "你是 SnowHarness 的行动决策器。每步只返回一个符合 Schema 的行动，不输出正文或隐藏推理。",
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
      const result = streamText({
        model: getChatModel(modelRef),
        prompt: [
          "根据当前用户目标与已完成 observations 生成最终可见回答。不得声称执行过 actionHistory 中不存在或未 completed 的行动。",
          JSON.stringify(view),
        ].join("\n\n"),
        maxOutputTokens: aiConfig.maxOutputTokens || undefined,
        abortSignal,
      });
      return collectModelText(result.fullStream, emitDelta);
    },
  };
}
