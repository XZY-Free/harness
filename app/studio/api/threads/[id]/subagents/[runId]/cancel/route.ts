import { getSubagentRun, getThreadById, requireThreadForUser } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { updateRunStatus } from "@/lib/subagent/registry";
import { cancelSubagentExecution } from "@/lib/subagent/runtime";
import type { NextRequest } from "next/server";

/**
 * S1 修复（04-G15）：POST /studio/api/threads/[id]/subagents/[runId]/cancel
 *
 * Studio 面板取消活跃子代理 run（queued/running → cancelled）。权限沿用 Studio thread 守卫。
 * 调 cancelSubagentExecution（中断进程内 streamText）+ updateRunStatus(cancelled)（状态机 + 事件）。
 * 终态 run 取消为 no-op（状态机守护）。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const { id, runId } = await params;

  const canAll = await hasPermission(r.user.id, "thread.read.all");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.user.id);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  // P1-4:IDOR 守卫——校验 runId 归属当前 thread,防 member 用自己 thread 的合法 studio.access
  // 取消他人 thread 的子代理 run(原仅校验 thread 可见性,runId 透传未绑定)。
  const run = await getSubagentRun(runId);
  if (!run || run.parentThreadId !== id) {
    return jsonError(404, "run_not_found", "子代理 run 不存在或不属于该会话");
  }

  // 中断进程内执行（若活跃）+ 标记 cancelled
  cancelSubagentExecution(runId);
  const updated = await updateRunStatus(runId, "cancelled");
  if (!updated) return jsonError(404, "run_not_found", "子代理 run 不存在或已终态");
  return jsonOk({ runId, status: updated.status });
}
