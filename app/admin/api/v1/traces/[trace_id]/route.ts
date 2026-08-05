import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { getTraceById } from "@/lib/v11/observability/trace-queries";
/**
 * GET /admin/api/v1/traces/{trace_id} — Trace 单资源详情（S11-W05）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Trace 存在且属于当前租户（跨租户隐藏为 404）。
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

  const trace = await getTraceById(principal.tenantId, traceId);
  if (!trace) {
    return resourceNotFound(requestId, `Trace 不存在或无权访问: ${traceId}`);
  }

  const body = {
    id: trace.id,
    tenant_id: trace.tenantId,
    root_type: trace.rootType,
    root_id: trace.rootId,
    trace_key: trace.traceKey,
    root_span_id: trace.rootSpanId,
    content_mode: trace.contentMode,
    sampling_policy: trace.samplingPolicy,
    sampling_rate: trace.samplingRate,
    trace_state: trace.traceState,
    started_at: trace.startedAt.toISOString(),
    finished_at: trace.finishedAt?.toISOString() ?? null,
    attributes: trace.attributesJson,
    version_no: trace.versionNo,
    created_at: trace.createdAt.toISOString(),
    updated_at: trace.updatedAt.toISOString(),
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
