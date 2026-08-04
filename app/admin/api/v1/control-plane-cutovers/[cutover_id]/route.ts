/**
 * GET /admin/api/v1/control-plane-cutovers/{cutover_id} — 读取 Cutover 计划。
 */

import {
  REQUEST_ID_HEADER,
  getRequestId,
  v11Ok,
} from "@/lib/http";
import { mysqlCutoverStore } from "@/lib/control-plane/cutover/persistence/mysql-cutover-store";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ cutover_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
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
    return v11Ok(null, { status: 404, headers: { [REQUEST_ID_HEADER]: requestId } });
  }

  const items = await mysqlCutoverStore.listItemsByPlan(planId);

  return v11Ok({
    id: plan.id,
    tenant_id: plan.tenantId,
    route_set_id: plan.routeSetId,
    source_route_set_version_no: plan.sourceRouteSetVersionNo,
    target_route_set_version_no: plan.targetRouteSetVersionNo,
    state: plan.state,
    created_by: plan.createdBy,
    created_at: plan.createdAt.toISOString(),
    started_at: plan.startedAt?.toISOString() ?? null,
    completed_at: plan.completedAt?.toISOString() ?? null,
    failed_at: plan.failedAt?.toISOString() ?? null,
    failure_reason: plan.failureReason,
    items: items.map((item) => ({
      id: item.id,
      subject_type: item.subjectType,
      source_subject_id: item.sourceSubjectId,
      replacement_subject_id: item.replacementSubjectId,
      state: item.state,
      qualification_category: item.qualificationCategory,
      attempt_count: item.attemptCount,
      last_error: item.lastError,
    })),
  }, {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
