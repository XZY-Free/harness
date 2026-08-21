import { getThreadById, requireThreadForUser } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { logger } from "@/lib/logger";
import { hasStudioAction, requireStudioAction } from "@/lib/identity/studio-access";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import {
  WorkspacePathError,
  deleteWorkspaceFile,
  readWorkspaceFile,
  workspaceStat,
} from "@/lib/workspace";
import type { NextRequest } from "next/server";

/**
 * Workspaces 文件内容 API（Phase 4-4 切片 B2 + 切片 C 审计，catch-all path）。
 *
 * 同 workspace/route.ts：requirePermission(studio.access) → owner 范围（foreign → 404，不审计）
 * → workspace 权限（无 → 403，不审计）→ safeJoin/symlink 防护 throw → 400 + failed 审计。
 *
 * 审计（切片 C）：DELETE 成功 → workspace.file.deleted succeeded { path, deleted }；
 * WorkspacePathError → failed 审计 reasonCode=invalid_path；审计写失败 → 500 audit_failed
 * （Known gap：文件已删无法回滚，§4.3/§12）。
 *
 * GET    /studio/api/threads/[id]/workspace/[...path] → 读文件 { path, content, stat }；不存在 → 404
 * DELETE /studio/api/threads/[id]/workspace/[...path] → 删文件 { path, deleted }
 */

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const { id, path } = await params;

  const canAll = await hasStudioAction(r.principal, "thread.read");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.principal.userIdentityId);
  if (!thread) return jsonError(404, "THREAD_NOT_FOUND", "thread 不存在或无权访问");

  if (!(await hasStudioAction(r.principal, "workspace.read"))) {
    return jsonError(403, "forbidden", "无 workspace.read 权限");
  }
  const relPath = path.join("/");

  try {
    const content = await readWorkspaceFile(id, relPath);
    if (content === null) {
      return jsonError(404, "file_not_found", "文件不存在");
    }
    const stat = await workspaceStat(id, relPath);
    return jsonOk({ path: relPath, content, stat });
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      return jsonError(400, "invalid_path", error.message);
    }
    throw error;
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const actorUserId = r.principal.userIdentityId;
  const { id, path } = await params;

  const canAll = await hasStudioAction(r.principal, "thread.write");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.principal.userIdentityId);
  if (!thread) return jsonError(404, "THREAD_NOT_FOUND", "thread 不存在或无权访问");

  if (!(await hasStudioAction(r.principal, "workspace.write"))) {
    return jsonError(403, "forbidden", "无 workspace.write 权限");
  }
  const relPath = path.join("/");

  try {
    const deleted = await deleteWorkspaceFile(id, relPath);
    try {
      await recordAdminAudit({
        actorUserId,
        action: "workspace.file.deleted",
        targetType: "workspace",
        targetId: id,
        outcome: "succeeded",
        metadata: { path: relPath, deleted },
      });
    } catch (error) {
      logger.error("admin audit write failed (workspace delete success path)", {
        threadId: id,
        path: relPath,
        error: String(error),
      });
      return jsonError(500, "audit_failed", "审计写入失败");
    }
    return jsonOk({ path: relPath, deleted });
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      try {
        await recordAdminAudit({
          actorUserId,
          action: "workspace.file.deleted",
          targetType: "workspace",
          targetId: id,
          outcome: "failed",
          metadata: { reasonCode: "invalid_path", path: relPath },
        });
      } catch (auditError) {
        logger.error("admin audit write failed (workspace delete invalid path)", {
          threadId: id,
          error: String(auditError),
        });
      }
      return jsonError(400, "invalid_path", error.message);
    }
    throw error;
  }
}
