import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { getCostAggregateById } from "@/lib/operations/usage-queries";
/**
 * GET /admin/api/v1/cost-aggregates/{aggregate_id} — CostAggregate 单资源详情（S11-W07）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 CostAggregate 存在且属于当前租户（跨租户隐藏为 404）。
 * - 投影为 snake_case + bigint 字段序列化为 string。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - CostAggregate 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ aggregate_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { aggregate_id: aggregateId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const aggregate = await getCostAggregateById(principal.tenantId, aggregateId);
  if (!aggregate) {
    return resourceNotFound(requestId, `CostAggregate 不存在或无权访问: ${aggregateId}`);
  }

  const body = {
    id: aggregate.id,
    tenant_id: aggregate.tenantId,
    dimension: aggregate.dimension,
    scope_type: aggregate.scopeType,
    scope_ref: aggregate.scopeRef,
    window_start: aggregate.windowStart.toISOString(),
    window_end: aggregate.windowEnd.toISOString(),
    granularity: aggregate.granularity,
    total_quantity: aggregate.totalQuantity.toString(),
    total_cost_micros: aggregate.totalCostMicros.toString(),
    record_count: aggregate.recordCount,
    created_at: aggregate.createdAt.toISOString(),
    updated_at: aggregate.updatedAt.toISOString(),
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
