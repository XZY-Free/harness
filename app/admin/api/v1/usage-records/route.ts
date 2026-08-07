import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import {
  USAGE_DIMENSIONS,
  USAGE_SCOPE_TYPES,
  type UsageDimension,
  type UsageScopeType,
} from "@/lib/persistence/schema/usage";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { listUsageRecordsByTenant } from "@/lib/operations/usage-queries";
/**
 * GET /admin/api/v1/usage-records — 列出租户内所有 UsageRecord（S11-W07）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W07。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 支持查询参数 dimension、scope_type、observed_from、observed_to、limit、cursor。
 * - cursor 为不透明 base64url(JSON{ observed_at, id })，由 listUsageRecordsByTenant 解析。
 * - bigint 字段（quantity/unit_cost_micros/total_cost_micros）序列化为 string。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - dimension/scope_type/limit/cursor/observed_from/observed_to 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

const VALID_DIMENSIONS = new Set<string>(USAGE_DIMENSIONS);
const VALID_SCOPE_TYPES = new Set<string>(USAGE_SCOPE_TYPES);

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
  const dimensionParam = url.searchParams.get("dimension");
  const scopeTypeParam = url.searchParams.get("scope_type");
  const observedFromParam = url.searchParams.get("observed_from");
  const observedToParam = url.searchParams.get("observed_to");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }

  let dimension: UsageDimension | undefined;
  if (dimensionParam) {
    if (!VALID_DIMENSIONS.has(dimensionParam)) {
      return schemaInvalidTable(requestId, `dimension 非法: ${dimensionParam}`);
    }
    dimension = dimensionParam as UsageDimension;
  }

  let scopeType: UsageScopeType | undefined;
  if (scopeTypeParam) {
    if (!VALID_SCOPE_TYPES.has(scopeTypeParam)) {
      return schemaInvalidTable(requestId, `scope_type 非法: ${scopeTypeParam}`);
    }
    scopeType = scopeTypeParam as UsageScopeType;
  }

  let observedFrom: Date | undefined;
  if (observedFromParam) {
    observedFrom = new Date(observedFromParam);
    if (Number.isNaN(observedFrom.getTime())) {
      return schemaInvalidTable(requestId, `observed_from 不是合法 ISO 时间: ${observedFromParam}`);
    }
  }

  let observedTo: Date | undefined;
  if (observedToParam) {
    observedTo = new Date(observedToParam);
    if (Number.isNaN(observedTo.getTime())) {
      return schemaInvalidTable(requestId, `observed_to 不是合法 ISO 时间: ${observedToParam}`);
    }
  }

  // 3. 查询 UsageRecord
  const { items, nextCursor } = await listUsageRecordsByTenant(principal.tenantId, {
    dimension,
    scopeType,
    observedFrom,
    observedTo,
    limit,
    cursor: cursor ?? null,
  });

  // 4. 投影为 snake_case + bigint 序列化为 string
  const projected = items.map((r) => ({
    id: r.id,
    tenant_id: r.tenantId,
    dimension: r.dimension,
    scope_type: r.scopeType,
    scope_ref: r.scopeRef,
    agent_revision_id: r.agentRevisionId,
    model_ref: r.modelRef,
    tool_provider_id: r.toolProviderId,
    environment_id: r.environmentId,
    job_id: r.jobId,
    invocation_id: r.invocationId,
    quantity: r.quantity.toString(),
    unit_cost_micros: r.unitCostMicros ? r.unitCostMicros.toString() : null,
    total_cost_micros: r.totalCostMicros ? r.totalCostMicros.toString() : null,
    observed_at: r.observedAt.toISOString(),
    created_at: r.createdAt.toISOString(),
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
