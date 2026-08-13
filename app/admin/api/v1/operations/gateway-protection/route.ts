/**
 * GET /admin/api/v1/operations/gateway-protection — 查看网关保护状态（S12-W02）。
 *
 * 事实源：
 * - docs/architecture/security.md §2.2
 * - docs/architecture/security.md S12-W02
 *
 * 行为：
 * - 解析 admin 主体。
 * - 校验 action scope: admin.operations.read + resource { type: "tenant", id: tenantId }。
 * - 返回当前进程实例的过载、限流和 SSE 连接配额状态（只读快照）。
 * - 多实例部署时每实例独立计数；调用方需知此为单实例视图。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 */
import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { getOverloadProtector } from "@/lib/gateway/overload-protection";
import { getRateLimiter } from "@/lib/gateway/rate-limiter";
import { getSSEConnectionQuota } from "@/lib/gateway/sse-connection-quota";

export const dynamic = "force-dynamic";

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

  // 2. 校验 action scope: admin.operations.read + tenant 资源
  const scopeResult = await requireAdminActionScope(
    principal,
    "admin.operations.read",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 3. 采集进程级快照（只读）
  const overload = getOverloadProtector();
  const rateLimiter = getRateLimiter();
  const sseQuota = getSSEConnectionQuota();

  const overloadConfig = overload.getConfig();
  const priorityCounts = overload.getPriorityCounts();
  const rateLimitConfigs = rateLimiter.getConfigs();
  const sseConfig = sseQuota.getConfig();
  const sseSnapshot = sseQuota.getSnapshot();

  // 4. 投影为 snake_case 并返回 200
  const body = {
    overload: {
      concurrent: overload.getConcurrent(),
      max_concurrent: overloadConfig.maxConcurrent,
      priority_counts: {
        critical: priorityCounts.critical,
        high: priorityCounts.high,
        normal: priorityCounts.normal,
        low: priorityCounts.low,
      },
      thresholds: {
        critical: overloadConfig.thresholds.critical,
        high: overloadConfig.thresholds.high,
        normal: overloadConfig.thresholds.normal,
        low: overloadConfig.thresholds.low,
      },
    },
    rate_limit: {
      configs: {
        tenant: {
          capacity: rateLimitConfigs.tenant.capacity,
          refill_rate_per_second: rateLimitConfigs.tenant.refillRatePerSecond,
        },
        user: {
          capacity: rateLimitConfigs.user.capacity,
          refill_rate_per_second: rateLimitConfigs.user.refillRatePerSecond,
        },
        thread: {
          capacity: rateLimitConfigs.thread.capacity,
          refill_rate_per_second: rateLimitConfigs.thread.refillRatePerSecond,
        },
        runtime: {
          capacity: rateLimitConfigs.runtime.capacity,
          refill_rate_per_second: rateLimitConfigs.runtime.refillRatePerSecond,
        },
        high_cost: {
          capacity: rateLimitConfigs.high_cost.capacity,
          refill_rate_per_second: rateLimitConfigs.high_cost.refillRatePerSecond,
        },
      },
    },
    sse_quota: {
      configs: {
        max_per_tenant: sseConfig.maxPerTenant,
        max_per_user: sseConfig.maxPerUser,
        max_per_thread: sseConfig.maxPerThread,
      },
      total_active: {
        tenant: sseSnapshot.totalActive.tenant,
        user: sseSnapshot.totalActive.user,
        thread: sseSnapshot.totalActive.thread,
      },
      unique_scopes: {
        tenant: sseSnapshot.uniqueScopes.tenant,
        user: sseSnapshot.uniqueScopes.user,
        thread: sseSnapshot.uniqueScopes.thread,
      },
    },
  };

  return apiSuccess(body, {
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
