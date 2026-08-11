import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { getRouteById } from "@/lib/routes/application/deployment-route-service";
import { projectAdminRoute } from "@/lib/routes/application/route-admin-projection";
import { readAdminRoute } from "@/lib/routes/persistence/route-admin-reader";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ route_id: string }> },
): Promise<Response> {
  const requestId = getRequestId(request);
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (error) {
    const response = adminAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }
  const { route_id: routeId } = await params;
  const route = await getRouteById(principal.tenantId, routeId);
  if (!route) return resourceNotFound(requestId, `DeploymentRoute 不存在或无权访问: ${routeId}`);
  return apiSuccess(projectAdminRoute(await readAdminRoute(principal.tenantId, route)), {
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
