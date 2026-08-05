import { getDeliveryFailureById } from "@/lib/conversations/projection-operations";
/**
 * GET /admin/api/v1/event-delivery/{failure_id} — 事件交付失败单资源详情（S12-W01）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 按 (tenantId, failureId) 查询失败记录（跨租户隔离，隐藏为 404）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 失败记录不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ failure_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { failure_id: failureId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const failure = await getDeliveryFailureById(principal.tenantId, failureId);
  if (!failure) {
    return resourceNotFound(requestId, `事件交付失败记录不存在或无权访问: ${failureId}`);
  }

  const body = {
    id: failure.id,
    consumer_name: failure.consumerName,
    stream_type: failure.streamType,
    stream_id: failure.streamId,
    event_id: failure.eventId,
    event_sequence: failure.eventSequence,
    payload_hash: failure.payloadHash,
    failure_class: failure.failureClass,
    failure_state: failure.failureState,
    attempt_count: failure.attemptCount,
    next_retry_at: failure.nextRetryAt ? failure.nextRetryAt.toISOString() : null,
    last_error_code: failure.lastErrorCode,
    last_error_detail: failure.lastErrorDetailJson,
    created_at: failure.createdAt.toISOString(),
    updated_at: failure.updatedAt.toISOString(),
    resolved_at: failure.resolvedAt ? failure.resolvedAt.toISOString() : null,
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
