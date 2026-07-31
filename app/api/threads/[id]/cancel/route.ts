import { getCurrentUserFromRequest } from "@/lib/auth";
import {
  appendThreadEvent,
  getPendingApprovalsByThread,
  getThreadByIdForUser,
  resolveApprovalRequest,
  updateThreadStatus,
} from "@/lib/db/queries";
import { cancelRun, getActiveRunForThread } from "@/lib/runtime/thread-runner";
import { NextResponse } from "next/server";

/**
 * V4 Phase B-1：取消会话当前执行（stop 按钮后端落点）。
 *
 * POST /api/threads/[id]/cancel → 找该 thread 的活跃 run → cancelRun（abort streamText + flush 落库）。
 * 前端 useChat.stop() 只中断 SSE fetch（客户端断开），后端 runner 仍跑；本端点真正停止后端执行（B-5）。
 *
 * V6-M1-2：支持 awaiting_approval 状态的 cancel。
 *
 * 鉴权：thread owner 校验（foreign → 404）。无活跃 run → 200 但 cancelled:false（幂等）。
 */

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: threadId } = await params;
  let userId: string;
  try {
    const user = await getCurrentUserFromRequest(request);
    userId = user.id;
  } catch {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }
  const thread = await getThreadByIdForUser(threadId, userId);
  if (!thread) {
    return NextResponse.json({ error: "会话不存在或无权访问" }, { status: 404 });
  }

  // V6-M1-2：支持 awaiting_approval 状态的 cancel
  // 修复竞态：无论 status 是什么，都同时检查 active run，避免 awaiting_approval 状态下
  // 并发 resume 已创建 run 但 status 尚未更新时遗漏取消。
  const active = getActiveRunForThread(threadId);

  if (thread.status === "awaiting_approval") {
    // 拒绝所有 pending 审批请求
    const pending = await getPendingApprovalsByThread(threadId);
    for (const approval of pending) {
      await resolveApprovalRequest({
        id: approval.id,
        decision: "denied",
        scope: "thread",
        resolvedBy: userId,
      });
    }
    // 若有并发 run 也一并取消
    if (active) {
      await cancelRun(active.runId, "user_cancelled");
    } else {
      // P1-5: CAS 守卫——仅 awaiting_approval 可迁 cancelled,防并发 approve/resume
      // 已切 executing 时被 cancelled 覆盖。CAS 失败返回 status_changed 不写事件。
      const cancelled = await updateThreadStatus(threadId, "cancelled", ["awaiting_approval"]);
      if (!cancelled) {
        return NextResponse.json({
          ok: true,
          data: { cancelled: false, reason: "status_changed" },
        });
      }
      await appendThreadEvent(threadId, "agent.status_changed", {
        from: "awaiting_approval",
        to: "cancelled",
        reason: "user_cancelled",
      }).catch(() => {});
    }
    return NextResponse.json({
      ok: true,
      data: { cancelled: true, reason: "awaiting_approval_cancelled" },
    });
  }

  if (!active) {
    return NextResponse.json({ ok: true, data: { cancelled: false, reason: "no_active_run" } });
  }
  await cancelRun(active.runId, "user_cancelled");
  return NextResponse.json({ ok: true, data: { cancelled: true, runId: active.runId } });
}
