import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import { projectWithdrawalRecord } from "@/lib/publications/application/publication-admin-projection";
import type { PublicationSubjectType } from "@/lib/publications/domain/publication-record";
import { listWithdrawalRecords } from "@/lib/publications/persistence/publication-record-queries";

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
  const url = new URL(request.url);
  const subjectTypeValue = url.searchParams.get("subject_type");
  if (
    subjectTypeValue !== null &&
    subjectTypeValue !== "agent_revision" &&
    subjectTypeValue !== "runtime_revision"
  ) {
    return schemaInvalidTable(requestId, `subject_type 非法: ${subjectTypeValue}`);
  }
  const items = await listWithdrawalRecords({
    tenantId: principal.tenantId,
    subjectType: (subjectTypeValue ?? undefined) as PublicationSubjectType | undefined,
    subjectRevisionId: url.searchParams.get("subject_revision_id") ?? undefined,
  });
  return apiSuccess(
    { items: items.map(projectWithdrawalRecord), total: items.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
