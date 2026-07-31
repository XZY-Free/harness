import {
  getThreadById,
  listCheckpointsByThread,
  listThreadEvents,
  requireThreadForUser,
} from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { hasPermission, requirePermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/threads/[id]/delivery → 最近 deliverySummary（delivery.succeeded payload）
 * + checkpoint 历史 + commit/PR 链接。V3.7 Stage E：Studio 交付观测入口。
 *
 * 权限同 plan/context route：owner 或 thread.read.all；foreign → 404；未登录 → 401；
 * 无 studio.access → 403。无交付时返回空状态。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasPermission(r.user.id, "thread.read.all");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.user.id);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  // 最近 deliverySummary = 最近一条 delivery.succeeded 事件的 payload
  const events = await listThreadEvents(id);
  const deliveryEvent = [...events].reverse().find((e) => e.type === "delivery.succeeded");
  const summary = deliveryEvent ? (deliveryEvent.payload as Record<string, unknown>) : null;

  const checkpoints = await listCheckpointsByThread(id);

  return jsonOk({
    threadId: id,
    summary,
    checkpoints: checkpoints.map((c) => ({
      id: c.id,
      tag: c.tag,
      commitSha: c.commitSha,
      reason: c.reason,
      restoredAt: c.restoredAt,
      createdAt: c.createdAt,
    })),
  });
}
