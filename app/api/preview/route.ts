import { apiPath } from "@/lib/api-fetch";
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { getRequestId, jsonError, jsonOk, resourceNotFound } from "@/lib/http";
import { resolveRuntimeTypeForThread, resolveRuntimes } from "@/lib/runtime/registry";

/**
 * 预览 API：为会话工作区起 / 停静态预览服务，返回可嵌入 iframe 的 URL。
 *
 * Phase 4-3：启动 / 停止 preview 前校验 thread owner，foreign thread → 404，
 * 不启动副作用。正式 Employee API 不走 action scope，经 Thread.ownerUserId 鉴权。
 */
export async function POST(request: Request) {
  let body: { threadId?: string; action?: "start" | "stop" };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError(400, "bad_request", "无效请求体");
  }

  const { threadId, action = "start" } = body;
  if (!threadId) {
    return jsonError(400, "missing_thread_id", "缺少 threadId");
  }

  const requestId = getRequestId(request);
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    return jsonError(500, "internal_error", "服务器内部错误");
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
    // V8 阶段 8：preview 不依赖 Skill 的 runtimeType；正式 Thread 无 runtimeType 列，落全局默认。
    const runtimeType = resolveRuntimeTypeForThread(null, null);
    const preview = resolveRuntimes(threadId, runtimeType).preview;
    if (action === "stop") {
      await preview.stop(threadId);
      return jsonOk({ status: "idle" });
    }
    const handle = await preview.start(threadId);
    const url = apiPath(
      handle.kind === "static" ? `/preview/${threadId}/index.html` : `/preview/${threadId}/`,
    );
    return jsonOk({ status: "ready", url });
  } catch (error) {
    // P2-3:不回显 err.message,防泄露内部信息。
    return jsonError(500, "preview_failed", "预览启动失败");
  }
}
