import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
/**
 * GET /admin/api/v1/threads/{thread_id} — Thread 单资源详情（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Thread 存在且属于当前租户（跨租户隐藏为 404）。
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

  const thread = await getThreadById(principal.tenantId, threadId);
  if (!thread) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  const body = {
    id: thread.id,
    tenant_id: thread.tenantId,
    owner_user_id: thread.ownerUserId,
    default_workspace_id: thread.defaultWorkspaceId,
    active_goal_id: thread.activeGoalId,
    title: thread.title,
    default_model_ref: thread.defaultModelRef,
    default_environment_definition_id: thread.defaultEnvironmentDefinitionId,
    lifecycle_state: thread.lifecycleState,
    last_activity_at: thread.lastActivityAt.toISOString(),
    last_turn_sequence: thread.lastTurnSequence,
    last_item_sequence: thread.lastItemSequence,
    last_event_sequence: thread.lastEventSequence,
    pending_queue_version_no: thread.pendingQueueVersionNo,
    version_no: thread.versionNo,
    created_at: thread.createdAt.toISOString(),
    updated_at: thread.updatedAt.toISOString(),
    deleted_at: thread.deletedAt?.toISOString() ?? null,
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
