/**
 * GET /admin/api/v1/agents/{agent_id}/contracts — 列出 Agent 的 Public Agent Contract 快照。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Agent 存在且属于当前租户（跨租户/缺失 → 隐藏式 404）。
 * - 返回最新优先的快照 wire 投影（与 POST /agent-registrations 201 投影共用同一函数，
 *   保证两端逐字段一致）；子记录按合同声明顺序（position 升序）。
 * - 只含结构化事实：无原始合同对象/整节 JSON、URL、secret 或内部行 id。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Agent 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import {
  loadAgentContractSnapshotsByAgent,
  projectAgentContractWire,
} from "@/lib/agents/application/submit-agent-contract-registration";
import { mysqlAgentContractStore } from "@/lib/agents/persistence/agent-contract-store";
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";

export const dynamic = "force-dynamic";

/** 路径参数上下文（Next.js App Router 动态段）。 */
interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { agent_id: agentId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    return authResp ?? resourceNotFound(requestId);
  }

  // 租户归属校验（跨租户隐藏为 404）
  const agent = await getAgentById(principal.tenantId, agentId);
  if (!agent) {
    return resourceNotFound(requestId, `Agent 不存在或无权访问: ${agentId}`);
  }

  const aggregates = await loadAgentContractSnapshotsByAgent(
    mysqlAgentContractStore,
    principal.tenantId,
    agentId,
  );
  const items = aggregates.map(projectAgentContractWire);

  return apiSuccess(
    { items, total: items.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
