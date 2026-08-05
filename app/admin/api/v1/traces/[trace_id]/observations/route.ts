import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { OBSERVATION_KINDS, type ObservationKind } from "@/lib/persistence/schema/trace";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/v11/admin/route-helpers";
import { listObservationsByTrace } from "@/lib/v11/observability/observation-queries";
import { getTraceById } from "@/lib/v11/observability/trace-queries";
/**
 * GET /admin/api/v1/traces/{trace_id}/observations — 列出 Trace 下所有 Observation（S11-W05）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Trace 存在且属于当前租户（跨租户隐藏为 404）。
 * - 支持查询参数 kind 过滤。
 * - 投影为 snake_case；content_json 为已脱敏内容（contains_secret 强制 false）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Trace 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - kind 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

const VALID_KINDS = new Set<string>(OBSERVATION_KINDS);

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

  // 解析 kind 查询参数
  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind");
  let kind: ObservationKind | undefined;
  if (kindParam) {
    if (!VALID_KINDS.has(kindParam)) {
      return schemaInvalidTable(requestId, `kind 非法: ${kindParam}`);
    }
    kind = kindParam as ObservationKind;
  }

  // 校验 Trace 存在且属于当前租户
  const trace = await getTraceById(principal.tenantId, traceId);
  if (!trace) {
    return resourceNotFound(requestId, `Trace 不存在或无权访问: ${traceId}`);
  }

  const observations = await listObservationsByTrace(principal.tenantId, traceId, { kind });

  const projected = observations.map((o) => ({
    id: o.id,
    tenant_id: o.tenantId,
    trace_id: o.traceId,
    span_id: o.spanId,
    invocation_id: o.invocationId,
    kind: o.kind,
    content_mode: o.contentMode,
    content: o.contentJson,
    contains_secret: o.containsSecret,
    redaction_summary: o.redactionSummary,
    observed_at: o.observedAt.toISOString(),
    created_at: o.createdAt.toISOString(),
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
