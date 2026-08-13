import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import { listCapacitySnapshotsByTenant } from "@/lib/operations/usage-queries";
import { CAPACITY_SCOPE_TYPES, type CapacityScopeType } from "@/lib/persistence/schema/usage";
/**
 * GET /admin/api/v1/capacity-snapshots — 列出租户内所有 CapacitySnapshot（S11-W07）。
 *
 * 事实源：docs/architecture/runtime-control-plane.md S11-W07。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 支持查询参数 scope_type、scope_ref、limit、cursor。
 * - cursor 为不透明 base64url(JSON{ snapshot_at, id })，由 listCapacitySnapshotsByTenant 解析。
 * - bigint 字段（limit_tokens_per_minute/limit_cost_per_hour_micros）序列化为 string。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - scope_type/limit/cursor 非法 → 400 REQUEST_SCHEMA_INVALID
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
  const cursor = url.searchParams.get("cursor");
  const scopeTypeParam = url.searchParams.get("scope_type");
  const scopeRefParam = url.searchParams.get("scope_ref");

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

  const scopeRef = scopeRefParam ?? undefined;

  const { items, nextCursor } = await listCapacitySnapshotsByTenant(principal.tenantId, {
    scopeType,
    scopeRef,
    limit,
    cursor: cursor ?? null,
  });

  const projected = items.map((s) => ({
    id: s.id,
    tenant_id: s.tenantId,
    scope_type: s.scopeType,
    scope_ref: s.scopeRef,
    active_invocations: s.activeInvocations,
    queued_jobs: s.queuedJobs,
    cold_starts_last_hour: s.coldStartsLastHour,
    limit_invocations_per_minute: s.limitInvocationsPerMinute,
    limit_tokens_per_minute: s.limitTokensPerMinute ? s.limitTokensPerMinute.toString() : null,
    limit_cost_per_hour_micros: s.limitCostPerHourMicros
      ? s.limitCostPerHourMicros.toString()
      : null,
    failure_count_last_hour: s.failureCountLastHour,
    snapshot_at: s.snapshotAt.toISOString(),
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
