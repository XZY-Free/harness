import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { listEvaluationRunsByTenant } from "@/lib/evaluation/evaluation-queries";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import {
  EVALUATION_RUN_STATES,
  type EvaluationRunState,
} from "@/lib/persistence/schema/evaluation";
/**
 * GET /admin/api/v1/evaluation-runs — 列出租户内所有 EvaluationRun（S11-W06）。
 *
 * 事实源：docs/architecture/runtime-control-plane.md S11-W06。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 支持查询参数 state、agent_revision_id、limit、cursor。
 * - cursor 为不透明 base64url(JSON{ created_at, id })，由 listEvaluationRunsByTenant 解析。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - state/limit/cursor 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

const VALID_RUN_STATES = new Set<string>(EVALUATION_RUN_STATES);

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析 admin 主体
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析查询参数
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const stateParam = url.searchParams.get("state");
  const agentRevisionIdParam = url.searchParams.get("agent_revision_id");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }

  let runState: EvaluationRunState | undefined;
  if (stateParam) {
    if (!VALID_RUN_STATES.has(stateParam)) {
      return schemaInvalidTable(requestId, `state 非法: ${stateParam}`);
    }
    runState = stateParam as EvaluationRunState;
  }

  const agentRevisionId = agentRevisionIdParam ?? undefined;

  // 3. 查询 EvaluationRun
  const { items, nextCursor } = await listEvaluationRunsByTenant(principal.tenantId, {
    runState,
    agentRevisionId,
    limit,
    cursor: cursor ?? null,
  });

  // 4. 投影为 snake_case
  const projected = items.map((r) => ({
    id: r.id,
    tenant_id: r.tenantId,
    job_id: r.jobId,
    agent_revision_id: r.agentRevisionId,
    runtime_revision_id: r.runtimeRevisionId,
    route_id: r.routeId,
    model_ref: r.modelRef,
    dataset_ref: r.datasetRef,
    strategy_key: r.strategyKey,
    run_state: r.runState,
    threshold_config: r.thresholdConfigJson,
    summary: r.summaryJson,
    started_at: r.startedAt?.toISOString() ?? null,
    finished_at: r.finishedAt?.toISOString() ?? null,
    created_by: r.createdBy,
    version_no: r.versionNo,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }));

  return apiSuccess(
    {
      items: projected,
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
      total: projected.length,
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
