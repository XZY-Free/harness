/**
 * GET /api/v1/agents — 员工可见的只读 Agent 目录投影（§12.4）。
 *
 * 事实源：docs/architecture/domain-model.md §3.1（Agent 可治理资产）、
 *         SnowHarness 专题01 §12.4（Thread collection 与 Agent 可用目录职责分离）。
 *
 * 行为：
 * - 解析员工身份（employee audience）。
 * - 返回当前用户可使用的 enabled Agent 目录投影（只读，非 Admin Agent API）。
 * - Agent 表为空时返回 agents=[]（合法；Agent 目录为空是正式合法状态，不阻断 Thread/Turn）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 */
import { listAgents } from "@/lib/agents/persistence/agent-queries";
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const agents = await listAgents(principal.tenantId, { lifecycleState: "enabled" });
  return apiSuccess(
    {
      agents: agents.map((agent) => ({
        id: agent.id,
        agent_key: agent.agentKey,
        display_name: agent.displayName,
      })),
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
