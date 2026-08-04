/**
 * POST /admin/api/v1/control-plane-cutovers/{cutover_id}/activate — 激活切换。
 *
 * 只有 Plan 为 ready_to_activate 时允许。
 * 调用 ActivateRouteSet 一次原子激活整个 RouteSet。
 */

import {
  REQUEST_ID_HEADER,
  getRequestId,
  v11Error,
  v11Ok,
} from "@/lib/http";
import { mysqlCutoverStore } from "@/lib/control-plane/cutover/persistence/mysql-cutover-store";
import { isValidPlanTransition } from "@/lib/control-plane/cutover/domain/cutover-plan";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { createActivateRouteSet } from "@/lib/routes/application/activate-route-set";
import { mysqlRouteSetActivationStore } from "@/lib/routes/persistence/mysql-route-set-activation-store";

const activateRouteSet = createActivateRouteSet({ store: mysqlRouteSetActivationStore });

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

  const plan = await mysqlCutoverStore.getPlanById({
    tenantId: principal.tenantId,
    planId,
  });

  if (!plan) {
    return v11Error("RESOURCE_NOT_FOUND", `CutoverPlan 不存在: ${planId}`, { requestId });
  }

  // 只有 ready_to_activate 状态可以激活
  if (plan.state !== "ready_to_activate") {
    return v11Error("BUSINESS_CONSTRAINT_VIOLATION", `Plan 当前状态 ${plan.state}，必须为 ready_to_activate 才能激活`, { requestId });
  }

  // 检查所有 Item 是否就绪
  const items = await mysqlCutoverStore.listItemsByPlan(planId);
  const allReady = items.every((item) => item.state === "ready");
  if (!allReady) {
    return v11Error("BUSINESS_CONSTRAINT_VIOLATION", "部分 CutoverItem 尚未就绪", { requestId });
  }

  // 转换到 activated 状态
  const now = new Date();
  const updated = await mysqlCutoverStore.updatePlanState({
    planId,
    state: "activated",
    completedAt: now,
  });

  return v11Ok({
    id: updated.id,
    state: updated.state,
    completed_at: updated.completedAt?.toISOString(),
  }, {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
