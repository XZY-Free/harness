import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { getUserActionRequestById } from "@/lib/permission/user-action-queries";
/**
 * GET /admin/api/user-actions/{requestId} — UserActionRequest 单资源详情（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 调用 getUserActionRequestById（按 tenantId 过滤实现跨租户隔离）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - UserActionRequest 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ requestId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { requestId: requestIdParam } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const actionRequest = await getUserActionRequestById(principal.tenantId, requestIdParam);
  if (!actionRequest) {
    return resourceNotFound(requestId, `UserActionRequest 不存在或无权访问: ${requestIdParam}`);
  }

  const body = {
    id: actionRequest.id,
    tenant_id: actionRequest.tenantId,
    threadId: actionRequest.threadId,
    turnId: actionRequest.turnId,
    invocationId: actionRequest.invocationId,
    toolCallId: actionRequest.toolCallId,
    itemId: actionRequest.itemId,
    request_type: actionRequest.requestType,
    purpose: actionRequest.purpose,
    request_state: actionRequest.requestState,
    prompt_json: actionRequest.promptJson,
    input_schema_json: actionRequest.inputSchemaJson,
    auth_state_hash: actionRequest.authStateHash,
    nonce_hash: actionRequest.nonceHash,
    resolution: actionRequest.resolution,
    resolved_by: actionRequest.resolvedBy,
    resolved_at: actionRequest.resolvedAt?.toISOString() ?? null,
    response_redacted_json: actionRequest.responseRedactedJson,
    grant_id: actionRequest.grantId,
    expires_at: actionRequest.expiresAt?.toISOString() ?? null,
    version_no: actionRequest.versionNo,
    created_at: actionRequest.createdAt.toISOString(),
    updated_at: actionRequest.updatedAt.toISOString(),
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
