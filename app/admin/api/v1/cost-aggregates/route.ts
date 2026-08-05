import { REQUEST_ID_HEADER, getRequestId, apiSuccess } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import { listCostAggregatesByTenant } from "@/lib/v11/operations/usage-queries";
import {
  COST_GRANULARITIES,
  type CostGranularity,
  USAGE_DIMENSIONS,
  USAGE_SCOPE_TYPES,
  type UsageDimension,
  type UsageScopeType,
} from "@/lib/v11/schema/usage";
/**
 * GET /admin/api/v1/cost-aggregates — 列出租户内所有 CostAggregate（S11-W07）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W07。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 支持查询参数 dimension、scope_type、granularity、window_from、window_to、limit、cursor。
 * - cursor 为不透明 base64url(JSON{ window_start, id })，由 listCostAggregatesByTenant 解析。
 * - bigint 字段（total_quantity/total_cost_micros）序列化为 string。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - dimension/scope_type/granularity/limit/cursor/window_from/window_to 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

const VALID_DIMENSIONS = new Set<string>(USAGE_DIMENSIONS);
const VALID_SCOPE_TYPES = new Set<string>(USAGE_SCOPE_TYPES);
const VALID_GRANULARITIES = new Set<string>(COST_GRANULARITIES);

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const dimensionParam = url.searchParams.get("dimension");
  const scopeTypeParam = url.searchParams.get("scope_type");
  const granularityParam = url.searchParams.get("granularity");
  const windowFromParam = url.searchParams.get("window_from");
  const windowToParam = url.searchParams.get("window_to");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  let dimension: UsageDimension | undefined;
  if (dimensionParam) {
    if (!VALID_DIMENSIONS.has(dimensionParam)) {
      return v11SchemaInvalid(requestId, `dimension 非法: ${dimensionParam}`);
    }
    dimension = dimensionParam as UsageDimension;
  }

  let scopeType: UsageScopeType | undefined;
  if (scopeTypeParam) {
    if (!VALID_SCOPE_TYPES.has(scopeTypeParam)) {
      return v11SchemaInvalid(requestId, `scope_type 非法: ${scopeTypeParam}`);
    }
    scopeType = scopeTypeParam as UsageScopeType;
  }

  let granularity: CostGranularity | undefined;
  if (granularityParam) {
    if (!VALID_GRANULARITIES.has(granularityParam)) {
      return v11SchemaInvalid(requestId, `granularity 非法: ${granularityParam}`);
    }
    granularity = granularityParam as CostGranularity;
  }

  let windowFrom: Date | undefined;
  if (windowFromParam) {
    windowFrom = new Date(windowFromParam);
    if (Number.isNaN(windowFrom.getTime())) {
      return v11SchemaInvalid(requestId, `window_from 不是合法 ISO 时间: ${windowFromParam}`);
    }
  }

  let windowTo: Date | undefined;
  if (windowToParam) {
    windowTo = new Date(windowToParam);
    if (Number.isNaN(windowTo.getTime())) {
      return v11SchemaInvalid(requestId, `window_to 不是合法 ISO 时间: ${windowToParam}`);
    }
  }

  const { items, nextCursor } = await listCostAggregatesByTenant(principal.tenantId, {
    dimension,
    scopeType,
    granularity,
    windowFrom,
    windowTo,
    limit,
    cursor: cursor ?? null,
  });

  const projected = items.map((a) => ({
    id: a.id,
    tenant_id: a.tenantId,
    dimension: a.dimension,
    scope_type: a.scopeType,
    scope_ref: a.scopeRef,
    window_start: a.windowStart.toISOString(),
    window_end: a.windowEnd.toISOString(),
    granularity: a.granularity,
    total_quantity: a.totalQuantity.toString(),
    total_cost_micros: a.totalCostMicros.toString(),
    record_count: a.recordCount,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
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
