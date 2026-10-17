import { capmAuthHeaders } from "@/lib/capability-market/auth";
/**
 * MCP 执行器（capm 代理路径）。
 *
 * 2026-10-17 定稿（用户拍板 A 方案）：nexharness **不直连远端 MCP**，而是经
 * capability-market 的 MCP 网关执行——`POST {capm}/mcp/call/:toolName`。
 * 远端 MCP 的连接与凭证由 capm 持有；nexharness 侧只带**用户 token**（统一鉴权，
 * 见 lib/capability-market/auth）。
 *
 * - endpoint：来自 execution binding 的 `endpointRef`，约定为 **capm API base**
 *   （如 http://localhost:3000/api）；执行器在此追加 `/mcp/call/:toolName`。
 * - toolName：由 invocation 的 ToolCall.operationId 提供（providerOperationMetadata 不含
 *   运行时工具名，操作是调用时才有）。
 * - 语义：协议级错误 → 4xx（映射 permanent）；capm 返回 `{is_error:true}` → 业务失败。
 *
 * 失败分类（对齐 ProviderExecutionError）：
 * - 网络/超时 → safe_transient（可安全重试）；超时态不明 → unknown_effect。
 * - 4xx（参数/未知工具）→ permanent。
 * - 5xx / 429 → 5xx 视为 unknown_effect（写操作可能已产生副作用）。
 */
import {
  type ProductionProviderExecutor,
  ProviderExecutionError,
  readLimitedBody,
} from "@/lib/capability/provider-execution";
import { capabilityMarketConfig } from "@/lib/config";

/** capm 网关调用路径（在 endpoint 后追加）。 */
function mcpCallUrl(capmBase: string, toolName: string): string {
  const base = capmBase.replace(/\/+$/, "");
  return `${base}/mcp/call/${encodeURIComponent(toolName)}`;
}

export function createMcpExecutor(): ProductionProviderExecutor {
  return {
    async execute(input) {
      const toolName = input.operationId?.trim();
      if (!toolName) {
        throw new ProviderExecutionError(
          "PROVIDER_OPERATION_MISSING",
          "MCP 执行缺少 operationId（远端工具名）",
          "permanent",
          true,
        );
      }
      if (!input.endpoint) {
        throw new ProviderExecutionError(
          "PROVIDER_ENDPOINT_MISSING",
          "MCP 执行缺少 capm endpoint（connection.endpointRef）",
          "permanent",
          true,
        );
      }

      let auth: { authorization: string };
      try {
        // 优先请求作用域用户 token；兜底 env（联调后删）
        auth = capmAuthHeaders(capabilityMarketConfig.token);
      } catch (error) {
        throw new ProviderExecutionError(
          "PROVIDER_CREDENTIAL_UNAVAILABLE",
          error instanceof Error ? error.message : "capm 鉴权不可用",
          "permanent",
          true,
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      let response: Response;
      try {
        response = await fetch(mcpCallUrl(input.endpoint, toolName), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: auth.authorization,
            ...(input.externalIdempotencyKey
              ? { "idempotency-key": input.externalIdempotencyKey }
              : {}),
          },
          body: JSON.stringify(input.arguments),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        const aborted = controller.signal.aborted;
        clearTimeout(timer);
        throw new ProviderExecutionError(
          aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR",
          aborted ? "capm MCP 网关响应超时" : "capm MCP 网关网络错误",
          canRetrySafely(input) ? "safe_transient" : "unknown_effect",
          true,
        );
      }

      // 4xx（未知工具/参数非法，429 除外）→ permanent
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        await response.body?.cancel();
        clearTimeout(timer);
        throw new ProviderExecutionError(
          `PROVIDER_HTTP_${response.status}`,
          `capm MCP 网关拒绝请求（HTTP ${response.status}）`,
          "permanent",
          true,
        );
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        clearTimeout(timer);
        throw new ProviderExecutionError(
          `PROVIDER_HTTP_${response.status}`,
          `capm MCP 网关暂时不可用（HTTP ${response.status}）`,
          canRetrySafely(input) ? "safe_transient" : "unknown_effect",
          true,
        );
      }

      let body: unknown;
      try {
        body = await readLimitedBody(response, input.responseMaxBytes);
      } catch (error) {
        if (error instanceof ProviderExecutionError) throw error;
        const aborted = controller.signal.aborted;
        throw new ProviderExecutionError(
          aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_RESPONSE_READ_FAILED",
          aborted ? "capm MCP 网关响应超时" : "capm MCP 网关响应读取失败",
          canRetrySafely(input) ? "safe_transient" : "unknown_effect",
          true,
        );
      } finally {
        clearTimeout(timer);
      }

      // capm 语义：协议成功 200 + { is_error, result?, message? }
      const envelope = asRecord(body);
      if (envelope.is_error === true) {
        throw new ProviderExecutionError(
          "PROVIDER_MCP_TOOL_ERROR",
          typeof envelope.message === "string" ? envelope.message : "MCP 工具返回业务错误",
          canRetrySafely(input) ? "safe_transient" : "unknown_effect",
          true,
        );
      }
      return {
        status: "succeeded",
        statusCode: response.status,
        result: envelope.result ?? null,
        providerRequestRef: response.headers.get("x-request-id"),
      };
    },
  };
}

/** 只读/幂等操作可安全重试；写操作结果未知，不自动重试。 */
function canRetrySafely(input: { sideEffectMode: "none" | "read" | "write" }): boolean {
  return input.sideEffectMode === "none" || input.sideEffectMode === "read";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
