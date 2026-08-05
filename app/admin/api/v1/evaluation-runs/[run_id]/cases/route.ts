import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  EVALUATION_CASE_STATES,
  type EvaluationCaseState,
} from "@/lib/persistence/schema/evaluation";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/v11/admin/route-helpers";
import {
  getEvaluationRunById,
  listEvaluationCasesByRun,
} from "@/lib/v11/evaluation/evaluation-queries";
/**
 * GET /admin/api/v1/evaluation-runs/{run_id}/cases — 列出 Run 下所有 Case（S11-W06）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Run 存在且属于当前租户（跨租户隐藏为 404）。
 * - 支持查询参数 state 过滤、limit。
 * - Case 按 createdAt 升序返回。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Run 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - state 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

const VALID_CASE_STATES = new Set<string>(EVALUATION_CASE_STATES);

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
  const stateParam = url.searchParams.get("state");
  const limitParam = url.searchParams.get("limit");

  let caseState: EvaluationCaseState | undefined;
  if (stateParam) {
    if (!VALID_CASE_STATES.has(stateParam)) {
      return schemaInvalidTable(requestId, `state 非法: ${stateParam}`);
    }
    caseState = stateParam as EvaluationCaseState;
  }

  let limit: number | undefined;
  if (limitParam) {
    limit = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      return schemaInvalidTable(requestId, "limit 必须是正整数");
    }
  }

  const cases = await listEvaluationCasesByRun(principal.tenantId, runId, {
    caseState,
    limit,
  });

  const projected = cases.map((c) => ({
    id: c.id,
    tenant_id: c.tenantId,
    run_id: c.runId,
    case_key: c.caseKey,
    scenario_ref: c.scenarioRef,
    input: c.inputRedactedJson,
    expected: c.expectedJson,
    actual: c.actualRedactedJson,
    case_state: c.caseState,
    failure_reason: c.failureReason,
    evidence: c.evidenceJson,
    created_at: c.createdAt.toISOString(),
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
