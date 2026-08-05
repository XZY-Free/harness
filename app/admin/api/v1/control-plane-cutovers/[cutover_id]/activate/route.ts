/**
 * POST /admin/api/v1/control-plane-cutovers/{cutover_id}/activate — 激活切换。
 *
 * §7.3: 调用 activateCutoverPlan 执行真实 9 步激活流程。
 * 前置条件：Cutover Worker 已完成所有 Item Readiness 检查，Plan 处于 ready_to_activate 状态。
 */

import {
  REQUEST_ID_HEADER,
  getRequestId,
  v11Error,
} from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { activateCutoverPlan } from "@/lib/control-plane/cutover/application/execute-cutover";
import { mysqlCutoverStore } from "@/lib/control-plane/cutover/persistence/mysql-cutover-store";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ cutover_id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { cutover_id: planId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // §7.3: 真实 Cutover 激活
  try {
    const plan = await mysqlCutoverStore.getPlanById({ tenantId: principal.tenantId, planId });
    if (!plan) {
      return v11Error("RESOURCE_NOT_FOUND", `Cutover plan ${planId} not found`, { requestId });
    }
    const result = await activateCutoverPlan(
      { store: mysqlCutoverStore } as Parameters<typeof activateCutoverPlan>[0],
      {
        planId,
        tenantId: principal.tenantId,
        routeSetId: plan.routeSetId,
        sourceRouteSetVersionNo: plan.sourceRouteSetVersionNo,
        desiredRoutes: [],
      },
    );

    return Response.json(
      {
        planId,
        activated: true,
        targetRouteSetVersionNo: result.targetRouteSetVersionNo,
      },
      { status: 200, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return v11Error("CUTOVER_ACTIVATION_FAILED", message, { requestId });
  }
}
