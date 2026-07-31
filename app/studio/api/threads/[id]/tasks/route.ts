import { getThreadById, requireThreadForUser } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { listByThread } from "@/lib/runtime/background-task-registry";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/threads/[id]/tasks → thread 后台任务列表（只读，V3.2 Stage E）。
 * 权限沿用既有 Studio thread 守卫：
 * - member：requireThreadForUser（foreign → 404，不泄露存在性）。
 * - admin（thread.read.all）：getThreadById（不存在 → 404）。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasPermission(r.user.id, "thread.read.all");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.user.id);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  const tasks = await listByThread(id);
  return jsonOk({
    threadId: id,
    tasks: tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      command: t.command,
      runtimeType: t.runtimeType,
      status: t.status,
      pid: t.pid,
      containerName: t.containerName,
      port: t.port,
      exitCode: t.exitCode,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      lastActivityAt: t.lastActivityAt,
    })),
  });
}
