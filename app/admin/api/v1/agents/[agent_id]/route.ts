import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { projectAgentAdmin } from "@/lib/agents/application/agent-admin-projection";
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
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
  { params }: { params: Promise<{ agent_id: string }> },
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

  const { agent_id: agentId } = await params;
  const agent = await getAgentById(principal.tenantId, agentId);
  if (!agent) return resourceNotFound(requestId, `Agent 不存在或无权访问: ${agentId}`);
  return apiSuccess(projectAgentAdmin(agent), {
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`agent-${agent.versionNo}`),
    },
  });
}
