/**
 * POST/GET /admin/api/v1/security-incidents — 安全事件管理（S12-W09）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md §9
 *         （安全事件可按 Agent、Revision、ToolProvider、Credential、Runtime 或 Environment 隔离和止损；
 *           撤销 Credential、禁用能力或隔离 Route 后，新操作立即拒绝；进行中副作用进入核对而非静默重试；
 *           事故时间线从 Audit/Event/Trace 汇总，诊断内容访问仍受时限、脱敏和审计约束）。
 *
 * 行为：
 * - POST：创建安全事件（state=open）+ 写审计 security.incident + 按 targetType 预填 containment 项（pending）。
 * - GET：列出安全事件（cursor 分页，支持 severity/state/target_type/detected_by 过滤）。
 * - action scope: security.incident.create + resource { type: "tenant", id: tenantId }。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 缺少必填字段 → 400 REQUEST_SCHEMA_INVALID
 * - 同租户已有相同 incidentKey → 409 BUSINESS_CONSTRAINT_VIOLATION
 * - 非法 enum 值 → 400 REQUEST_SCHEMA_INVALID
 */
import { REQUEST_ID_HEADER, apiError, apiSuccess, getRequestId } from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/identity/audit";
import {
  SecurityIncidentError,
  createSecurityIncident,
  listSecurityIncidents,
} from "@/lib/identity/security-incident-queries";
import {
  INCIDENT_SEVERITIES,
  INCIDENT_STATES,
  INCIDENT_TARGET_TYPES,
  type IncidentSeverity,
  type IncidentState,
  type IncidentTargetType,
} from "@/lib/persistence/schema/security-incident";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/v11/admin/route-helpers";

export const dynamic = "force-dynamic";

const VALID_TARGET_TYPES = new Set<string>(INCIDENT_TARGET_TYPES);
const VALID_SEVERITIES = new Set<string>(INCIDENT_SEVERITIES);
const VALID_STATES = new Set<string>(INCIDENT_STATES);

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

function detectedByFromAdminPrincipal(principal: AdminPrincipal): string {
  return "userIdentityId" in principal
    ? principal.userIdentityId
    : (principal.serviceId ?? "unknown");
}

function projectIncident(incident: {
  id: string;
  incidentKey: string;
  severity: IncidentSeverity;
  incidentState: IncidentState;
  targetType: IncidentTargetType;
  targetId: string;
  summary: string | null;
  detectedBy: string;
  detectedAt: Date;
  investigatingAt: Date | null;
  containedAt: Date | null;
  resolvedAt: Date | null;
  closedBy: string | null;
  closureReason: string | null;
  containmentSummaryJson: string | null;
  auditEventId: string | null;
  requestId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Record<string, unknown> {
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

export async function POST(request: Request): Promise<Response> {
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

  // 2. 请求体解析与校验
  const body = (await request.json().catch(() => null)) as {
    incident_key?: string;
    severity?: string;
    target_type?: string;
    target_id?: string;
    summary?: string;
    detected_by?: string;
  } | null;

  const incidentKey = body?.incident_key?.trim();
  if (!incidentKey) {
    return schemaInvalidTable(requestId, "缺少必填字段 incident_key");
  }

  const severity = body?.severity?.trim();
  if (!severity || !VALID_SEVERITIES.has(severity)) {
    return schemaInvalidTable(requestId, "缺少或非法 severity（期望 low/medium/high/critical）");
  }

  const targetType = body?.target_type?.trim();
  if (!targetType || !VALID_TARGET_TYPES.has(targetType)) {
    return schemaInvalidTable(
      requestId,
      "缺少或非法 target_type（期望 agent/agent_revision/tool_provider/tool/credential/runtime/environment/workload_token/other）",
    );
  }

  const targetId = body?.target_id?.trim();
  if (!targetId) {
    return schemaInvalidTable(requestId, "缺少必填字段 target_id");
  }

  const summary = body?.summary?.trim() || undefined;
  const detectedBy = body?.detected_by?.trim() || detectedByFromAdminPrincipal(principal);

  // 3. action scope 校验：按 tenant 维度授权
  const scopeResult = await requireAdminActionScope(
    principal,
    "security.incident.create",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 4. 创建安全事件
  try {
    const incident = await createSecurityIncident({
      tenantId: principal.tenantId,
      incidentKey,
      severity: severity as IncidentSeverity,
      targetType: targetType as IncidentTargetType,
      targetId,
      summary,
      detectedBy,
      actor: actorFromAdminPrincipal(principal),
      requestId,
    });

    return apiSuccess(projectIncident(incident), {
      status: 201,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    if (err instanceof SecurityIncidentError && err.code === "duplicate_incident_key") {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    throw err;
  }
}

export async function GET(request: Request): Promise<Response> {
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

  // 2. 查询参数解析
  const url = new URL(request.url);
  const severityParam = url.searchParams.get("severity") ?? undefined;
  const stateParam = url.searchParams.get("incident_state") ?? undefined;
  const targetTypeParam = url.searchParams.get("target_type") ?? undefined;
  const detectedByParam = url.searchParams.get("detected_by") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor") ?? undefined;

  if (severityParam && !VALID_SEVERITIES.has(severityParam)) {
    return schemaInvalidTable(requestId, "非法 severity 查询参数");
  }
  if (stateParam && !VALID_STATES.has(stateParam)) {
    return schemaInvalidTable(requestId, "非法 incident_state 查询参数");
  }
  if (targetTypeParam && !VALID_TARGET_TYPES.has(targetTypeParam)) {
    return schemaInvalidTable(requestId, "非法 target_type 查询参数");
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    return schemaInvalidTable(requestId, "非法 limit 查询参数");
  }

  // 3. action scope 校验：按 tenant 维度授权
  const scopeResult = await requireAdminActionScope(
    principal,
    "security.incident.create",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 4. 列出事故
  try {
    const page = await listSecurityIncidents({
      tenantId: principal.tenantId,
      severity: severityParam as IncidentSeverity | undefined,
      incidentState: stateParam as IncidentState | undefined,
      targetType: targetTypeParam as IncidentTargetType | undefined,
      detectedBy: detectedByParam,
      limit,
      cursor,
    });

    return apiSuccess(
      {
        items: page.items.map(projectIncident),
        next_cursor: page.nextCursor,
      },
      { headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch (err) {
    if (err instanceof SecurityIncidentError && err.code === "illegal_transition") {
      // 非法 cursor
      return schemaInvalidTable(requestId, err.message);
    }
    throw err;
  }
}
