import { apiPath } from "@/lib/api-fetch";
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { apiError, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { resolveRuntimes } from "@/lib/runtime/registry";

/**
 * 预览 API：为会话工作区起 / 停静态预览服务，返回可嵌入 iframe 的 URL。
 *
 * 启动 / 停止 preview 前校验 thread owner，foreign thread → 404，
 * 不启动副作用。正式 Employee API 不走 action scope，经 Thread.ownerUserId 鉴权。
 */
export async function POST(request: Request) {
  const requestId = getRequestId(request);
  let body: { threadId?: string; action?: "start" | "stop" };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("INVALID_REQUEST", "无效请求体", { requestId });
  }

  const { threadId, action = "start" } = body;
  if (!threadId) {
    return apiError("MISSING_REQUIRED_FIELD", "缺少 threadId", { requestId });
  }

  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    return apiError("INTERNAL_ERROR", "服务器内部错误", { requestId });
  }

  const thread = await getThreadById(principal.tenantId, threadId);
  if (
    !thread ||
    thread.ownerUserId !== principal.userIdentityId ||
    thread.lifecycleState === "deleted"
  ) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  try {
    const preview = resolveRuntimes(threadId).preview;
    if (action === "stop") {
      await preview.stop(threadId);
      return apiSuccess({ status: "idle" });
    }
    const handle = await preview.start(threadId);
    const url = apiPath(
      handle.kind === "static" ? `/preview/${threadId}/index.html` : `/preview/${threadId}/`,
    );
    return apiSuccess({ status: "ready", url });
  } catch (error) {
    // P2-3:不回显 err.message,防泄露内部信息。
    return apiError("PREVIEW_FAILED", "预览启动失败", { requestId });
  }
}
