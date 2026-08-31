import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
  recordAuditEvent,
} from "@/lib/identity/audit";
import { loadHarnessExecutionTraceForAgentCall } from "@/lib/observability/harness-execution-trace";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ call_id: string }>;
}

/** 查看 AgentCall 关联执行 Trace；仅返回脱敏元数据，且每次成功查看都写 AuditEvent。 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { call_id: callId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (error) {
    const response = adminAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }

  const authorization = await requireAdminActionScope(
    principal,
    "audit.read",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!authorization.ok) return authorization.response;

  const trace = await loadHarnessExecutionTraceForAgentCall(principal.tenantId, callId);
  if (!trace) {
    return resourceNotFound(requestId, `AgentCall 不存在或无权访问: ${callId}`);
  }

  await recordAuditEvent({
    actor:
      "userIdentityId" in principal
        ? actorFromPrincipal(principal)
        : actorFromWorkloadPrincipal(principal),
    actionType: "diagnostic.view",
    targetType: "agent_call",
    targetId: callId,
    reason: "查看 AgentCall 脱敏执行 Trace",
    requestId,
  });

  return apiSuccess(trace, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
