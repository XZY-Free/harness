import { getDelegateRelationsByParentThread } from "@/lib/conversations/child-thread-queries";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
/**
 * GET /admin/api/v1/threads/{thread_id}/child-threads — 列出父 Thread 的 delegate 子 Thread 关系（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Thread 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 getDelegateRelationsByParentThread 返回 ThreadRelation 列表（按 createdAt 升序）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Thread 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ thread_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { thread_id: threadId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 校验 Thread 存在且属于当前租户
  const thread = await getThreadById(principal.tenantId, threadId);
  if (!thread) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  const relations = await getDelegateRelationsByParentThread(principal.tenantId, threadId);

  const projected = relations.map((r) => ({
    id: r.id,
    parent_thread_id: r.parentThreadId,
    child_thread_id: r.childThreadId,
    relation_type: r.relationType,
    source_turn_id: r.sourceTurnId,
    source_item_id: r.sourceItemId,
    source_invocation_id: r.sourceInvocationId,
    target_agent_id: r.targetAgentId,
    task_payload_ref: r.taskPayloadRef,
    task_payload_hash: r.taskPayloadHash,
    context_transfer_policy_json: r.contextTransferPolicyJson,
    budget_policy_json: r.budgetPolicyJson,
    budget_used_json: r.budgetUsedJson,
    relation_state: r.relationState,
    item_id: r.itemId,
    result_item_id: r.resultItemId,
    result_ref: r.resultRef,
    result_hash: r.resultHash,
    created_at: r.createdAt.toISOString(),
    completed_at: r.completedAt?.toISOString() ?? null,
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
