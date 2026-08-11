import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { projectRuntime } from "@/lib/runtime/application/runtime-admin-projection";
import { getRuntimeById } from "@/lib/runtime/persistence/runtime-queries";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runtime_id: string }> },
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
  const { runtime_id: runtimeId } = await params;
  const runtime = await getRuntimeById(principal.tenantId, runtimeId);
  if (!runtime) return resourceNotFound(requestId, `Runtime 不存在或无权访问: ${runtimeId}`);
  return apiSuccess(projectRuntime(runtime), { headers: { [REQUEST_ID_HEADER]: requestId } });
}
