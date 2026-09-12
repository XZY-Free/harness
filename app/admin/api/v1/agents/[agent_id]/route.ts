import {
  etagMismatchTable,
  requireAdminActionScope,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { projectAgentAdmin } from "@/lib/agents/application/agent-admin-projection";
import {
  AgentDeletionError,
  deleteAgentRegistration,
} from "@/lib/agents/application/delete-agent-registration";
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import { apiError, parseIfMatch } from "@/lib/http";
import {
  REQUEST_ID_HEADER,
  apiSuccess,
  etagHeader,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
import { actorFromPrincipal, actorFromWorkloadPrincipal } from "@/lib/identity/audit";

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
  if (!agent || agent.deletedAt)
    return resourceNotFound(requestId, `Agent 不存在或无权访问: ${agentId}`);
  return apiSuccess(projectAgentAdmin(agent), {
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`agent-${agent.versionNo}`),
    },
  });
}

/** 删除登记须同时具有登记与撤回权限；不能用页面可见性替代资源授权。 */
export async function DELETE(
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
  const { agent_id: id } = await params;
  const agent = await getAgentById(principal.tenantId, id);
  if (!agent) return resourceNotFound(requestId);
  for (const action of ["agent.contract.register", "agent.retract"] as const) {
    const scope = await requireAdminActionScope(
      principal,
      action,
      { type: "agent", id },
      requestId,
    );
    if (!scope.ok) return scope.response;
  }
  const match = parseIfMatch(request)?.match(/^agent-([1-9]\d*)$/);
  if (!match || !Number.isSafeInteger(Number(match[1])))
    return schemaInvalidTable(requestId, "请刷新智能体列表后重新操作。");
  try {
    await deleteAgentRegistration({
      tenantId: principal.tenantId,
      agentId: id,
      expectedVersion: Number(match[1]),
      actor:
        "userIdentityId" in principal
          ? actorFromPrincipal(principal)
          : actorFromWorkloadPrincipal(principal),
      requestId,
    });
    return apiSuccess({ id, deleted: true }, { headers: { [REQUEST_ID_HEADER]: requestId } });
  } catch (error) {
    if (!(error instanceof AgentDeletionError)) throw error;
    if (error.kind === "missing") return resourceNotFound(requestId);
    if (error.kind === "conflict")
      return etagMismatchTable(requestId, "智能体已发生变化，请刷新列表后重试。");
    return apiError(
      "BUSINESS_CONSTRAINT_VIOLATION",
      error.kind === "referenced"
        ? "此智能体已有服务连接，不能直接删除登记。请由发布管理员处理现有连接。"
        : "已退役智能体需要保留历史记录，不能删除。",
      { requestId },
    );
  }
}
