/**
 * POST /admin/api/v1/control-plane-cutovers — 创建 Cutover 计划（扫描）。
 *
 * :plan 只做扫描和计划生成，不执行修改。
 * 需要：管理权限 + Idempotency-Key + 写 Audit。
 */

import { randomUUID } from "node:crypto";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  getRequestId,
  v11Error,
  v11Ok,
} from "@/lib/http";
import { actorFromPrincipal, actorFromWorkloadPrincipal, type AuditActor } from "@/lib/identity/audit";
import { mysqlCutoverStore } from "@/lib/control-plane/cutover/persistence/mysql-cutover-store";
import { scanRevisionQualification } from "@/lib/control-plane/cutover/domain/cutover-qualification-scanner";
import type { QualificationCategory } from "@/lib/control-plane/cutover/domain/cutover-item";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { getRouteSetById } from "@/lib/routes/application/deployment-route-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析请求体
  const body = await request.json().catch(() => null) as { route_set_id?: string } | null;
  if (!body?.route_set_id) {
    return v11Error("REQUEST_SCHEMA_INVALID", "缺少 route_set_id", { requestId });
  }

  // 3. 校验 RouteSet 存在
  const routeSet = await getRouteSetById(principal.tenantId, body.route_set_id);
  if (!routeSet) {
    return v11Error("RESOURCE_NOT_FOUND", `RouteSet 不存在: ${body.route_set_id}`, { requestId });
  }

  // 4. 创建 Plan（仅扫描，不执行修改）
  const now = new Date();
  const planId = randomUUID();
  const plan = await mysqlCutoverStore.insertPlan({
    id: planId,
    tenantId: principal.tenantId,
    routeSetId: body.route_set_id,
    sourceRouteSetVersionNo: routeSet.versionNo,
    createdBy: principal.userIdentityId ?? principal.serviceId ?? "admin",
    createdAt: now,
  });

  return v11Ok({
    id: plan.id,
    tenant_id: plan.tenantId,
    route_set_id: plan.routeSetId,
    source_route_set_version_no: plan.sourceRouteSetVersionNo,
    state: plan.state,
    created_by: plan.createdBy,
    created_at: plan.createdAt.toISOString(),
  }, {
    status: 201,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
