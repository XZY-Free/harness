import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { getEvaluationRunById } from "@/lib/evaluation/evaluation-queries";
/**
 * GET /admin/api/v1/evaluation-runs/{run_id} — EvaluationRun 单资源详情（S11-W06）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 EvaluationRun 存在且属于当前租户（跨租户隐藏为 404）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - EvaluationRun 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
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

  const run = await getEvaluationRunById(principal.tenantId, runId);
  if (!run) {
    return resourceNotFound(requestId, `EvaluationRun 不存在或无权访问: ${runId}`);
  }

  const body = {
    id: run.id,
    tenant_id: run.tenantId,
    job_id: run.jobId,
    agent_revision_id: run.agentRevisionId,
    runtime_revision_id: run.runtimeRevisionId,
    route_id: run.routeId,
    model_ref: run.modelRef,
    dataset_ref: run.datasetRef,
    strategy_key: run.strategyKey,
    run_state: run.runState,
    threshold_config: run.thresholdConfigJson,
    summary: run.summaryJson,
    started_at: run.startedAt?.toISOString() ?? null,
    finished_at: run.finishedAt?.toISOString() ?? null,
    created_by: run.createdBy,
    version_no: run.versionNo,
    created_at: run.createdAt.toISOString(),
    updated_at: run.updatedAt.toISOString(),
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
