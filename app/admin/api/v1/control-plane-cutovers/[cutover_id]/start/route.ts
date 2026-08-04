/**
 * POST /admin/api/v1/control-plane-cutovers/{cutover_id}/start — 开始后台资格重建。
 *
 * ⚠️ 冻结：在真实 Cutover Worker 完成前，此端点返回 503 FEATURE_NOT_READY。
 * 当前 Cutover start 只修改 Plan 状态为 requalifying，未启动或排队任何后台执行。
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

  // 冻结：在真实 Cutover Worker 完成前，不允许启动
  return v11Error(
    "FEATURE_NOT_READY",
    `Cutover 启动功能尚未实现。Plan ${planId} 未真正启动后台资格重建。` +
    "在真实 Cutover Worker 完成前，此端点冻结。参见专题01 §0.3。",
    { requestId },
  );
}
