import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { getAuditEventById } from "@/lib/identity/audit-queries";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
/**
 * GET /admin/api/v1/audit-events/{event_id} — AuditEvent 单资源详情（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 调用 getAuditEventById（无 tenantId 参数；跨租户隔离通过返回值 tenantId 校验保证）。
 * - 校验事件属于当前租户（跨租户隐藏为 404）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - AuditEvent 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ event_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { event_id: eventId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // getAuditEventById 无 tenantId 参数；跨租户隔离通过返回值 tenantId 校验保证
  const event = await getAuditEventById(eventId);
  if (!event || event.tenantId !== principal.tenantId) {
    return resourceNotFound(requestId, `AuditEvent 不存在或无权访问: ${eventId}`);
  }

  const body = {
    id: event.id,
    tenant_id: event.tenantId,
    actor_type: event.actorType,
    actor_id: event.actorId,
    action_type: event.actionType,
    target_type: event.targetType,
    target_id: event.targetId,
    before_hash: event.beforeHash,
    after_hash: event.afterHash,
    reason: event.reason,
    request_id: event.requestId,
    occurred_at: event.occurredAt.toISOString(),
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
