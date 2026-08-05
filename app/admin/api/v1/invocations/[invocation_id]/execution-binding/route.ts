import { serializeExecutionBinding } from "@/lib/executions/application/serialize-execution-binding";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { REQUEST_ID_HEADER, getRequestId, resourceNotFound, apiSuccess } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { getInvocationById } from "@/lib/v11/runtime/invocation-queries";
/**
 * GET /admin/api/v1/invocations/{invocation_id}/execution-binding — Invocation 的 ExecutionBinding（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Invocation 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 getExecutionBindingByInvocation（1:1 不可变，invocationId 为主键）。
 * - 不存在 binding → 404（Invocation 尚未绑定 runtime 配置）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Invocation 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - Invocation 存在但 binding 不存在 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ invocation_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { invocation_id: invocationId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 校验父 Invocation 存在且属于当前租户
  const invocation = await getInvocationById(principal.tenantId, invocationId);
  if (!invocation) {
    return resourceNotFound(requestId, `Invocation 不存在或无权访问: ${invocationId}`);
  }

  const binding = await getExecutionBindingByInvocation(principal.tenantId, invocationId);
  if (!binding) {
    return resourceNotFound(requestId, `ExecutionBinding 不存在或无权访问: invocation=${invocationId}`);
  }

  const body = serializeExecutionBinding(binding);

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
