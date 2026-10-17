/**
 * MCP 执行器（capm 市场路径）。
 *
 * 2026-10-17 定稿（用户拍板）：**市场来源能力的执行归 capm**——MCP 由
 * capability-market 的 MCP 网关执行（`POST {capm}/mcp/call/:toolName`）。
 * 远端 MCP 的连接与凭证由 capm 持有（capm 侧 auth_ref 引用环境变量名，凭证不跨服务）；
 * nexharness 侧只带统一鉴权的用户 token，并保留编排治理（审批/幂等/对账/重试）。
 *
 * - endpoint = binding.endpointRef，约定为 **capm API base**；
 * - toolName = ToolCall.operationId。
 */
import { callCapmMarket } from "@/lib/capability/capm-market-call";
import type {
  ProductionProviderExecutor,
  ProviderExecutionInput,
  ProviderExecutionResult,
} from "@/lib/capability/provider-execution";

export function createMcpExecutor(): ProductionProviderExecutor {
  return {
    async execute(input: ProviderExecutionInput): Promise<ProviderExecutionResult> {
      return callCapmMarket({
        capmBase: input.endpoint,
        segment: "mcp",
        name: input.operationId ?? "",
        arguments: input.arguments,
        timeoutMs: input.timeoutMs,
        responseMaxBytes: input.responseMaxBytes,
        sideEffectMode: input.sideEffectMode,
        externalIdempotencyKey: input.externalIdempotencyKey,
        label: "MCP 网关",
      });
    },
  };
}
