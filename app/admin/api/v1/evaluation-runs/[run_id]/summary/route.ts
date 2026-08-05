import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { getEvaluationRunById } from "@/lib/v11/evaluation/evaluation-queries";
/**
 * GET /admin/api/v1/evaluation-runs/{run_id}/summary — Run Summary 投影（S11-W06）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Run 存在且属于当前租户（跨租户隐藏为 404）。
 * - 返回 Run 终态时写入的 summary 投影（可比较指标）；未写入时为 null。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Run 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
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

  const body = {
    run_id: run.id,
    run_state: run.runState,
    summary: run.summaryJson,
    threshold_config: run.thresholdConfigJson,
    strategy_key: run.strategyKey,
    started_at: run.startedAt?.toISOString() ?? null,
    finished_at: run.finishedAt?.toISOString() ?? null,
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
