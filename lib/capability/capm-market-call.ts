import { capmAuthHeaders } from "@/lib/capability-market/auth";
/**
 * capm（capability-market）市场能力调用 helper。
 *
 * 2026-10-17 定稿（用户拍板）：**市场来源能力的执行归 capm**——
 *   nexharness 编排治理（审批 / 幂等 / 副作用对账 / 重试策略），
 *   capm 能力治理 + 执行（能不能调 + 真正调）。
 *
 * 本 helper 承载 mcp 与 tool 两类市场能力的**统一调用约定**：
 *   - 端点：`POST {capmBase}/{segment}/call/{name}`，body = arguments；
 *   - 鉴权：统一鉴权（用户 token 优先，env 兜底），见 lib/capability-market/auth；
 *   - 响应：`{ is_error: boolean, result?, message? }`（协议级错误 → 4xx）。
 *
 * 失败分类（对齐 ProviderExecutionError）：
 *   - 4xx（参数/未知）→ permanent；5xx/429 → 按 sideEffect 决定 safe_transient/unknown_effect；
 *   - 网络/超时 → 相应类别；capm {is_error:true} → 业务失败。
 */
import {
  ProviderExecutionError,
  type ProviderExecutionResult,
  readLimitedBody,
} from "@/lib/capability/provider-execution";
import { capabilityMarketConfig } from "@/lib/config";

export interface CapmMarketCallParams {
  /** capm API base（来自 execution binding 的 endpointRef）。 */
  capmBase: string;
  /** 能力类别路径段：mcp / tools。 */
  segment: string;
  /** 远端调用名（mcp 工具名 / tool key）。 */
  name: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
  responseMaxBytes: number;
  sideEffectMode: "none" | "read" | "write";
  externalIdempotencyKey: string | null;
  /** 错误码/文案标签，如 "MCP" / "市场工具"。 */
  label: string;
}

/** 只读/幂等操作可安全重试；写操作结果未知，不自动重试。 */
function canRetrySafely(input: { sideEffectMode: "none" | "read" | "write" }): boolean {
  return input.sideEffectMode === "none" || input.sideEffectMode === "read";
}

/**
 * 调用 capm 上的市场能力（mcp / tool 共用）。
 *
 * @throws ProviderExecutionError 按失败分类；成功返回 ProviderExecutionResult。
 */
export async function callCapmMarket(
  params: CapmMarketCallParams,
): Promise<ProviderExecutionResult> {
  const name = params.name.trim();
  if (!name) {
    throw new ProviderExecutionError(
      "PROVIDER_OPERATION_MISSING",
      `${params.label}调用缺少能力名`,
      "permanent",
      true,
    );
  }
  if (!params.capmBase) {
    throw new ProviderExecutionError(
      "PROVIDER_ENDPOINT_MISSING",
      `${params.label}调用缺少 capm endpoint（connection.endpointRef）`,
      "permanent",
      true,
    );
  }

  let auth: { authorization: string };
  try {
    // 优先请求作用域用户 token；兜底 env（capm 未联调 auth-center 期间；联调后删）
    auth = capmAuthHeaders(capabilityMarketConfig.token);
  } catch (error) {
    throw new ProviderExecutionError(
      "PROVIDER_CREDENTIAL_UNAVAILABLE",
      error instanceof Error ? error.message : "capm 鉴权不可用",
      "permanent",
      true,
    );
  }

  const base = params.capmBase.replace(/\/+$/, "");
  const url = `${base}/${params.segment}/call/${encodeURIComponent(name)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: auth.authorization,
        ...(params.externalIdempotencyKey
          ? { "idempotency-key": params.externalIdempotencyKey }
          : {}),
      },
      body: JSON.stringify(params.arguments),
      signal: controller.signal,
      redirect: "error",
    });
  } catch {
    const aborted = controller.signal.aborted;
    clearTimeout(timer);
    throw new ProviderExecutionError(
      aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR",
      aborted ? `capm ${params.label}响应超时` : `capm ${params.label}网络错误`,
      canRetrySafely(params) ? "safe_transient" : "unknown_effect",
      true,
    );
  }

  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    await response.body?.cancel();
    clearTimeout(timer);
    throw new ProviderExecutionError(
      `PROVIDER_HTTP_${response.status}`,
      `capm ${params.label}拒绝请求（HTTP ${response.status}）`,
      "permanent",
      true,
    );
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel();
    clearTimeout(timer);
    throw new ProviderExecutionError(
      `PROVIDER_HTTP_${response.status}`,
      `capm ${params.label}暂时不可用（HTTP ${response.status}）`,
      canRetrySafely(params) ? "safe_transient" : "unknown_effect",
      true,
    );
  }

  let body: unknown;
  try {
    body = await readLimitedBody(response, params.responseMaxBytes);
  } catch (error) {
    if (error instanceof ProviderExecutionError) throw error;
    const aborted = controller.signal.aborted;
    throw new ProviderExecutionError(
      aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_RESPONSE_READ_FAILED",
      aborted ? `capm ${params.label}响应超时` : `capm ${params.label}响应读取失败`,
      canRetrySafely(params) ? "safe_transient" : "unknown_effect",
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  const envelope = asRecord(body);
  if (envelope.is_error === true) {
    throw new ProviderExecutionError(
      "PROVIDER_MARKET_TOOL_ERROR",
      typeof envelope.message === "string" ? envelope.message : `${params.label}返回业务错误`,
      canRetrySafely(params) ? "safe_transient" : "unknown_effect",
      true,
    );
  }
  return {
    status: "succeeded",
    statusCode: response.status,
    result: envelope.result ?? null,
    providerRequestRef: response.headers.get("x-request-id"),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
