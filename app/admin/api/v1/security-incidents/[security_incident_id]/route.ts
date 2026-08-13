/**
 * GET/POST /admin/api/v1/security-incidents/{security_incident_id} — 安全事件详情与状态推进（S12-W09）。
 *
 * 事实源：docs/architecture/security.md §9
 *         （安全事件可按 Agent、Revision、ToolProvider、Credential、Runtime 或 Environment 隔离和止损；
 *           撤销 Credential、禁用能力或隔离 Route 后，新操作立即拒绝；进行中副作用进入核对而非静默重试；
 *           escalated 事件需人工介入，不自动 resolve）。
 *
 * 行为：
 * - GET：查询事故详情 + 关联 containments + 派生 summary。
 * - POST：推进事故状态机（investigate/contain/resolve/escalate）。
 *   - action=investigate → security.incident.create
 *   - action=contain → security.incident.isolate（要求所有 containment 为 applied/failed）
 *   - action=resolve → security.incident.resolve
 *   - action=escalate → security.incident.create
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 事故不存在 → 404 RESOURCE_NOT_FOUND
 * - 非法状态转移 → 409 BUSINESS_CONSTRAINT_VIOLATION
 * - containment_pending → 409 BUSINESS_CONSTRAINT_VIOLATION
 * - 非法 action 参数 → 400 REQUEST_SCHEMA_INVALID
 */
import {
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/identity/audit";
import {
  SecurityIncidentError,
  computeContainmentSummary,
  containIncident,
  escalateIncident,
  getSecurityIncidentById,
  listIncidentContainments,
  resolveIncident,
  startInvestigation,
} from "@/lib/identity/security-incident-queries";
import type {
  IncidentContainment,
  SecurityIncident,
} from "@/lib/persistence/schema/security-incident";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";

export const dynamic = "force-dynamic";

const ACTION_TO_SCOPE = {
  investigate: "security.incident.create",
  contain: "security.incident.isolate",
  resolve: "security.incident.resolve",
  escalate: "security.incident.create",
} as const;

type IncidentAction = keyof typeof ACTION_TO_SCOPE;
const VALID_ACTIONS = new Set<IncidentAction>(["investigate", "contain", "resolve", "escalate"]);

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

function closedByFromAdminPrincipal(principal: AdminPrincipal): string {
  return "userIdentityId" in principal
    ? principal.userIdentityId
    : (principal.serviceId ?? "unknown");
}

function projectIncident(incident: SecurityIncident): Record<string, unknown> {
  return {
    id: incident.id,
    incident_key: incident.incidentKey,
    severity: incident.severity,
    incident_state: incident.incidentState,
    target_type: incident.targetType,
    target_id: incident.targetId,
    summary: incident.summary,
    detected_by: incident.detectedBy,
    detected_at: incident.detectedAt.toISOString(),
    investigating_at: incident.investigatingAt?.toISOString() ?? null,
    contained_at: incident.containedAt?.toISOString() ?? null,
    resolved_at: incident.resolvedAt?.toISOString() ?? null,
    closed_by: incident.closedBy,
    closure_reason: incident.closureReason,
    containment_summary: incident.containmentSummaryJson
      ? JSON.parse(incident.containmentSummaryJson)
      : null,
    audit_event_id: incident.auditEventId,
    request_id: incident.requestId,
    created_at: incident.createdAt.toISOString(),
    updated_at: incident.updatedAt.toISOString(),
  };
}

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

function projectIncidentDetail(
  incident: SecurityIncident,
  containments: IncidentContainment[],
): Record<string, unknown> {
  const summary = computeContainmentSummary(containments);
  return {
    ...projectIncident(incident),
    containment_summary_runtime: {
      containment_count: summary.containmentCount,
      applied_count: summary.appliedCount,
      failed_count: summary.failedCount,
      pending_count: summary.pendingCount,
      reverted_count: summary.revertedCount,
    },
    containments: containments.map(projectContainment),
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

  // 4. 查询事故；不存在 → 404 RESOURCE_NOT_FOUND
  const incident = await getSecurityIncidentById(principal.tenantId, incidentId);
  if (!incident) {
    return resourceNotFound(requestId, "安全事件不存在或无权访问");
  }

  // 5. 列出 containments
  const containments = await listIncidentContainments(principal.tenantId, incidentId);

  return apiSuccess(projectIncidentDetail(incident, containments), {
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}

export async function POST(
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

  // 2. 解析路径参数 + 请求体
  const { security_incident_id: incidentId } = await context.params;
  if (!incidentId) {
    return schemaInvalidTable(requestId, "缺少路径参数 security_incident_id");
  }

  const body = (await request.json().catch(() => null)) as {
    action?: string;
    closure_reason?: string;
  } | null;

  const actionRaw = body?.action?.trim();
  if (!actionRaw || !VALID_ACTIONS.has(actionRaw as IncidentAction)) {
    return schemaInvalidTable(
      requestId,
      "缺少或非法 action（期望 investigate/contain/resolve/escalate）",
    );
  }
  const action = actionRaw as IncidentAction;

  // 3. action scope 校验：按 action 映射到对应 actionCode
  const scopeResult = await requireAdminActionScope(
    principal,
    ACTION_TO_SCOPE[action],
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const actor = actorFromAdminPrincipal(principal);
  const closureReason = body?.closure_reason?.trim() || undefined;

  try {
    let updated: SecurityIncident;

    if (action === "investigate") {
      updated = await startInvestigation({
        tenantId: principal.tenantId,
        id: incidentId,
        actor,
        requestId,
      });
    } else if (action === "contain") {
      updated = await containIncident({
        tenantId: principal.tenantId,
        id: incidentId,
        actor,
        requestId,
      });
    } else if (action === "resolve") {
      updated = await resolveIncident({
        tenantId: principal.tenantId,
        id: incidentId,
        actor,
        closedBy: closedByFromAdminPrincipal(principal),
        closureReason,
        requestId,
      });
    } else {
      // escalate
      updated = await escalateIncident({
        tenantId: principal.tenantId,
        id: incidentId,
        actor,
        closedBy: closedByFromAdminPrincipal(principal),
        closureReason,
        requestId,
      });
    }

    // 返回更新后的事故详情 + containments
    const containments = await listIncidentContainments(principal.tenantId, incidentId);
    return apiSuccess(projectIncidentDetail(updated, containments), {
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    if (err instanceof SecurityIncidentError) {
      if (err.code === "incident_not_found") {
        return resourceNotFound(requestId, "安全事件不存在或无权访问");
      }
      if (err.code === "illegal_transition" || err.code === "containment_pending") {
        return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
      }
    }
    throw err;
  }
}
