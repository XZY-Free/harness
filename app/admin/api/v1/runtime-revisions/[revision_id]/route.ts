import {
  type AdminPrincipal,
  RUNTIME_REVISION_ETAG_PREFIX,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import {
  REQUEST_ID_HEADER,
  apiSuccess,
  etagHeader,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
import { loadRuntimeRevisionAdminProjection } from "@/lib/runtime/application/runtime-admin-projection";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ revision_id: string }> },
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
  const { revision_id: revisionId } = await params;
  const projection = await loadRuntimeRevisionAdminProjection(principal.tenantId, revisionId);
  if (!projection) {
    return resourceNotFound(requestId, `RuntimeRevision 不存在或无权访问: ${revisionId}`);
  }
  return apiSuccess(projection, {
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`${RUNTIME_REVISION_ETAG_PREFIX}${projection.revision_no}`),
    },
  });
}
