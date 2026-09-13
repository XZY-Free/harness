import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import { projectRuntime } from "@/lib/runtime/application/runtime-admin-projection";
import { listRuntimes } from "@/lib/runtime/persistence/runtime-queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (error) {
    const response = adminAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }
  const runtimes = await listRuntimes(principal.tenantId);
  const items = runtimes.map(projectRuntime);
  return apiSuccess(
    { items, total: items.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
