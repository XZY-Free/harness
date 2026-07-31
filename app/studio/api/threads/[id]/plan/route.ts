import {
  getActiveThreadPlan,
  getThreadById,
  listThreadPlanItems,
  requireThreadForUser,
} from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { hasPermission, requirePermission } from "@/lib/rbac";
import type { NextRequest } from "next/server";

/**
 * GET /studio/api/threads/[id]/plan → thread 当前 active plan + items（只读）。
 * V3.0 Stage E：plan/todo 观测入口。无 plan 时返回 { plan: null, items: [] }，
 * 由前端展示空状态。权限同 context route。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  const canAll = await hasPermission(r.user.id, "thread.read.all");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.user.id);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  const plan = await getActiveThreadPlan(id);
  const items = plan ? await listThreadPlanItems(id, plan.id) : [];
  return jsonOk({ threadId: id, plan, items });
}
