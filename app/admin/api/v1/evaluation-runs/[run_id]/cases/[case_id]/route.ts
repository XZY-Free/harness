import { REQUEST_ID_HEADER, getRequestId, resourceNotFound, apiSuccess } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import {
  getEvaluationCaseById,
  getEvaluationRunById,
} from "@/lib/v11/evaluation/evaluation-queries";
/**
 * GET /admin/api/v1/evaluation-runs/{run_id}/cases/{case_id} — Case 单资源详情（S11-W06）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Run 存在且属于当前租户（跨租户隐藏为 404）。
 * - 校验 Case 存在且属于该 Run 与当前租户。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Run/Case 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ run_id: string; case_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { run_id: runId, case_id: caseId } = await context.params;

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

  const caseRow = await getEvaluationCaseById(principal.tenantId, caseId);
  if (!caseRow || caseRow.runId !== runId) {
    return resourceNotFound(requestId, `EvaluationCase 不存在或无权访问: ${caseId}`);
  }

  const body = {
    id: caseRow.id,
    tenant_id: caseRow.tenantId,
    run_id: caseRow.runId,
    case_key: caseRow.caseKey,
    scenario_ref: caseRow.scenarioRef,
    input: caseRow.inputRedactedJson,
    expected: caseRow.expectedJson,
    actual: caseRow.actualRedactedJson,
    case_state: caseRow.caseState,
    failure_reason: caseRow.failureReason,
    evidence: caseRow.evidenceJson,
    created_at: caseRow.createdAt.toISOString(),
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
