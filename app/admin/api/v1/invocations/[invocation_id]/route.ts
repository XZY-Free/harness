import { REQUEST_ID_HEADER, getRequestId, resourceNotFound, apiSuccess } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { getInvocationById } from "@/lib/v11/runtime/invocation-queries";
/**
 * GET /admin/api/v1/invocations/{invocation_id} — Invocation 单资源详情（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 调用 getInvocationById（按 tenantId 过滤实现跨租户隔离）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Invocation 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ invocation_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { invocation_id: invocationId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const invocation = await getInvocationById(principal.tenantId, invocationId);
  if (!invocation) {
    return resourceNotFound(requestId, `Invocation 不存在或无权访问: ${invocationId}`);
  }

  const body = {
    id: invocation.id,
    tenant_id: invocation.tenantId,
    thread_id: invocation.threadId,
    turn_id: invocation.turnId,
    job_id: invocation.jobId,
    invocation_sequence: invocation.invocationSequence,
    invocation_kind: invocation.invocationKind,
    execution_state: invocation.executionState,
    trigger_item_id: invocation.triggerItemId,
    replaces_invocation_id: invocation.replacesInvocationId,
    output_item_id: invocation.outputItemId,
    result_ref: invocation.resultRef,
    runtime_session_binding_id: invocation.runtimeSessionBindingId,
    runtime_execution_ref: invocation.runtimeExecutionRef,
    started_at: invocation.startedAt?.toISOString() ?? null,
    finished_at: invocation.finishedAt?.toISOString() ?? null,
    last_heartbeat_at: invocation.lastHeartbeatAt?.toISOString() ?? null,
    error_code: invocation.errorCode,
    error_summary: invocation.errorSummary,
    version_no: invocation.versionNo,
    created_at: invocation.createdAt.toISOString(),
    updated_at: invocation.updatedAt.toISOString(),
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
