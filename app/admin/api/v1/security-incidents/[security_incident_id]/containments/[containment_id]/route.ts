import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
/**
 * POST /admin/api/v1/security-incidents/{security_incident_id}/containments/{containment_id} — 隔离动作状态推进（S12-W09）。
 *
 * 事实源：docs/architecture/security.md §9
 *         （撤销 Credential、禁用能力或隔离 Route 后，新操作立即拒绝；进行中副作用进入核对而非静默重试；
 *           不以日志文本冒充隔离成功：applied 要求 evidenceRef 指向实际撤销/禁用证据）。
 *
 * 行为：
 * - POST action=apply：pending → applied（要求 evidence_ref）。
 * - POST action=fail：pending → failed（要求 failure_reason）。
 * - POST action=revert：applied → reverted（事故 resolved 时可回滚可恢复的隔离）。
 * - action scope: security.incident.isolate + resource { type: "tenant", id: tenantId }。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - containment 不存在 → 404 RESOURCE_NOT_FOUND
 * - 非法状态转移 → 409 BUSINESS_CONSTRAINT_VIOLATION
 * - 缺少 evidence_ref / failure_reason → 400 REQUEST_SCHEMA_INVALID
 */
import {
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
import {
  SecurityIncidentError,
  getSecurityIncidentById,
  markContainmentApplied,
  markContainmentFailed,
  revertContainment,
} from "@/lib/identity/security-incident-queries";
import type { IncidentContainment } from "@/lib/persistence/schema/security-incident";

export const dynamic = "force-dynamic";

const VALID_ACTIONS = new Set(["apply", "fail", "revert"]);

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

export async function POST(
  request: Request,
  context: {
    params: Promise<{ security_incident_id: string; containment_id: string }>;
  },
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

  // 2. action scope 校验：containment 状态推进需 isolate 权限
  const scopeResult = await requireAdminActionScope(
    principal,
    "security.incident.isolate",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 3. 解析路径参数 + 请求体
  const { security_incident_id: incidentId, containment_id: containmentId } = await context.params;
  if (!incidentId) {
    return schemaInvalidTable(requestId, "缺少路径参数 security_incident_id");
  }
  if (!containmentId) {
    return schemaInvalidTable(requestId, "缺少路径参数 containment_id");
  }

  const body = (await request.json().catch(() => null)) as {
    action?: string;
    evidence_ref?: string;
    failure_reason?: string;
    details?: Record<string, unknown>;
    reason?: string;
  } | null;

  const action = body?.action?.trim();
  if (!action || !VALID_ACTIONS.has(action)) {
    return schemaInvalidTable(requestId, "缺少或非法 action（期望 apply/fail/revert）");
  }

  // 4. 校验事故存在 + 跨租户隔离（containment 隐式归属同租户）
  const incident = await getSecurityIncidentById(principal.tenantId, incidentId);
  if (!incident) {
    return resourceNotFound(requestId, "安全事件不存在或无权访问");
  }

  try {
    let updated: IncidentContainment;

    if (action === "apply") {
      const evidenceRef = body?.evidence_ref?.trim();
      if (!evidenceRef) {
        return schemaInvalidTable(
          requestId,
          "apply 操作缺少 evidence_ref（存储端证据，不能用日志文本冒充隔离成功）",
        );
      }
      const detailsJson = body?.details ? JSON.stringify(body.details) : undefined;
      updated = await markContainmentApplied({
        tenantId: principal.tenantId,
        containmentId,
        evidenceRef,
        detailsJson,
      });
    } else if (action === "fail") {
      const failureReason = body?.failure_reason?.trim();
      if (!failureReason) {
        return schemaInvalidTable(requestId, "fail 操作缺少 failure_reason");
      }
      updated = await markContainmentFailed({
        tenantId: principal.tenantId,
        containmentId,
        failureReason,
        evidenceRef: body?.evidence_ref?.trim() || undefined,
      });
    } else {
      // revert
      updated = await revertContainment({
        tenantId: principal.tenantId,
        containmentId,
        reason: body?.reason?.trim() || undefined,
      });
    }

    return apiSuccess(projectContainment(updated), {
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    if (err instanceof SecurityIncidentError) {
      if (err.code === "containment_not_found") {
        return resourceNotFound(requestId, "隔离动作不存在或无权访问");
      }
      if (err.code === "illegal_transition") {
        return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
      }
      if (err.code === "missing_evidence") {
        return schemaInvalidTable(requestId, err.message);
      }
    }
    throw err;
  }
}
