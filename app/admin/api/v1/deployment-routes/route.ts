import { REQUEST_ID_HEADER, getRequestId, v11Ok } from "@/lib/http";
/**
 * GET /admin/api/v1/deployment-routes — 列出 DeploymentRoute（S11-W02）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md
 *   S11-W02：「管理 Agent 元数据、访问范围、Revision、RuntimeRevision、DeploymentRoute、灰度、回滚和下线」
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 必填查询参数 agent_id（按 Agent 过滤 RouteSet）。
 * - 可选查询参数 scope_key（按 routeScopeKey 过滤，如 prod/canary；默认 "default"）。
 * - 调用 getRouteSetByAgentScope + listRoutesBySet 返回 Route 列表。
 * - 返回 200 + Route 投影数组 + RouteSet ETag（供 PUT 时 If-Match 使用）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 agent_id → 400 REQUEST_SCHEMA_INVALID
 * - RouteSet 不存在 → 200 空数组（非错误，Agent 未配置路由）
 */
import {
  type AdminPrincipal,
  ROUTE_SET_ETAG_PREFIX,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import {
  getRouteSetByAgentScope,
  listRoutesBySet,
} from "@/lib/v11/control-plane/deployment-route-queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    return authResp ?? v11Ok({ items: [], total: 0 });
  }

  const url = new URL(request.url);
  const agentId = url.searchParams.get("agent_id");
  if (!agentId) {
    return v11SchemaInvalid(requestId, "缺少必填查询参数 agent_id");
  }
  const scopeKey = url.searchParams.get("scope_key") ?? "default";

  // 查询 RouteSet（不存在 → 200 空数组，Agent 未配置路由）
  const routeSet = await getRouteSetByAgentScope(principal.tenantId, agentId, scopeKey);
  if (!routeSet) {
    return v11Ok(
      { items: [], total: 0, route_set: null, etag: null },
      { headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  }

  // 查询 Route 列表
  const routes = await listRoutesBySet(routeSet.id);
  const projected = routes.map((route) => ({
    id: route.id,
    route_set_id: route.routeSetId,
    agent_revision_id: route.agentRevisionId,
    runtime_revision_id: route.runtimeRevisionId,
    traffic_weight: route.trafficWeight,
    priority_no: route.priorityNo,
    route_state: route.routeState,
    effective_from: route.effectiveFrom?.toISOString() ?? null,
    effective_until: route.effectiveUntil?.toISOString() ?? null,
  }));

  return v11Ok(
    {
      items: projected,
      total: projected.length,
      route_set: {
        id: routeSet.id,
        agent_id: routeSet.agentId,
        route_scope_key: routeSet.routeScopeKey,
        version_no: routeSet.versionNo,
      },
      etag: `${ROUTE_SET_ETAG_PREFIX}${routeSet.versionNo}`,
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
