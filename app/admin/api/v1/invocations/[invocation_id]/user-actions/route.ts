import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { getUserActionRequestsByInvocation } from "@/lib/v11/permission/user-action-queries";
/**
 * GET /admin/api/v1/invocations/{invocation_id}/user-actions — 列出 Invocation 的 UserActionRequest（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Invocation 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 getUserActionRequestsByInvocation（跨租户隔离）。
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

  // 校验父 Invocation 存在且属于当前租户
  const invocation = await getInvocationById(principal.tenantId, invocationId);
  if (!invocation) {
    return resourceNotFound(requestId, `Invocation 不存在或无权访问: ${invocationId}`);
  }

  const requests = await getUserActionRequestsByInvocation(principal.tenantId, invocationId);

  const projected = requests.map((r) => ({
    id: r.id,
    tenant_id: r.tenantId,
    thread_id: r.threadId,
    turn_id: r.turnId,
    invocation_id: r.invocationId,
    tool_call_id: r.toolCallId,
    item_id: r.itemId,
    request_type: r.requestType,
    purpose: r.purpose,
    request_state: r.requestState,
    prompt_json: r.promptJson,
    input_schema_json: r.inputSchemaJson,
    auth_state_hash: r.authStateHash,
    nonce_hash: r.nonceHash,
    resolution: r.resolution,
    resolved_by: r.resolvedBy,
    resolved_at: r.resolvedAt?.toISOString() ?? null,
    response_redacted_json: r.responseRedactedJson,
    grant_id: r.grantId,
    expires_at: r.expiresAt?.toISOString() ?? null,
    version_no: r.versionNo,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
