import {
  getPendingApprovalsByThread,
  getResolvedApprovalsByThread,
  getThreadById,
  requireThreadForUser,
} from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { hasPermission, requirePermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/threads/[id]/approvals → thread 的 pending + 最近 resolved 审批请求。
 *
 * V3.1 Stage E：审批可见性入口。权限同 thread detail route：
 * - member：requireThreadForUser（foreign → 404，不泄露存在性）
 * - admin（thread.read.all）：getThreadById（不存在 → 404）
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasPermission(r.user.id, "thread.read.all");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.user.id);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  const [pending, resolved] = await Promise.all([
    getPendingApprovalsByThread(id),
    getResolvedApprovalsByThread(id),
  ]);
  return jsonOk({ threadId: id, pending, resolved });
}
