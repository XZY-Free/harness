import { jsonError, jsonOk } from "@/lib/http";
import { WorkspacePathError, listWorkspaceFiles } from "@/lib/workspace";
import { requireThreadWorkspaceRead } from "@/lib/workspace-access";
import type { NextRequest } from "next/server";

/**
 * V5-B1：前台 workspace 文件列表 API。
 *
 * GET /api/threads/[id]/workspace → 列出本会话 workspace 中的用户可见文件。
 *
 * 与 Studio 后台 `/studio/api/threads/[id]/workspace` 的差异见 lib/workspace-access.ts。
 * 内部运行时目录（.snow/.git/node_modules/.next/dist/build/.cache/.turbo）默认隐藏。
 *
 * 响应：{ ok: true, data: { threadId, files: string[] } }
 *   - 404 thread 不存在 / 非 owner（不区分，防枚举）
 *   - 403 无 workspace.read 权限
 *   - 400 invalid_path（workspace 根为符号链接等 safeJoin/symlink 错误）
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireThreadWorkspaceRead(req, id);
  if (!r.ok) return r.response;

  try {
    const files = await listWorkspaceFiles(id, { skipInternal: true });
    return jsonOk({ threadId: id, files });
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      return jsonError(400, "invalid_path", error.message);
    }
    return jsonError(500, "internal_error", "服务器内部错误");
  }
}
