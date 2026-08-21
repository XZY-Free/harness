import { getThreadById, requireThreadForUser } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { logger } from "@/lib/logger";
import { hasStudioAction, requireStudioAction } from "@/lib/identity/studio-access";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import { WorkspacePathError, listWorkspaceFiles, writeWorkspaceFile } from "@/lib/workspace";
import type { NextRequest } from "next/server";

/**
 * Workspaces API（Phase 4-4 切片 B2 + 切片 C 审计）。
 *
 * 挂在 thread 下，**先 owner 范围，再 workspace 权限**（§2.3）：
 * 1. requirePermission(studio.access) 解析用户 + 基础门禁（401/403，不审计）。
 * 2. owner 范围：admin(thread.read.all) → getThreadById；member → requireThreadForUser。
 *    foreign / 不存在 → 404（不区分，防枚举）—— 先于 workspace 权限判定，不审计。
 * 3. workspace 权限：workspace.read（GET 列）/ workspace.write（POST 写）；无 → 403，不审计。
 * 4. safeJoin / symlink-realpath 防护 throw → 400 + failed 审计 reasonCode=invalid_path。
 *
 * 审计（切片 C）：POST 写成功 → workspace.file.written succeeded { path, bytes }（不记 content）；
 * invalid_body 不审计；审计写失败 → 500 audit_failed（Known gap：文件已写入无法回滚，§4.3/§12）。
 *
 * GET  /studio/api/threads/[id]/workspace → 列文件 { threadId, files }
 * POST /studio/api/threads/[id]/workspace → 写/覆盖文件 body{path,content} → { path }
 */

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasStudioAction(r.principal, "thread.read");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.principal.userIdentityId);
  if (!thread) return jsonError(404, "THREAD_NOT_FOUND", "thread 不存在或无权访问");

  if (!(await hasStudioAction(r.principal, "workspace.read"))) {
    return jsonError(403, "forbidden", "无 workspace.read 权限");
  }
  try {
    const files = await listWorkspaceFiles(id, { skipInternal: true });
    return jsonOk({ threadId: id, files });
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      return jsonError(400, "invalid_path", error.message);
    }
    throw error;
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const actorUserId = r.principal.userIdentityId;
  const { id } = await params;

  const canAll = await hasStudioAction(r.principal, "thread.write");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.principal.userIdentityId);
  if (!thread) return jsonError(404, "THREAD_NOT_FOUND", "thread 不存在或无权访问");

  if (!(await hasStudioAction(r.principal, "workspace.write"))) {
    return jsonError(403, "forbidden", "无 workspace.write 权限");
  }

  let body: { path?: unknown; content?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_body", "请求体不是合法 JSON");
  }
  const { path, content } = body;
  if (typeof path !== "string" || path.length === 0 || typeof content !== "string") {
    return jsonError(400, "invalid_body", "path 与 content 必须为非空字符串");
  }

  try {
    const rel = await writeWorkspaceFile(id, path, content);
    const bytes = Buffer.byteLength(content, "utf8");
    try {
      await recordAdminAudit({
        actorUserId,
        action: "workspace.file.written",
        targetType: "workspace",
        targetId: id,
        outcome: "succeeded",
        // 只记 path + bytes，绝不记 content
        metadata: { path: rel, bytes },
      });
    } catch (error) {
      logger.error("admin audit write failed (workspace write success path)", {
        threadId: id,
        path: rel,
        error: String(error),
      });
      return jsonError(500, "audit_failed", "审计写入失败");
    }
    return jsonOk({ path: rel });
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      try {
        await recordAdminAudit({
          actorUserId,
          action: "workspace.file.written",
          targetType: "workspace",
          targetId: id,
          outcome: "failed",
          metadata: { reasonCode: "invalid_path", path },
        });
      } catch (auditError) {
        logger.error("admin audit write failed (workspace write invalid path)", {
          threadId: id,
          error: String(auditError),
        });
      }
      return jsonError(400, "invalid_path", error.message);
    }
    throw error;
  }
}
