/**
 * GET /gateway/v1/agent-calls/{call_id} — 查询 AgentCall 状态。
 *
 * 认证：
 *   Gateway Workload Token（audience=gateway）→ tenantId + invocationId。
 *
 * 隔离：
 *   - 按 (tenantId, callId) 查询；
 *   - call.parentInvocationId 必须等于 Token 的 invocationId（跨 Invocation 隐藏式 404）。
 *
 * 返回 AgentCall 投影（state / result / task / context），不透出 endpoint secret /
 * credential / Agent publication internals。
 *
 * 错误映射：
 *   - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 *   - call_id 缺失 / call 不存在 / 跨租户 / 跨 Invocation → 404 RESOURCE_NOT_FOUND
 */
import { agentCallStore } from "@/lib/agents/calls/application/agent-call-events-common";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";

export const dynamic = "force-dynamic";

/** 从 URL 路径提取 call_id。 */
function extractCallId(url: string): string | null {
  // 路径形如 /gateway/v1/agent-calls/{call_id}
  const match = url.match(/\/gateway\/v1\/agent-calls\/([^/?#]+)/);
  const id = match?.[1];
  return id ? decodeURIComponent(id) : null;
}

/** 把 AgentCall 行投影为 API 响应体（snake_case；不含任何 secret）。 */
function projectCall(call: {
  id: string;
  parentInvocationId: string;
  agentId: string;
  agentRevisionId: string;
  sourceType: string;
  state: string;
  externalTaskRef: string | null;
  externalContextRef: string | null;
  resultText: string | null;
  errorCode: string | null;
  errorSummary: string | null;
}): {
  call_id: string;
  parent_invocation_id: string;
  agent_id: string;
  agent_revision_id: string;
  source_type: string;
  state: string;
  task_id: string | null;
  context_id: string | null;
  result_text: string | null;
  error_code: string | null;
  error_summary: string | null;
} {
  return {
    call_id: call.id,
    parent_invocation_id: call.parentInvocationId,
    agent_id: call.agentId,
    agent_revision_id: call.agentRevisionId,
    source_type: call.sourceType,
    state: call.state,
    task_id: call.externalTaskRef,
    context_id: call.externalContextRef,
    result_text: call.resultText,
    error_code: call.errorCode,
    error_summary: call.errorSummary,
  };
}

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析 Gateway 身份（audience=gateway）→ tenantId + invocationId。
  let claims: GatewayPrincipal;
  try {
    claims = await resolveGatewayPrincipal(request.headers);
  } catch (err) {
    const authResp = gatewayAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 从路径提取 call_id。
  const callId = extractCallId(request.url);
  if (!callId) {
    return resourceNotFound(requestId, "call_id 缺失");
  }

  // 3. 按 (tenantId, callId) 查询 + 跨 Invocation 校验。
  const call = await agentCallStore.getById({ callId, tenantId: claims.tenantId });
  if (!call || call.parentInvocationId !== claims.invocationId) {
    return resourceNotFound(requestId, "AgentCall 不存在或无权访问");
  }

  // 4. 返回投影（不含 secret）。
  return apiSuccess(projectCall(call), {
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
