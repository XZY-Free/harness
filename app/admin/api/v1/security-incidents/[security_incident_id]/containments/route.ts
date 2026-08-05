/**
 * GET /admin/api/v1/security-incidents/{security_incident_id}/containments — 事故隔离动作列表（S12-W09）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md §9
 *         （撤销 Credential、禁用能力或隔离 Route 后，新操作立即拒绝；进行中副作用进入核对而非静默重试；
 *           不以日志文本冒充隔离成功：applied 要求 evidenceRef 指向实际撤销/禁用证据）。
 *
 * 行为：
 * - GET：列出事故下所有 containment（按 actionType 升序，MySQL enum 定义序）+ 派生 summary。
 * - action scope: security.incident.create + resource { type: "tenant", id: tenantId }。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 事故不存在 → 404 RESOURCE_NOT_FOUND
 */
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  computeContainmentSummary,
  getSecurityIncidentById,
  listIncidentContainments,
} from "@/lib/identity/security-incident-queries";
import type { IncidentContainment } from "@/lib/persistence/schema/security-incident";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/v11/admin/route-helpers";

export const dynamic = "force-dynamic";

function projectContainment(c: IncidentContainment): Record<string, unknown> {
  return {
    id: c.id,
    incident_id: c.incidentId,
    action_type: c.actionType,
    action_state: c.actionState,
    evidence_ref: c.evidenceRef,
    target_ref: c.targetRef,
    details: c.detailsJson ? JSON.parse(c.detailsJson) : null,
    failure_reason: c.failureReason,
    applied_at: c.appliedAt?.toISOString() ?? null,
    reverted_at: c.revertedAt?.toISOString() ?? null,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

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

  // 2. action scope 校验
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

  // 5. 列出 containments + 派生 summary
  const containments = await listIncidentContainments(principal.tenantId, incidentId);
  const summary = computeContainmentSummary(containments);

  return apiSuccess(
    {
      items: containments.map(projectContainment),
      summary: {
        containment_count: summary.containmentCount,
        applied_count: summary.appliedCount,
        failed_count: summary.failedCount,
        pending_count: summary.pendingCount,
        reverted_count: summary.revertedCount,
      },
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
