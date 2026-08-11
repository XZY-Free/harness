import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { projectWithdrawalRecord } from "@/lib/publications/application/publication-admin-projection";
import { getWithdrawalRecordById } from "@/lib/publications/persistence/publication-record-queries";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ record_id: string }> },
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
  const { record_id: recordId } = await params;
  const record = await getWithdrawalRecordById({
    tenantId: principal.tenantId,
    withdrawalRecordId: recordId,
  });
  if (!record) return resourceNotFound(requestId, `WithdrawalRecord 不存在: ${recordId}`);
  return apiSuccess(projectWithdrawalRecord(record), {
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
