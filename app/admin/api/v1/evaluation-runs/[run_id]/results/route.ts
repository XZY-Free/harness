import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  getEvaluationRunById,
  listEvaluationResultsByRun,
} from "@/lib/evaluation/evaluation-queries";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
/**
 * GET /admin/api/v1/evaluation-runs/{run_id}/results — 列出 Run 下所有 Result（S11-W06）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Run 存在且属于当前租户（跨租户隐藏为 404）。
 * - 支持查询参数 metric_key 过滤、limit。
 * - Result 按 createdAt 升序返回。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Run 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - limit 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ run_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { run_id: runId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 校验 Run 存在且属于当前租户
  const run = await getEvaluationRunById(principal.tenantId, runId);
  if (!run) {
    return resourceNotFound(requestId, `EvaluationRun 不存在或无权访问: ${runId}`);
  }

  // 解析查询参数
  const url = new URL(request.url);
  const metricKey = url.searchParams.get("metric_key") ?? undefined;
  const limitParam = url.searchParams.get("limit");

  let limit: number | undefined;
  if (limitParam) {
    limit = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      return schemaInvalidTable(requestId, "limit 必须是正整数");
    }
  }

  const results = await listEvaluationResultsByRun(principal.tenantId, runId, {
    metricKey,
    limit,
  });

  const projected = results.map((r) => ({
    id: r.id,
    tenant_id: r.tenantId,
    run_id: r.runId,
    case_id: r.caseId,
    metric_key: r.metricKey,
    metric_value: r.metricValue,
    comparator: r.comparator,
    threshold_value: r.thresholdValue,
    passed: r.passed,
    created_at: r.createdAt.toISOString(),
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
