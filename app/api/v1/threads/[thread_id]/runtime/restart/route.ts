/**
 * AppRuntime 重启端点（正式 v1）。
 *
 * POST /api/v1/threads/{thread_id}/runtime/restart
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
import { getRequestId, jsonError, resourceNotFound } from "@/lib/http";
import { logger } from "@/lib/logger";
import { resolveRuntimes } from "@/lib/runtime/registry";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ thread_id: string }> },
) {
  const { thread_id } = await params;
  const requestId = getRequestId(request);

  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const thread = await getThreadById(principal.tenantId, thread_id);
  if (
    !thread ||
    thread.ownerUserId !== principal.userIdentityId ||
    thread.lifecycleState === "deleted"
  ) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${thread_id}`);
  }

  const { preview } = resolveRuntimes(thread_id);

  try {
    // 先停止当前 runtime
    await preview.stop(thread_id);
    // 再重新启动
    await preview.start(thread_id);
  } catch (error) {
    logger.error("[/api/v1/threads/{thread_id}/runtime/restart] 重启失败", {
      error: String(error),
    });
    return jsonError(500, "runtime_restart_failed", "AppRuntime 重启失败");
  }

  const status = preview.status(thread_id);
  return Response.json({
    ok: true,
    status: status
      ? { state: status.state, port: status.port ?? null }
      : { state: "idle", port: null },
  });
}

// GET 不支持（防止误触发重启）
export async function GET() {
  return jsonError(405, "method_not_allowed", "请使用 POST 方法");
}
