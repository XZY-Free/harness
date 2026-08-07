/**
 * GET /admin/api/v1/security-incidents/{security_incident_id}/timeline — 事故时间线汇总（S12-W09）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md §9
 *         （事故时间线从 Audit/Event/Trace 汇总，诊断内容访问仍受时限、脱敏和审计约束）。
 *
 * 行为：
 * - GET：从事故的 AuditEvent 汇总时间线（按 occurredAt 升序），仅返回管理域审计事件。
 * - action scope: security.incident.create + resource { type: "tenant", id: tenantId }。
 *
 * 诊断内容访问约束：
 * - 调用方需持有 security.incident.create action scope（路由层校验）。
 * - AuditEvent 的 beforeHash/afterHash 为摘要，不含原始敏感字段（仓储层保证）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 事故不存在 → 404 RESOURCE_NOT_FOUND
 */
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  buildIncidentTimeline,
  getSecurityIncidentById,
} from "@/lib/identity/security-incident-queries";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ security_incident_id: string }> },
): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 身份解析
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. action scope 校验：时间线访问需 incident.create 权限（包含 read 访问）
  const scopeResult = await requireAdminActionScope(
    principal,
    "security.incident.create",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 3. 解析路径参数
  const { security_incident_id: incidentId } = await context.params;
  if (!incidentId) {
    return schemaInvalidTable(requestId, "缺少路径参数 security_incident_id");
  }

  // 4. 校验事故存在 + 跨租户隔离
  const incident = await getSecurityIncidentById(principal.tenantId, incidentId);
  if (!incident) {
    return resourceNotFound(requestId, "安全事件不存在或无权访问");
  }

  // 5. 汇总时间线
  const timeline = await buildIncidentTimeline(principal.tenantId, incidentId);

  return apiSuccess(
    {
      incident_id: incidentId,
      items: timeline.map((e) => ({
        id: e.id,
        occurred_at: e.occurredAt.toISOString(),
        action_type: e.actionType,
        actor_type: e.actorType,
        actor_id: e.actorId,
        reason: e.reason,
      })),
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
