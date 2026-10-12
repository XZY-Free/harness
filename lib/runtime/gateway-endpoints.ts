import { appConfig, runtimeGatewayConfig } from "@/lib/config";
import type { CallbackEndpoints } from "@/lib/runtime/runtime-protocol";

/** Hosted Runtime 在同一进程内使用的端点标识。 */
export function buildGatewayEndpoints(params: {
  external: boolean;
  invocationId?: string;
}): CallbackEndpoints {
  if (!params.external) {
    const invocationId = params.invocationId ?? "invocation";
    return {
      events: `http://127.0.0.1/runtime/invocations/${invocationId}/events`,
      heartbeat: `http://127.0.0.1/runtime/invocations/${invocationId}/heartbeat`,
      context: "http://127.0.0.1/gateway/context",
      capabilityActions: "http://127.0.0.1/gateway/capability-actions",
      toolCalls: "http://127.0.0.1/gateway/tool-calls",
      userActions: "http://127.0.0.1/gateway/user-action-requests",
    };
  }

  const baseUrl = runtimeGatewayConfig.publicBaseUrl;
  if (!baseUrl) {
    // Test/development 没有反向代理时仍给出可预测的本地地址；生产必须显式配置。
    if (!appConfig.isProd) {
      return buildExternalGatewayEndpoints(
        `http://127.0.0.1:${appConfig.port}`,
        params.invocationId,
      );
    }
    throw new Error(
      "External Runtime 调度缺少合法 SNOW_CONTROL_PLANE_PUBLIC_URL，无法建立 Gateway 回调闭环",
    );
  }
  return buildExternalGatewayEndpoints(baseUrl, params.invocationId);
}

/** 默认进程内地址，仅用于没有 Invocation 上下文的能力探测夹具。 */
export const IN_PROCESS_GATEWAY_ENDPOINTS: CallbackEndpoints = buildGatewayEndpoints({
  external: false,
});

/**
 * 为 StartInvocation 构造 Runtime 可实际访问的 Gateway 端点。
 *
 * External Runtime 必须拿到平台可路由的绝对 URL；任何缺失或非法公开地址都直接
 * fail closed，禁止把 `in-process://` 泄漏给独立进程。
 */
function buildExternalGatewayEndpoints(baseUrl: string, invocationId?: string): CallbackEndpoints {
  const base = baseUrl.replace(/\/$/, "");
  const id = invocationId ?? "invocation";
  return {
    events: `${base}/runtime/invocations/${id}/events`,
    heartbeat: `${base}/runtime/invocations/${id}/heartbeat`,
    context: `${base}/gateway/context`,
    capabilityActions: `${base}/gateway/capability-actions`,
    toolCalls: `${base}/gateway/tool-calls`,
    userActions: `${base}/gateway/user-action-requests`,
  };
}
