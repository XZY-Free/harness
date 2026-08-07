import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
/**
 * GET /admin/api/v1/audit-events — 列出租户审计事件（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 支持查询参数 actor_type、actor_id、action_type、target_type、target_id、
 *   occurred_from、occurred_to、limit。
 * - 调用 listAuditEvents（按 occurred_at 升序，跨租户隔离）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - actor_type 非法 → 400 REQUEST_SCHEMA_INVALID
 * - occurred_from / occurred_to 不是合法 ISO 时间 → 400 REQUEST_SCHEMA_INVALID
 * - limit 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

const VALID_ACTOR_TYPES = new Set(["user", "service", "workload", "system"]);

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
  const actorTypeParam = url.searchParams.get("actor_type");
  const actorId = url.searchParams.get("actor_id") ?? undefined;
  const actionType = url.searchParams.get("action_type") ?? undefined;
  const targetType = url.searchParams.get("target_type") ?? undefined;
  const targetId = url.searchParams.get("target_id") ?? undefined;
  const occurredFromParam = url.searchParams.get("occurred_from");
  const occurredToParam = url.searchParams.get("occurred_to");
  const limitParam = url.searchParams.get("limit");

  let actorType: "user" | "service" | "workload" | "system" | undefined;
  if (actorTypeParam) {
    if (!VALID_ACTOR_TYPES.has(actorTypeParam)) {
      return schemaInvalidTable(requestId, `actor_type 非法: ${actorTypeParam}`);
    }
    actorType = actorTypeParam as "user" | "service" | "workload" | "system";
  }

  let occurredFrom: Date | undefined;
  if (occurredFromParam) {
    occurredFrom = new Date(occurredFromParam);
    if (Number.isNaN(occurredFrom.getTime())) {
      return schemaInvalidTable(requestId, "occurred_from 不是合法 ISO 时间");
    }
  }

  let occurredTo: Date | undefined;
  if (occurredToParam) {
    occurredTo = new Date(occurredToParam);
    if (Number.isNaN(occurredTo.getTime())) {
      return schemaInvalidTable(requestId, "occurred_to 不是合法 ISO 时间");
    }
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }

  // 3. 查询审计事件
  const events = await listAuditEvents({
    tenantId: principal.tenantId,
    actorType,
    actorId,
    actionType,
    targetType,
    targetId,
    occurredFrom,
    occurredTo,
    limit,
  });

  // 4. 投影并返回 200
  const projected = events.map((e) => ({
    id: e.id,
    tenant_id: e.tenantId,
    actor_type: e.actorType,
    actor_id: e.actorId,
    action_type: e.actionType,
    target_type: e.targetType,
    target_id: e.targetId,
    before_hash: e.beforeHash,
    after_hash: e.afterHash,
    reason: e.reason,
    request_id: e.requestId,
    occurred_at: e.occurredAt.toISOString(),
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
