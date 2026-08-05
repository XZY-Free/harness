import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import {
  CAPACITY_SCOPE_TYPES,
  type CapacityScopeType,
  SLI_KEYS,
  type SliKey,
} from "@/lib/persistence/schema/usage";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/v11/admin/route-helpers";
import { listServiceLevelIndicatorsByTenant } from "@/lib/v11/operations/usage-queries";
/**
 * GET /admin/api/v1/service-level-indicators — 列出租户内所有 ServiceLevelIndicator（S11-W07）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W07。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 支持查询参数 scope_type、indicator_key、breach_only=true、limit、cursor。
 * - cursor 为不透明 base64url(JSON{ measured_at, id })，由 listServiceLevelIndicatorsByTenant 解析。
 * - decimal 字段（indicator_value/threshold_value）由 Drizzle 读出为 string，直接透传。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - scope_type/indicator_key/limit/cursor 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

const VALID_SCOPE_TYPES = new Set<string>(CAPACITY_SCOPE_TYPES);
const VALID_SLI_KEYS = new Set<string>(SLI_KEYS);

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
  const scopeTypeParam = url.searchParams.get("scope_type");
  const indicatorKeyParam = url.searchParams.get("indicator_key");
  const breachOnlyParam = url.searchParams.get("breach_only");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }

  let scopeType: CapacityScopeType | undefined;
  if (scopeTypeParam) {
    if (!VALID_SCOPE_TYPES.has(scopeTypeParam)) {
      return schemaInvalidTable(requestId, `scope_type 非法: ${scopeTypeParam}`);
    }
    scopeType = scopeTypeParam as CapacityScopeType;
  }

  let indicatorKey: SliKey | undefined;
  if (indicatorKeyParam) {
    if (!VALID_SLI_KEYS.has(indicatorKeyParam)) {
      return schemaInvalidTable(requestId, `indicator_key 非法: ${indicatorKeyParam}`);
    }
    indicatorKey = indicatorKeyParam as SliKey;
  }

  // breach_only=true 时只返回 breach=true 的告警 SLI
  let breachOnly = false;
  if (breachOnlyParam !== null) {
    if (breachOnlyParam !== "true" && breachOnlyParam !== "false") {
      return schemaInvalidTable(requestId, `breach_only 必须为 true/false: ${breachOnlyParam}`);
    }
    breachOnly = breachOnlyParam === "true";
  }

  const { items, nextCursor } = await listServiceLevelIndicatorsByTenant(principal.tenantId, {
    scopeType,
    indicatorKey,
    breachOnly,
    limit,
    cursor: cursor ?? null,
  });

  const projected = items.map((s) => ({
    id: s.id,
    tenant_id: s.tenantId,
    scope_type: s.scopeType,
    scope_ref: s.scopeRef,
    indicator_key: s.indicatorKey,
    indicator_value: s.indicatorValue,
    threshold_value: s.thresholdValue,
    breach: s.breach,
    alert_invocation_id: s.alertInvocationId,
    alert_trace_id: s.alertTraceId,
    error_code: s.errorCode,
    measured_at: s.measuredAt.toISOString(),
    created_at: s.createdAt.toISOString(),
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
