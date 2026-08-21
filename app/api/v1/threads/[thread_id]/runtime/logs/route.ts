/**
 * AppRuntime 日志端点（正式 v1）。
 *
 * GET /api/v1/threads/{thread_id}/runtime/logs
 *   → 返回 dev server stdout/stderr 日志尾部（最多 200 行）
 *
 * dev server 启动时将 stdout/stderr 重定向到工作区 .snow/runtime/{threadId}/devserver.log。
 * 此端点直接读取该文件尾部，供 RunLogPanel 实时展示运行时输出。
 *
 * 注意：.snow 是内部目录，前台 workspace 文件 API 会 404 拒绝读取。
 * 此端点是服务端直接读取（owner 鉴权后），绕过 isInternalPath 检查。
 *
 * 鉴权：员工身份（Employee API 不走 action scope），经 Thread.ownerUserId 鉴权；
 * 不存在 / 非 owner / 已删除一律 404（隐藏式）。
 */
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { getRequestId, resourceNotFound } from "@/lib/http";
import { readWorkspaceFile } from "@/lib/workspace";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const MAX_LOG_LINES = 200;

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

  // dev server 日志路径：.snow/runtime/{threadId}/devserver.log
  const relPath = `.snow/runtime/${thread_id}/devserver.log`;
  const content = await readWorkspaceFile(thread_id, relPath);

  if (content === null) {
    return Response.json({ ok: true, lines: [], hasLog: false });
  }

  // 取尾部 MAX_LOG_LINES 行
  const allLines = content.split("\n");
  const lines = allLines.slice(-MAX_LOG_LINES);
  const truncated = allLines.length > MAX_LOG_LINES;

  return Response.json({
    ok: true,
    lines,
    hasLog: true,
    truncated,
    totalLines: allLines.length,
  });
}
