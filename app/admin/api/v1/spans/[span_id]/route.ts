import { REQUEST_ID_HEADER, getRequestId, v11NotFound, v11Ok } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { getSpanById } from "@/lib/v11/observability/trace-queries";
/**
 * GET /admin/api/v1/spans/{span_id} — Span 单资源详情（S11-W05）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Span 存在且属于当前租户（跨租户隐藏为 404）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Span 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ span_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { span_id: spanId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const span = await getSpanById(principal.tenantId, spanId);
  if (!span) {
    return v11NotFound(requestId, `Span 不存在或无权访问: ${spanId}`);
  }

  const body = {
    id: span.id,
    tenant_id: span.tenantId,
    trace_id: span.traceId,
    parent_span_id: span.parentSpanId,
    span_key: span.spanKey,
    name: span.name,
    kind: span.kind,
    span_state: span.spanState,
    started_at: span.startedAt.toISOString(),
    finished_at: span.finishedAt?.toISOString() ?? null,
    attributes: span.attributesJson,
    events: span.eventsJson,
    version_no: span.versionNo,
    created_at: span.createdAt.toISOString(),
    updated_at: span.updatedAt.toISOString(),
  };

  return v11Ok(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
