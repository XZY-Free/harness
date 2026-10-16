/**
 * AppRuntime 重启端点（正式 v1）。
 *
 * POST /api/threads/{threadId}/runtime/restart
 *   → 停止当前 PreviewRuntime（static server 或 dev-server container），然后重新启动。
 *
 * 鉴权：员工身份（Employee API 不走 action scope），经 Thread.ownerUserId 鉴权；
 * 不存在 / 非 owner / 已删除一律 404（隐藏式）。
 * runtime 类型：正式 Thread 无 runtimeType 列，落全局默认 runtimeConfig.defaultType。
 * 不调用 V9 浏览器 session/open-app 端点。
 */
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { apiError, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { logger } from "@/lib/logger";
import { resolveRuntimes } from "@/lib/runtime/registry";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const requestId = getRequestId(request);

  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const thread = await getThreadById(principal.tenantId, threadId);
  if (
    !thread ||
    thread.ownerUserId !== principal.userIdentityId ||
    thread.lifecycleState === "deleted"
  ) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  const { preview } = resolveRuntimes(threadId);

  try {
    // 先停止当前 runtime
    await preview.stop(threadId);
    // 再重新启动
    await preview.start(threadId);
  } catch (error) {
    logger.error("[/api/threads/{threadId}/runtime/restart] 重启失败", {
      error: String(error),
    });
    return apiError("RUNTIME_RESTART_FAILED", "AppRuntime 重启失败", { requestId });
  }

  const status = preview.status(threadId);
  return apiSuccess({
    status: status
      ? { state: status.state, port: status.port ?? null }
      : { state: "idle", port: null },
  });
}

// GET 不支持（防止误触发重启）
export async function GET(request: Request) {
  return apiError("METHOD_NOT_ALLOWED", "请使用 POST 方法", {
    requestId: getRequestId(request),
  });
}
