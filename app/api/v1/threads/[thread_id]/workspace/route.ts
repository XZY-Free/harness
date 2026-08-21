import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { getRequestId, jsonError, jsonOk, resourceNotFound } from "@/lib/http";
import { WorkspacePathError, listWorkspaceFiles } from "@/lib/workspace";
import type { NextRequest } from "next/server";

/**
 * 前台 workspace 文件列表 API（正式 v1）。
 *
 * GET /api/v1/threads/{thread_id}/workspace → 列出本会话 workspace 中的用户可见文件。
 *
 * 与 Studio 后台 `/studio/api/threads/[id]/workspace` 的差异见 lib/workspace-access.ts（已删）。
 * 内部运行时目录（.snow/.git/node_modules/.next/dist/build/.cache/.turbo）默认隐藏。
 *
 * 鉴权：员工身份（Employee API 不走 action scope），经 Thread.ownerUserId 鉴权；
 * Thread 不存在 / 非 owner / 已删除一律 404（隐藏式，不泄露存在）。
 *
 * 响应：{ ok: true, data: { threadId, files: string[] } }
 *   - 404 thread 不存在 / 非 owner
 *   - 400 invalid_path（workspace 根为符号链接等 safeJoin/symlink 错误）
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ thread_id: string }> },
) {
  const { thread_id } = await params;
  const requestId = getRequestId(req);

  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(req.headers);
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

  try {
    const files = await listWorkspaceFiles(thread_id, { skipInternal: true });
    return jsonOk({ threadId: thread_id, files });
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      return jsonError(400, "invalid_path", error.message);
    }
    return jsonError(500, "internal_error", "服务器内部错误");
  }
}
