import {
  getThreadById,
  listContextSnapshotsForThread,
  requireThreadForUser,
} from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { hasStudioAction, requireStudioAction } from "@/lib/identity/studio-access";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/threads/[id]/context → thread 最近 context snapshot（只读）。
 * V3.0 Stage E：observability 入口，沿用既有 Studio thread 权限：
 * - member：requireThreadForUser（foreign → 404，不泄露存在性）。
 * - admin（thread.read.all）：getThreadById（不存在 → 404）。
 * 默认取最近 5 条，避免大 thread 全量拉取。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasStudioAction(r.principal, "thread.read");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.principal.userIdentityId);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  const snapshots = await listContextSnapshotsForThread(id, 5);
  return jsonOk({ threadId: id, snapshots });
}
