import { apiPath } from "@/lib/api-fetch";
import { authErrorResponse, getCurrentUserFromRequest } from "@/lib/auth";
import { requireThreadForUser } from "@/lib/db/queries";
import type { User } from "@/lib/db/schema";
import { jsonError, jsonOk } from "@/lib/http";
import { resolveRuntimeTypeForThread, resolveRuntimes } from "@/lib/runtime/registry";

/**
 * 预览 API：为会话工作区起 / 停静态预览服务，返回可嵌入 iframe 的 URL。
 *
 * Phase 4-3：启动 / 停止 preview 前校验 thread owner，foreign thread → 404，
 * 不启动副作用。
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

  let currentUser: User;
  try {
    currentUser = await getCurrentUserFromRequest(request);
  } catch (error) {
    const authErr = authErrorResponse(error);
    if (authErr) return authErr;
    return jsonError(500, "internal_error", "服务器内部错误");
  }

  const thread = await requireThreadForUser(threadId, currentUser.id);
  if (!thread) {
    return jsonError(404, "thread_not_found", "会话不存在");
  }

  try {
    // V8 阶段 8：preview 不再依赖 Skill 的 runtimeType，回退到 thread.runtimeType ?? "host"
    const runtimeType = resolveRuntimeTypeForThread(thread, null);
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
