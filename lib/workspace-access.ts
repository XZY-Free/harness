import { type RequestLike, authErrorResponse, getCurrentUserFromRequest } from "@/lib/auth";
import { requireThreadForUser } from "@/lib/db/queries";
import type { User } from "@/lib/db/schema";
import { jsonError } from "@/lib/http";
import { hasPermission } from "@/lib/rbac";

/**
 * V5-B1：前台 workspace 访问门禁 helper。
 *
 * 前台员工路由（`/api/threads/[id]/workspace/*`）的 owner 校验 + workspace.read 权限门，
 * 与 Studio 后台（`/studio/api/threads/[id]/workspace/*`）的语义有差异：
 *
 * | 维度 | 前台（本 helper） | Studio 后台 |
 * |------------|----------------------------------|----------------------------------------------|
 * | 基础门禁 | 不要求 studio.access | requirePermission(studio.access) |
 * | owner 范围 | 仅 requireThreadForUser | admin(thread.read.all) → getThreadById 优先 |
 * | 写审计 | 不记（员工前台读不审计） | workspace.file.written / deleted 全审计 |
 *
 * 安全口径与 Studio 一致：
 * - foreign / 不存在 thread → 404（不区分，防枚举），先于 workspace 权限判定。
 * - safeJoin / symlink / realpath 防护仍在 lib/workspace.ts 的 list/read 函数内，
 * throw WorkspacePathError 由 route 层 catch 转 400。
 */
export type WorkspaceAccessResult = { ok: true; user: User } | { ok: false; response: Response };

/**
 * 校验当前用户对该 thread workspace 的读权限。
 *
 * @returns ok=true 时 user 已就绪；ok=false 时直接 return response 给客户端。
 */
export async function requireThreadWorkspaceRead(
  request: RequestLike,
  threadId: string,
): Promise<WorkspaceAccessResult> {
  let user: User;
  try {
    user = await getCurrentUserFromRequest(request);
  } catch (error) {
    const authResp = authErrorResponse(error);
    return { ok: false, response: authResp ?? jsonError(500, "auth_error", "认证异常") };
  }

  const thread = await requireThreadForUser(threadId, user.id);
  if (!thread) {
    // foreign / 不存在 → 404，不区分，防枚举（先于 workspace 权限判定）。
    return { ok: false, response: jsonError(404, "THREAD_NOT_FOUND", "thread 不存在或无权访问") };
  }

  if (!(await hasPermission(user.id, "workspace.read"))) {
    return { ok: false, response: jsonError(403, "forbidden", "无 workspace.read 权限") };
  }

  return { ok: true, user };
}

/**
 * V9 阶段 4：校验当前用户对该 thread workspace 的写权限。
 *
 * 与读门禁同样的 owner 先行 + 权限校验，仅权限位换为 workspace.write。
 * 写入口（文件编辑器自动保存 / 手动保存）走此门禁。
 *
 * @returns ok=true 时 user 已就绪；ok=false 时直接 return response 给客户端。
 */
export async function requireThreadWorkspaceWrite(
  request: RequestLike,
  threadId: string,
): Promise<WorkspaceAccessResult> {
  let user: User;
  try {
    user = await getCurrentUserFromRequest(request);
  } catch (error) {
    const authResp = authErrorResponse(error);
    return { ok: false, response: authResp ?? jsonError(500, "auth_error", "认证异常") };
  }

  const thread = await requireThreadForUser(threadId, user.id);
  if (!thread) {
    return { ok: false, response: jsonError(404, "THREAD_NOT_FOUND", "thread 不存在或无权访问") };
  }

  if (!(await hasPermission(user.id, "workspace.write"))) {
    return { ok: false, response: jsonError(403, "forbidden", "无 workspace.write 权限") };
  }

  return { ok: true, user };
}
