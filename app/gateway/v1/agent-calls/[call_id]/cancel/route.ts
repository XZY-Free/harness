import { agentCallStore } from "@/lib/agents/calls/application/agent-call-events-common";
/**
 * POST /gateway/v1/agent-calls/{call_id}/cancel — 取消 AgentCall（A2A tasks/cancel）
 * 取消只改变 AgentCall 子执行，不直接修改 parent Invocation。
 *
 * 语义：
 *   running / waiting_user → cancelled。取消只把 AgentCall 置为 cancelled（child fact），
 *   绝不直接改 parent Invocation / Turn 终态 —— parent 由 Harness cancel authority 编排。
 *
 * 认证：
 *   Gateway Workload Token（audience=gateway）→ tenantId + invocationId。
 *   call.parentInvocationId 必须等于 Token invocationId（跨 Invocation 隐藏式 404）。
 *
 * 错误映射：
 *   - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 *   - call_id 缺失 / 不存在 / 跨 Invocation → 404 RESOURCE_NOT_FOUND
 *   - 状态不可取消 / transport 失败 → 409 AGENT_CALL_CANCEL_CONFLICT
 */
import {
  AgentCallCancelError,
  cancelAgentCall,
} from "@/lib/agents/calls/application/cancel-agent-call";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";
import {
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";

export const dynamic = "force-dynamic";

function extractCallId(url: string): string | null {
  // 路径形如 /gateway/v1/agent-calls/{call_id}/cancel
  const match = url.match(/\/gateway\/v1\/agent-calls\/([^/?#]+)\/cancel/);
  const id = match?.[1];
  return id ? decodeURIComponent(id) : null;
}

export async function POST(request: Request): Promise<Response> {
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

  // 2. 提取 call_id + 跨 Invocation 校验。
  const callId = extractCallId(request.url);
  if (!callId) {
    return resourceNotFound(requestId, "call_id 缺失");
  }
  const existing = await agentCallStore.getById({ callId, tenantId: claims.tenantId });
  if (!existing || existing.parentInvocationId !== claims.invocationId) {
    return resourceNotFound(requestId, "AgentCall 不存在或无权访问");
  }

  // 3. cancel（只改 AgentCall 子域终态，parent 由 Harness cancel authority 收口）。
  try {
    const updated = await cancelAgentCall({ tenantId: claims.tenantId, callId });
    return apiSuccess(
      { call_id: callId, state: updated.state },
      { headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch (err) {
    if (err instanceof AgentCallCancelError) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    throw err;
  }
}
