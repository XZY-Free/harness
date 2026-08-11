import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  getRouteSetById,
  listRoutesBySet,
} from "@/lib/routes/application/deployment-route-service";
import { projectAdminRoute } from "@/lib/routes/application/route-admin-projection";
import { readAdminRoute } from "@/lib/routes/persistence/route-admin-reader";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ route_set_id: string }> },
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
  const { route_set_id: routeSetId } = await params;
  const routeSet = await getRouteSetById(principal.tenantId, routeSetId);
  if (!routeSet) return resourceNotFound(requestId, `RouteSet 不存在或无权访问: ${routeSetId}`);
  const routes = await listRoutesBySet(routeSetId);
  const items = await Promise.all(
    routes.map(async (route) => projectAdminRoute(await readAdminRoute(principal.tenantId, route))),
  );
  return apiSuccess(
    { items, total: items.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
