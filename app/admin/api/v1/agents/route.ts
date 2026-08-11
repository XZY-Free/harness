import { projectAgentAdmin } from "@/lib/agents/application/agent-admin-projection";
import { listAgents } from "@/lib/agents/persistence/agent-queries";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
/**
 * GET /admin/api/v1/agents — 列出当前租户下所有 Agent（S11-W02）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md
 *   S11-W02：「管理 Agent 元数据、访问范围、Revision、RuntimeRevision、DeploymentRoute、灰度、回滚和下线」
 *
 * 行为：
 * - 解析 admin 主体（SSO 管理员）。
 * - 复用 studio.access 入口语义：admin audience 主体可读，无需专门 action scope（读操作）。
 * - 调用 listAgents 返回当前租户所有非删除 Agent（按 updatedAt 降序）。
 * - 返回 200 + Agent 投影数组（不含 currentRevision 详情，需另行查询 revisions 端点）。
 *
 * 安全边界：
 * - 跨租户隔离由 listAgents 的 tenantId 过滤保证。
 * - 仅返回未删除 Agent（includeDeleted=false 默认）。
 * - 敏感字段（如 ownerUserId）保留为 UUID，不脱敏（管理员可见）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 */
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (error) {
    const resp = adminAuthErrorResponse(error, requestId);
    return resp ?? apiSuccess([]);
  }

  const agents = await listAgents(principal.tenantId);

  // 统一控制面 DTO 投影。
  const projected = agents.map(projectAgentAdmin);

  return apiSuccess(
    { items: projected, total: projected.length },
    {
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}
