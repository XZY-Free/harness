import { REQUEST_ID_HEADER, getRequestId, v11NotFound, v11Ok } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { getObservationById } from "@/lib/v11/observability/observation-queries";
/**
 * GET /admin/api/v1/observations/{observation_id} — Observation 单资源详情（S11-W05）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Observation 存在且属于当前租户（跨租户隐藏为 404）。
 * - 投影为 snake_case；content_json 为已脱敏内容（contains_secret 强制 false）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Observation 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ observation_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { observation_id: observationId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const observation = await getObservationById(principal.tenantId, observationId);
  if (!observation) {
    return v11NotFound(requestId, `Observation 不存在或无权访问: ${observationId}`);
  }

  const body = {
    id: observation.id,
    tenant_id: observation.tenantId,
    trace_id: observation.traceId,
    span_id: observation.spanId,
    invocation_id: observation.invocationId,
    kind: observation.kind,
    content_mode: observation.contentMode,
    content: observation.contentJson,
    contains_secret: observation.containsSecret,
    redaction_summary: observation.redactionSummary,
    observed_at: observation.observedAt.toISOString(),
    created_at: observation.createdAt.toISOString(),
  };

  return v11Ok(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
