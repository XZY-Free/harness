/**
 * POST /admin/api/v1/control-plane-cutovers/{cutover_id}/start — 开始后台资格重建。
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

  // 只有 draft 或 inventory_complete 状态可以开始
  if (!isValidPlanTransition(plan.state, "requalifying")) {
    return v11Error("BUSINESS_CONSTRAINT_VIOLATION", `Plan 当前状态 ${plan.state} 不允许开始`, { requestId });
  }

  // 转换到 requalifying 状态
  const now = new Date();
  const updated = await mysqlCutoverStore.updatePlanState({
    planId,
    state: "requalifying",
    startedAt: now,
  });

  return v11Ok({
    id: updated.id,
    state: updated.state,
    started_at: updated.startedAt?.toISOString(),
  }, {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
