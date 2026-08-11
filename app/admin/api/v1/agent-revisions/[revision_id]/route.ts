import {
  AGENT_REVISION_ETAG_PREFIX,
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { loadAgentRevisionAdminProjection } from "@/lib/agents/application/agent-admin-projection";
import {
  REQUEST_ID_HEADER,
  apiSuccess,
  etagHeader,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";

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
  const projection = await loadAgentRevisionAdminProjection(principal.tenantId, revisionId);
  if (!projection) {
    return resourceNotFound(requestId, `AgentRevision 不存在或无权访问: ${revisionId}`);
  }
  return apiSuccess(projection, {
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`${AGENT_REVISION_ETAG_PREFIX}${projection.revision_no}`),
    },
  });
}
