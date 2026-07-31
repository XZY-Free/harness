/**
 * V9 阶段 5：AppRuntime 日志端点。
 *
 * GET /api/threads/[id]/runtime/logs
 *   → 返回 dev server stdout/stderr 日志尾部（最多 200 行）
 *
 * dev server 启动时将 stdout/stderr 重定向到工作区 .snow/runtime/{threadId}/devserver.log。
 * 此端点直接读取该文件尾部，供 RunLogPanel 实时展示运行时输出。
 *
 * 注意：.snow 是内部目录，前台 workspace 文件 API 会 404 拒绝读取。
 * 此端点是服务端直接读取（requireThreadWorkspaceRead 鉴权后），绕过 isInternalPath 检查。
 */
import { readWorkspaceFile } from "@/lib/workspace";
import { requireThreadWorkspaceRead } from "@/lib/workspace-access";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const MAX_LOG_LINES = 200;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: threadId } = await params;
  const r = await requireThreadWorkspaceRead(req, threadId);
  if (!r.ok) return r.response;

  // dev server 日志路径：.snow/runtime/{threadId}/devserver.log
  const relPath = `.snow/runtime/${threadId}/devserver.log`;
  const content = await readWorkspaceFile(threadId, relPath);

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
