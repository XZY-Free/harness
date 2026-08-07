import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { getCapacitySnapshotById } from "@/lib/operations/usage-queries";
/**
 * GET /admin/api/v1/capacity-snapshots/{snapshot_id} — CapacitySnapshot 单资源详情（S11-W07）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 CapacitySnapshot 存在且属于当前租户（跨租户隐藏为 404）。
 * - 投影为 snake_case + bigint 字段序列化为 string。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - CapacitySnapshot 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ snapshot_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { snapshot_id: snapshotId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const snapshot = await getCapacitySnapshotById(principal.tenantId, snapshotId);
  if (!snapshot) {
    return resourceNotFound(requestId, `CapacitySnapshot 不存在或无权访问: ${snapshotId}`);
  }

  const body = {
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
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
