import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { projectHostedProvisioningRequest } from "@/lib/runtime/application/hosted-provisioning-admin-projection";
import { mysqlHostedProvisioningRequestStore } from "@/lib/runtime/persistence/mysql-hosted-provisioning-request-store";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ request_id: string }> },
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
  const { request_id: provisioningRequestId } = await params;
  const row = await mysqlHostedProvisioningRequestStore.getById({
    tenantId: principal.tenantId,
    requestId: provisioningRequestId,
  });
  if (!row) {
    return resourceNotFound(
      requestId,
      `HostedProvisioningRequest 不存在或无权访问: ${provisioningRequestId}`,
    );
  }
  return apiSuccess(projectHostedProvisioningRequest(row), {
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
