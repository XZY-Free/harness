import { getThreadById } from "@/lib/conversations/thread-queries";
import { getTurnsByThread } from "@/lib/conversations/turn-queries";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
/**
 * GET /admin/api/v1/threads/{thread_id}/turns — 列出 Thread 下所有 Turn（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Thread 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 getTurnsByThread 返回 Turn 列表。
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

  const turns = await getTurnsByThread(principal.tenantId, threadId);
  const projected = turns.map((t) => ({
    id: t.id,
    thread_id: t.threadId,
    turn_sequence: t.turnSequence,
    trigger_type: t.triggerType,
    trigger_ref: t.triggerRef,
    trigger_item_id: t.triggerItemId,
    turn_state: t.turnState,
    active_invocation_id: t.activeInvocationId,
    latest_invocation_id: t.latestInvocationId,
    adopted_invocation_id: t.adoptedInvocationId,
    final_item_id: t.finalItemId,
    error_code: t.errorCode,
    regeneration_no: t.regenerationNo,
    regeneration_base_state: t.regenerationBaseState,
    accepted_at: t.acceptedAt.toISOString(),
    started_at: t.startedAt?.toISOString() ?? null,
    waiting_at: t.waitingAt?.toISOString() ?? null,
    finished_at: t.finishedAt?.toISOString() ?? null,
    version_no: t.versionNo,
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
