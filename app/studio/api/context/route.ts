import { apiError, apiSuccess, getRequestId } from "@/lib/http";
import { evaluateSnapshot, getSnapshot } from "@/lib/identity-client";
import type { PermissionSnapshot } from "@/lib/identity-client/snapshot";
import { authErrorResponse, resolvePrincipal } from "@/lib/identity/resolver";
import { navVisibilityFromSnapshot } from "@/lib/studio/nav-visibility";

/**
 * GET /studio/api/context — Studio 客户端外壳上下文（消费方模型 v4）。
 *
 * 取代原 server layout 的门禁与导航计算：一次拉取
 * principal + 菜单可见性 + 权限快照（本地匹配用）+ auth-center 地址。
 *
 * - 未认证 → 401 AUTHENTICATION_REQUIRED。
 * - 无 studio.access → 403 ACTION_SCOPE_DENIED（fail-closed）。
 * - 身份中心不可达 → 503 IDENTITY_SERVICE_UNAVAILABLE（fail-closed）。
 *
 * 安全边界：响应只含**当前主体自身**的权限快照；一切写操作仍由各 API 的
 * requireActionScope 实时兜底。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  let principal: Awaited<ReturnType<typeof resolvePrincipal>>;
  try {
    principal = await resolvePrincipal(request.headers);
  } catch (error) {
    const authResponse = authErrorResponse(error, requestId);
    if (authResponse) return authResponse;
    return apiError("IDENTITY_SERVICE_UNAVAILABLE", "身份服务暂不可用，请稍后重试", { requestId });
  }

  let snapshot: PermissionSnapshot;
  try {
    snapshot = await getSnapshot(principal.tenantId, principal.userIdentityId);
  } catch {
    return apiError("IDENTITY_SERVICE_UNAVAILABLE", "身份服务暂不可用，请稍后重试", { requestId });
  }

  const studioAccess = evaluateSnapshot(snapshot, {
    actionCode: "studio.access",
    resource: { type: "tenant", id: principal.tenantId },
  }).allowed;
  if (!studioAccess) {
    return apiError("ACTION_SCOPE_DENIED", "当前账号没有后台访问权限", { requestId });
  }

  return apiSuccess({
    principal: {
      id: principal.userIdentityId,
      tenantId: principal.tenantId,
      displayName: principal.displayName,
      email: principal.email,
    },
    nav: navVisibilityFromSnapshot(snapshot),
    snapshot,
    authCenterBaseUrl: (process.env.NEX_AUTH_CENTER_URL ?? "").replace(/\/+$/, ""),
  });
}
