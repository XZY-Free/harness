/**
 * POST /runtime/v1/invocations — Hosted Runtime 启动 Invocation（S05-C02 + S05-C05 参考实现）。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md §4（Runtime Protocol API）
 * - docs/architecture/agent-control-plane.md §6（Invocation 生命周期）
 * - docs/architecture/runtime-control-plane.md S05-C02/S05-C05
 *
 * 行为：
 * - 解析 Bearer Token（Workload Token，audience=runtime）。
 * - 校验 Idempotency-Key（必填）。
 * - 校验请求体（invocation_id / agent / gateway_endpoints / execution_limits 必填）。
 * - 生成 runtime_session_ref + runtime_execution_ref，返回 accepted=true（HTTP 202）。
 * - S05-C05 扩展：异步启动 HostedAgentLoop（不阻塞 dispatch 响应）。
 *   - 从 turn_context 提取 thread_id / turn_id（缺失时回退到 placeholder）。
 *   - 调用 startHostedAdapter，loop.run() 内部通过 Event Ingress 回传候选事件。
 *   - 测试可通过 setHostedAdapterOverrides 注入 ingressClient/modelFn；通过 getLastLoopPromise await 完成。
 *
 * 错误映射：
 * - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 */
import { randomUUID } from "node:crypto";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
} from "@/lib/http";
import {
  assertAudienceMatch,
  decodeWorkloadToken,
  extractBearerToken,
  workloadTokenErrorResponse,
} from "@/lib/identity/workload-token";
import { getRouteHostedAdapter } from "@/lib/runtime/adapters/hosted-adapter";
import {
  type RuntimeCapabilitiesResponse,
  type StartInvocationRequestBody,
  type StartInvocationResponse,
  defaultRuntimeCapabilities,
} from "@/lib/runtime/runtime-client";

export const dynamic = "force-dynamic";

/** 校验请求体结构。 */
function validateBody(body: unknown): body is StartInvocationRequestBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const allowedKeys = new Set([
    "protocol_version",
    "invocation_id",
    "turn_context",
    "job_context",
    "agent",
    "input_items",
    "context_handle",
    "gateway_endpoints",
    "governance_config",
    "gateway_access",
    "execution_limits",
    "workspace",
    "trace_context",
    "attempt",
  ]);
  if (Object.keys(b).some((key) => !allowedKeys.has(key))) return false;
  // §23/§49：agent-runtime-protocol@2，无 @1 fallback。
  if (b.protocol_version !== "2") return false;
  if (typeof b.invocation_id !== "string" || b.invocation_id.length === 0) return false;
  if (!b.agent || typeof b.agent !== "object") return false;
  const agent = b.agent as Record<string, unknown>;
  if (typeof agent.agent_revision_id !== "string" || agent.agent_revision_id.length === 0) {
    return false;
  }
  if (typeof agent.instruction_hash !== "string") return false;
  if (typeof agent.artifact_ref !== "string") return false;
  if (!Array.isArray(b.input_items) || b.input_items.length === 0) return false;
  if (typeof b.context_handle !== "string" || b.context_handle.length === 0) return false;
  if (!b.gateway_endpoints || typeof b.gateway_endpoints !== "object") return false;
  const gw = b.gateway_endpoints as Record<string, unknown>;
  if (typeof gw.events !== "string" || typeof gw.cancel !== "string") return false;
  if (typeof gw.resume !== "string" || typeof gw.steer !== "string") return false;
  if (typeof gw.tools !== "string" || typeof gw.tool_calls !== "string") return false;
  if (typeof gw.user_action_requests !== "string") return false;
  // §24：governance_config 必填（revision_id + config_digest + config 快照）。
  if (!b.governance_config || typeof b.governance_config !== "object") return false;
  const gov = b.governance_config as Record<string, unknown>;
  if (typeof gov.revision_id !== "string" || typeof gov.config_digest !== "string") return false;
  if (!gov.config || typeof gov.config !== "object") return false;
  // §27：gateway_access 必填（access_token + expires_at）。
  if (!b.gateway_access || typeof b.gateway_access !== "object") return false;
  const gwa = b.gateway_access as Record<string, unknown>;
  if (typeof gwa.access_token !== "string" || typeof gwa.expires_at !== "string") return false;
  if (!b.execution_limits || typeof b.execution_limits !== "object") return false;
  const limits = b.execution_limits as Record<string, unknown>;
  if (typeof limits.max_invocation_seconds !== "number") return false;
  if (typeof limits.max_event_bytes !== "number") return false;
  if (
    b.workspace !== undefined &&
    b.workspace !== null &&
    (typeof b.workspace !== "object" || Array.isArray(b.workspace))
  ) {
    return false;
  }
  if (!b.trace_context || typeof b.trace_context !== "object" || Array.isArray(b.trace_context)) {
    return false;
  }
  return true;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析 Bearer Token（audience=runtime）
  const token = extractBearerToken(request.headers);
  if (!token) {
    return apiError("AUTHENTICATION_REQUIRED", "缺少 Authorization Bearer Token", { requestId });
  }

  try {
    const claims = decodeWorkloadToken(token);
    assertAudienceMatch(claims, "runtime");
  } catch (err) {
    const resp = workloadTokenErrorResponse(err, requestId);
    if (resp) return resp;
    throw err;
  }

  // 2. 校验 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return apiError("REQUEST_SCHEMA_INVALID", "缺少必填头 Idempotency-Key", { requestId });
  }

  // 3. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return apiError(
      "REQUEST_SCHEMA_INVALID",
      "请求体非法：缺少 invocation_id/agent/gateway_endpoints/execution_limits 或字段类型错误",
      { requestId },
    );
  }

  // 4. 生成 runtime_session_ref + runtime_execution_ref，返回 accepted
  const capabilities: RuntimeCapabilitiesResponse = defaultRuntimeCapabilities();
  const response: StartInvocationResponse = {
    invocation_id: body.invocation_id,
    accepted: true,
    attempt_no: body.attempt?.attempt_no ?? 1,
    runtime_session_ref: `rss_${randomUUID()}`,
    runtime_execution_ref: `rex_${randomUUID()}`,
    capabilities,
  };

  // 5. S05-C05 扩展：异步启动 HostedAgentLoop（不阻塞 dispatch 响应）
  //
  // route handler 解析 turn_context 与 agent 信息，调用 getRouteHostedAdapter().startInvocation
  // 触发 loop.run()。loop.run() 不被 await：dispatch 立即返回 202；loop 内部通过 Event Ingress 回传候选事件。
  // 测试可通过 setRouteHostedAdapter 注入带 mock sink 的 Adapter。
  //
  // turn_context 可为 null（Job Invocation 路径，本阶段未启用 Agent Loop），
  // 此时跳过 startInvocation 调用；Job 模式由后续阶段接入 JobEvent 投影。
  const turnContext = body.turn_context;
  if (turnContext) {
    const adapter = getRouteHostedAdapter();
    if (!adapter) {
      return apiError("RUNTIME_UNAVAILABLE", "Hosted Runtime 尚未配置模型执行器", { requestId });
    }
    // fire-and-forget：loop 内部异步执行，不阻塞 dispatch 响应
    void adapter.startInvocation({
      invocationId: body.invocation_id,
      threadId: turnContext.thread_id,
      turnId: turnContext.turn_id,
      agentRevisionId: body.agent.agent_revision_id,
      inputItems: body.input_items,
      contextHandle: body.context_handle,
      gatewayEndpoints: body.gateway_endpoints,
      workspace: body.workspace ?? null,
      executionLimits: body.execution_limits,
      traceContext: body.trace_context,
      authToken: token,
      correlationId: requestId,
    });
  }

  return apiSuccess(response, {
    status: 202,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
