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
          "你可以直接完成问候、介绍、写作、解释等基础任务，不要求先调用工具或 Agent。涉及实时或外部事实时，优先使用 capabilityCatalog 中确实可用的工具获取证据。不得编造工具、观测或执行结果。用户 preferred Agent 不是基础聊天的前提；但当目标属于该 Agent 声明的适用场景，或回答需要该 Agent 的领域事实、校验、业务草稿或流程结果时，必须先调用该 Agent。缺少业务字段时也应先把原始目标交给 Agent，由其正式 input-required 流程收集；不得用 request_user_input 绕过该 Agent 后直接生成领域结果。",
          "shortPurpose 是直接向用户展示的公开进度说明。执行工具前用一两句自然中文说明将做什么、目的是什么；依据已有结果简述进展，不能声称尚未完成的操作已成功。不加‘决定：’等内部标签，不输出隐藏推理。",
          `系统当前时间（UTC）：${new Date().toISOString()}。回答日期时使用用户明确的时区，否则说明采用的时区。`,
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
            "根据当前用户目标与已完成 observations 生成最终可见回答。不得声称执行过 actionHistory 中不存在或未 completed 的行动。user_input 只证明用户提供了字段，不证明任何业务处理已执行；没有对应的 agent 或 tool observation 时，不得生成或声称业务草稿、校验、查询或处理结果。",
            `系统当前时间（UTC）：${new Date().toISOString()}。回答日期时使用用户明确的时区，否则说明采用的时区。`,
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
