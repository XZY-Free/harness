import { appConfig, runtimeGatewayConfig } from "@/lib/config";
import type { GatewayEndpoints } from "@/lib/runtime/runtime-client";

/** Hosted Runtime 在同一进程内使用的端点标识。 */
export const IN_PROCESS_GATEWAY_ENDPOINTS: GatewayEndpoints = {
  events: "in-process://events",
  cancel: "in-process://cancel",
  resume: "in-process://resume",
  steer: "in-process://steer",
  tools: "in-process://gateway/tools",
  tool_calls: "in-process://gateway/tool-calls",
  user_action_requests: "in-process://gateway/user-action-requests",
  capability_actions: "in-process://gateway/capability-actions",
};

/**
 * 为 StartInvocation 构造 Runtime 可实际访问的 Gateway 端点。
 *
 * External Runtime 必须拿到平台可路由的绝对 URL；任何缺失或非法公开地址都直接
 * fail closed，禁止把 `in-process://` 泄漏给独立进程。
 */
export function buildGatewayEndpoints(params: { external: boolean }): GatewayEndpoints {
  if (!params.external) return IN_PROCESS_GATEWAY_ENDPOINTS;

  const baseUrl = runtimeGatewayConfig.publicBaseUrl;
  if (!baseUrl) {
    // Test/development 没有反向代理时仍给出可预测的本地地址；生产必须显式配置。
    if (!appConfig.isProd) {
      return buildExternalGatewayEndpoints(`http://127.0.0.1:${appConfig.port}`);
    }
    throw new Error(
      "External Runtime 调度缺少合法 SNOW_CONTROL_PLANE_PUBLIC_URL，无法建立 Gateway 回调闭环",
    );
  }
  return buildExternalGatewayEndpoints(baseUrl);
}

function buildExternalGatewayEndpoints(baseUrl: string): GatewayEndpoints {
  const base = baseUrl.replace(/\/$/, "");
  return {
    events: `${base}/gateway/runtime-events`,
    cancel: `${base}/gateway/runtime-commands/cancel`,
    resume: `${base}/gateway/runtime-commands/resume`,
    steer: `${base}/gateway/runtime-commands/steer`,
    tools: `${base}/gateway/tools`,
    tool_calls: `${base}/gateway/tool-calls`,
    user_action_requests: `${base}/gateway/user-action-requests`,
    capability_actions: `${base}/gateway/capability-actions`,
  };
}
