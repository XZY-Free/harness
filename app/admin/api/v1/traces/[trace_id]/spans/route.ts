import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { getTraceById, listSpansByTrace } from "@/lib/v11/observability/trace-queries";
/**
 * GET /admin/api/v1/traces/{trace_id}/spans — 列出 Trace 下所有 Span（S11-W05）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Trace 存在且属于当前租户（跨租户隐藏为 404）。
 * - Span 按 startedAt 升序返回，便于客户端构建 span 树。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Trace 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ trace_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { trace_id: traceId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 校验 Trace 存在且属于当前租户
  const trace = await getTraceById(principal.tenantId, traceId);
  if (!trace) {
    return resourceNotFound(requestId, `Trace 不存在或无权访问: ${traceId}`);
  }

  const spans = await listSpansByTrace(principal.tenantId, traceId);

  const projected = spans.map((s) => ({
    id: s.id,
    tenant_id: s.tenantId,
    trace_id: s.traceId,
    parent_span_id: s.parentSpanId,
    span_key: s.spanKey,
    name: s.name,
    kind: s.kind,
    span_state: s.spanState,
    started_at: s.startedAt.toISOString(),
    finished_at: s.finishedAt?.toISOString() ?? null,
    attributes: s.attributesJson,
    events: s.eventsJson,
    version_no: s.versionNo,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
