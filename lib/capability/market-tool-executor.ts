/**
 * 市场 Tool 执行器（capm 能力市场路径）。
 *
 * 2026-10-17 定稿（用户拍板）：capm 作为能力市场，**工具执行也在 capm**——
 * `POST {capm}/tools/call/:toolKey`（capm 侧解包 tool 包并按 runtime 执行）。
 * nexharness 侧只带统一鉴权用户 token，保留编排治理。
 *
 * 注意：nexharness 自有的 builtin / webhook 能力**不经此路径**（它们不是市场能力，
 * 由 nexharness 本地执行器承载）；本执行器只服务从 capm 同步来的 tool。
 *
 * - endpoint = binding.endpointRef，约定为 **capm API base**；
 * - toolKey = ToolCall.operationId（= capm 的 tool_key）。
 */
import { callCapmMarket } from "@/lib/capability/capm-market-call";
import type {
  ProductionProviderExecutor,
  ProviderExecutionInput,
  ProviderExecutionResult,
} from "@/lib/capability/provider-execution";

export function createMarketToolExecutor(): ProductionProviderExecutor {
  return {
    async execute(input: ProviderExecutionInput): Promise<ProviderExecutionResult> {
      // capm /tools/call/:toolKey 按 asset name 解析（同步时冻结进 capmToolName）
      const capmToolKey =
        typeof input.operationMetadata?.capmToolName === "string"
          ? (input.operationMetadata.capmToolName as string)
          : (input.operationId ?? "");
      return callCapmMarket({
        capmBase: input.endpoint,
        segment: "tools",
        name: capmToolKey,
        arguments: input.arguments,
        timeoutMs: input.timeoutMs,
        responseMaxBytes: input.responseMaxBytes,
        sideEffectMode: input.sideEffectMode,
        externalIdempotencyKey: input.externalIdempotencyKey,
        label: "市场工具",
      });
    },
  };
}
