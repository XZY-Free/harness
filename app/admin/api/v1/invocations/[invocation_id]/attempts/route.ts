import { REQUEST_ID_HEADER, getRequestId, v11NotFound, v11Ok } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { getAttemptsByInvocation } from "@/lib/v11/runtime/invocation-attempt-queries";
import { getInvocationById } from "@/lib/v11/runtime/invocation-queries";
/**
 * GET /admin/api/v1/invocations/{invocation_id}/attempts — 列出 Invocation 的执行尝试（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Invocation 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 getAttemptsByInvocation（无 tenantId 参数；跨租户隔离由父 Invocation 校验保证）。
 * - 投影为 snake_case（按 attempt_no 升序）。
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

  // 校验父 Invocation 存在且属于当前租户
  const invocation = await getInvocationById(principal.tenantId, invocationId);
  if (!invocation) {
    return v11NotFound(requestId, `Invocation 不存在或无权访问: ${invocationId}`);
  }

  // getAttemptsByInvocation 无 tenantId 参数；跨租户隔离通过父 Invocation 校验保证
  const attempts = await getAttemptsByInvocation(invocationId);

  const projected = attempts.map((a) => ({
    id: a.id,
    invocation_id: a.invocationId,
    attempt_no: a.attemptNo,
    attempt_state: a.attemptState,
    environment_lease_id: a.environmentLeaseId,
    worker_ref: a.workerRef,
    runtime_execution_ref: a.runtimeExecutionRef,
    checkpoint_ref: a.checkpointRef,
    retry_reason_code: a.retryReasonCode,
    started_at: a.startedAt?.toISOString() ?? null,
    finished_at: a.finishedAt?.toISOString() ?? null,
    last_heartbeat_at: a.lastHeartbeatAt?.toISOString() ?? null,
    error_code: a.errorCode,
    error_summary: a.errorSummary,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
  }));

  return v11Ok(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
