import {
  appendThreadEvent,
  getApprovalRequest,
  getThreadById,
  requireThreadForUser,
  resolveApprovalRequest,
  updateThreadStatus,
} from "@/lib/db/queries";
import type { ApprovalScope } from "@/lib/db/schema";
import { jsonError, jsonOk } from "@/lib/http";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import type { NextRequest } from "next/server";

/**
 * POST /studio/api/threads/[id]/approvals/[approvalId] → 决议一条审批请求。
 *
 * V3.1 Stage E：审批操作入口。body: { decision: "approved"|"denied", scope: "once"|"thread"|"project"|"always" }。
 * 权限：thread owner 可审批自己的待审批；admin（thread.read.all）可审批任意 thread。
 * 状态机：仅 status=pending 可决议；已 resolved → 409；不存在 / 不属于该 thread → 404。
 * 决议后写 tool.approval_resolved 事件；approved 时前端重发 chat 恢复执行（见 chat route）。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; approvalId: string }> },
) {
  const r = await requirePermission(req, "studio.access");
  if (!r.ok) return r.response;
  const { id, approvalId } = await params;

  // 校验 thread 可见性（owner 或 admin）
  const canAll = await hasPermission(r.user.id, "thread.write.all");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.user.id);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  // 解析 body
  let body: { decision?: string; scope?: string };
  try {
    body = (await req.json()) as { decision?: string; scope?: string };
  } catch {
    return jsonError(400, "bad_request", "请求体非合法 JSON");
  }
  // S1（07-P2-7）：scope=always 需二次确认
  const bodyTyped = body as { decision?: string; scope?: string; confirm?: boolean };
  if (bodyTyped.decision !== "approved" && bodyTyped.decision !== "denied") {
    return jsonError(400, "bad_request", "decision 必须为 approved 或 denied");
  }
  const validScopes: ApprovalScope[] = ["once", "thread", "project", "always", "session"];
  if (!bodyTyped.scope || !validScopes.includes(bodyTyped.scope as ApprovalScope)) {
    return jsonError(400, "bad_request", "scope 必须为 once/thread/project/always/session");
  }

  // S1（07-P2-7）：scope=always 高危操作需二次确认（body.confirm===true），防误操作永久放行
  if (
    bodyTyped.scope === "always" &&
    bodyTyped.decision === "approved" &&
    bodyTyped.confirm !== true
  ) {
    return jsonError(
      400,
      "confirm_required",
      "scope=always 需二次确认：请在 body 中传 confirm: true",
    );
  }

  // 取审批请求；不存在或不属于该 thread → 404（不泄露存在性）
  const approval = await getApprovalRequest(approvalId);
  if (!approval || approval.threadId !== id) {
    return jsonError(404, "approval_not_found", "审批请求不存在");
  }
  if (approval.status !== "pending") {
    return jsonError(409, "approval_already_resolved", `审批已处于 ${approval.status} 状态`);
  }

  const updated = await resolveApprovalRequest({
    id: approvalId,
    decision: bodyTyped.decision as "approved" | "denied",
    scope: bodyTyped.scope as ApprovalScope,
    resolvedBy: r.user.id,
  });
  if (!updated) {
    // 并发：已被另一请求决议
    return jsonError(409, "approval_already_resolved", "审批已被决议");
  }

  await appendThreadEvent(id, "tool.approval_resolved", {
    approvalId: updated.id,
    toolRunId: updated.toolRunId,
    decision: updated.status,
    scope: updated.approvedScope,
    resolvedBy: r.user.id,
  });

  // 审计修复：审批决议记录到 admin audit log。
  // scope=always/project/session 的审批创建了持久权限放行，必须可追溯（谁、何时、何种 scope）。
  // 原实现仅写 threadEvent，不在 admin audit log 中留痕，安全审计无法追溯审批来源。
  await recordAdminAudit({
    actorUserId: r.user.id,
    action: "approval.resolved",
    targetType: "approval",
    targetId: `${id}:${approvalId}`,
    outcome: "succeeded",
    metadata: {
      toolName: approval.toolName,
      decision: updated.status,
      scope: updated.approvedScope ?? null,
      toolRunId: approval.toolRunId,
    },
  }).catch(() => {});

  // P2-13:denied 后 thread 回 idle,防前端不重发 chat 时永久卡 awaiting_approval。
  // approved 仍靠前端重发 chat 恢复执行(设计内,见 chat route decideApprovalResume)。
  if (updated.status === "denied") {
    await appendThreadEvent(id, "agent.status_changed", {
      from: "awaiting_approval",
      to: "idle",
      reason: "approval_denied",
    }).catch(() => {});
    await updateThreadStatus(id, "idle").catch(() => {});
  }

  return jsonOk({ approval: updated });
}
