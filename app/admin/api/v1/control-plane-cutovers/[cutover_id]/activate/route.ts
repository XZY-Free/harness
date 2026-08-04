/**
 * POST /admin/api/v1/control-plane-cutovers/{cutover_id}/activate — 激活切换。
 *
 * ⚠️ 冻结：在真实 Cutover 工作流完成前，此端点返回 503 FEATURE_NOT_READY。
 * 当前 Cutover activate 未真正调用 ActivateRouteSet，仅修改 Plan 状态，
 * 可能宣称切换成功但真实 RouteSet 完全没有变化。
 * 参见：SnowHarness专题01全局统一与最终收敛方案 §0.3
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

  // 冻结：在真实 Cutover 工作流完成前，不允许激活
  return v11Error(
    "FEATURE_NOT_READY",
    `Cutover 激活功能尚未实现。Plan ${planId} 未真正调用 ActivateRouteSet。` +
    "在真实 Cutover 工作流完成前，此端点冻结。参见专题01 §0.3。",
    { requestId },
  );
}
