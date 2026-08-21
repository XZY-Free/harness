import {
  appendThreadEvent,
  getApprovalRequest,
  getThreadById,
  requireThreadForUser,
  resolveApprovalRequest,
} from "@/lib/db/queries";
import type { ApprovalScope } from "@/lib/db/schema";
import { jsonError, jsonOk } from "@/lib/http";
import { hasStudioAction, requireStudioAction } from "@/lib/identity/studio-access";
import type { NextRequest } from "next/server";

/**
 * S1（07-P1-6）：批量决议审批请求。
 *
 * POST /studio/api/threads/[id]/approvals/batch
 * body: { approvalIds: string[], decision: "approved"|"denied", scope: ApprovalScope, confirm?: boolean }
 *
 * 单事务语义：逐条调 resolveApprovalRequest（每条独立 pending 校验），失败的条目记入 errors
 * 但不阻塞其他条目（部分成功）。逐条写 tool.approval_resolved 事件。
 *
 * 权限同单条决议：thread owner 可批量决议自己的待审批；admin（thread.read.all）可决议任意 thread。
 * scope=always 需二次确认（与单条一致）。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "studio.access");
  if (!r.ok) return r.response;
  const { id } = await params;

  // 校验 thread 可见性（owner 或 admin）
  const canAll = await hasStudioAction(r.principal, "thread.write");
  const thread = canAll ? await getThreadById(id) : await requireThreadForUser(id, r.principal.userIdentityId);
  if (!thread) return jsonError(404, "thread_not_found", "会话不存在");

  // 解析 body
  let body: {
    approvalIds?: unknown;
    decision?: string;
    scope?: string;
    confirm?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "bad_request", "请求体非合法 JSON");
  }

  if (!Array.isArray(body.approvalIds) || body.approvalIds.length === 0) {
    return jsonError(400, "bad_request", "approvalIds 必须为非空数组");
  }
  if (body.approvalIds.length > 100) {
    return jsonError(400, "bad_request", "单次批量上限 100 条");
  }
  if (body.decision !== "approved" && body.decision !== "denied") {
    return jsonError(400, "bad_request", "decision 必须为 approved 或 denied");
  }
  const validScopes: ApprovalScope[] = ["once", "thread", "project", "always", "session"];
  if (!body.scope || !validScopes.includes(body.scope as ApprovalScope)) {
    return jsonError(400, "bad_request", "scope 必须为 once/thread/project/always/session");
  }
  // scope=always 高危操作需二次确认（与单条一致）
  if (body.scope === "always" && body.decision === "approved" && body.confirm !== true) {
    return jsonError(
      400,
      "confirm_required",
      "scope=always 需二次确认：请在 body 中传 confirm: true",
    );
  }

  // 逐条决议（部分成功语义：失败的条目记入 errors，不阻塞其他条目）
  const resolved: Array<{ id: string; status: string; approvedScope: string | null }> = [];
  const errors: Array<{ id: string; reason: string }> = [];
  for (const approvalId of body.approvalIds) {
    if (typeof approvalId !== "string") {
      errors.push({ id: String(approvalId), reason: "approvalId 必须为字符串" });
      continue;
    }
    const approval = await getApprovalRequest(approvalId);
    if (!approval || approval.threadId !== id) {
      errors.push({ id: approvalId, reason: "审批请求不存在或不属于该 thread" });
      continue;
    }
    if (approval.status !== "pending") {
      errors.push({ id: approvalId, reason: `审批已处于 ${approval.status} 状态` });
      continue;
    }
    const updated = await resolveApprovalRequest({
      id: approvalId,
      decision: body.decision as "approved" | "denied",
      scope: body.scope as ApprovalScope,
      resolvedBy: r.principal.userIdentityId,
    });
    if (!updated) {
      // 并发：已被另一请求决议
      errors.push({ id: approvalId, reason: "审批已被决议（并发冲突）" });
      continue;
    }
    await appendThreadEvent(id, "tool.approval_resolved", {
      approvalId: updated.id,
      toolRunId: updated.toolRunId,
      decision: updated.status,
      scope: updated.approvedScope,
      resolvedBy: r.principal.userIdentityId,
    });
    resolved.push({
      id: updated.id,
      status: updated.status,
      approvedScope: updated.approvedScope,
    });
  }

  return jsonOk({
    resolved,
    errors,
    total: body.approvalIds.length,
    resolvedCount: resolved.length,
    errorCount: errors.length,
  });
}
