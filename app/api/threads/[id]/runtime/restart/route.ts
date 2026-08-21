/**
 * V10 Phase 1：AppRuntime 重启端点。
 *
 * POST /api/threads/[id]/runtime/restart
 *   → 停止当前 PreviewRuntime（static server 或 dev-server container），然后重新启动。
 *
 * 鉴权：复用 requireThreadForUser（owner guard），非 owner → 404。
 * 不要求 previewUrl 存在——用户可能手动启动了 runtime 但未走 reportReady。
 * 不调用 V9 浏览器 session/open-app 端点。
 */
import { requireThreadForUser } from "@/lib/db/queries";
import { jsonError } from "@/lib/http";
import { logger } from "@/lib/logger";
import { resolveStudioPrincipal } from "@/lib/identity/studio-access";
import { authErrorResponse, type Principal } from "@/lib/identity/resolver";
import { resolveRuntimeTypeForThread, resolveRuntimes } from "@/lib/runtime/registry";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: threadId } = await params;

  let currentPrincipal: Principal;
  try {
    currentPrincipal = await resolveStudioPrincipal(request.headers);
  } catch (error) {
    const authErr = authErrorResponse(error);
    if (authErr) return authErr;
    throw error;
  }

  const thread = await requireThreadForUser(threadId, currentPrincipal.userIdentityId);
  if (!thread) {
    return jsonError(404, "thread_not_found", "会话不存在或无权访问");
  }

  const runtimeType = resolveRuntimeTypeForThread(thread, null);
  const { preview } = resolveRuntimes(threadId, runtimeType);

  try {
    // 先停止当前 runtime
    await preview.stop(threadId);
    // 再重新启动
    await preview.start(threadId);
  } catch (error) {
    logger.error("[/api/threads/[id]/runtime/restart] 重启失败", { error: String(error) });
    return jsonError(500, "runtime_restart_failed", "AppRuntime 重启失败");
  }

  const status = preview.status(threadId);
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
