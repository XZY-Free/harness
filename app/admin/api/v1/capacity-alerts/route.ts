import { REQUEST_ID_HEADER, getRequestId, apiSuccess } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import { getCapacityAlertsByTenant } from "@/lib/v11/operations/usage-queries";
import { CAPACITY_SCOPE_TYPES, type CapacityScopeType } from "@/lib/v11/schema/usage";
/**
 * GET /admin/api/v1/capacity-alerts — 当前活跃告警（S11-W07）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W07。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 返回 breach=true 的 ServiceLevelIndicator + 关联最近 CapacitySnapshot + 可跳转引用。
 * - 支持查询参数 scope_type、scope_ref、limit（无 cursor：告警为短时窗口视图，不分页）。
 * - bigint 字段（latestSnapshot.limit_tokens_per_minute/limit_cost_per_hour_micros）序列化为 string。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - scope_type/limit 非法 → 400 REQUEST_SCHEMA_INVALID
 *
 * 设计取舍：
 * - 告警从可执行阈值产生，并能跳转相关 Invocation/Event/Trace（不建设无来源的装饰仪表盘）。
 * - 不返回 next_cursor：告警数量由阈值决定，前 N 条已足够驱动操作；如需翻页可改用 service-level-indicators?breach_only=true。
 */

export const dynamic = "force-dynamic";

const VALID_SCOPE_TYPES = new Set<string>(CAPACITY_SCOPE_TYPES);

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
  const scopeTypeParam = url.searchParams.get("scope_type");
  const scopeRefParam = url.searchParams.get("scope_ref");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  let scopeType: CapacityScopeType | undefined;
  if (scopeTypeParam) {
    if (!VALID_SCOPE_TYPES.has(scopeTypeParam)) {
      return v11SchemaInvalid(requestId, `scope_type 非法: ${scopeTypeParam}`);
    }
    scopeType = scopeTypeParam as CapacityScopeType;
  }

  const scopeRef = scopeRefParam ?? undefined;

  const { items } = await getCapacityAlertsByTenant(principal.tenantId, {
    scopeType,
    scopeRef,
    limit,
  });

  const projected = items.map((entry) => {
    const sli = entry.indicator;
    const snapshot = entry.latestSnapshot;
    return {
      indicator: {
        id: sli.id,
        tenant_id: sli.tenantId,
        scope_type: sli.scopeType,
        scope_ref: sli.scopeRef,
        indicator_key: sli.indicatorKey,
        indicator_value: sli.indicatorValue,
        threshold_value: sli.thresholdValue,
        breach: sli.breach,
        error_code: sli.errorCode,
        measured_at: sli.measuredAt.toISOString(),
        created_at: sli.createdAt.toISOString(),
      },
      latest_snapshot: snapshot
        ? {
            id: snapshot.id,
            tenant_id: snapshot.tenantId,
            scope_type: snapshot.scopeType,
            scope_ref: snapshot.scopeRef,
            active_invocations: snapshot.activeInvocations,
            queued_jobs: snapshot.queuedJobs,
            cold_starts_last_hour: snapshot.coldStartsLastHour,
            limit_invocations_per_minute: snapshot.limitInvocationsPerMinute,
            limit_tokens_per_minute: snapshot.limitTokensPerMinute
              ? snapshot.limitTokensPerMinute.toString()
              : null,
            limit_cost_per_hour_micros: snapshot.limitCostPerHourMicros
              ? snapshot.limitCostPerHourMicros.toString()
              : null,
            failure_count_last_hour: snapshot.failureCountLastHour,
            snapshot_at: snapshot.snapshotAt.toISOString(),
            created_at: snapshot.createdAt.toISOString(),
          }
        : null,
      alert_invocation_id: entry.alertInvocationId,
      alert_trace_id: entry.alertTraceId,
    };
  });

  return apiSuccess(
    {
      items: projected,
      total: projected.length,
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
