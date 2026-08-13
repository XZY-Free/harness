import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { getTurnById } from "@/lib/conversations/turn-queries";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
/**
 * GET /admin/api/v1/threads/{thread_id}/turns/{turn_id} — Turn 单资源详情（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 调用 getTurnById（innerJoin Thread 实现跨租户隔离 + threadId 校验）。
 * - 校验 Turn 属于路径 thread_id（否则 404）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Turn 不存在/跨租户/不属于该 Thread → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ thread_id: string; turn_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { thread_id: threadId, turn_id: turnId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const turn = await getTurnById(principal.tenantId, turnId);
  if (!turn || turn.threadId !== threadId) {
    return resourceNotFound(requestId, `Turn 不存在或无权访问: ${turnId}`);
  }

  const body = {
    id: turn.id,
    thread_id: turn.threadId,
    turn_sequence: turn.turnSequence,
    trigger_type: turn.triggerType,
    trigger_ref: turn.triggerRef,
    trigger_item_id: turn.triggerItemId,
    turn_state: turn.turnState,
    active_invocation_id: turn.activeInvocationId,
    latest_invocation_id: turn.latestInvocationId,
    adopted_invocation_id: turn.adoptedInvocationId,
    final_item_id: turn.finalItemId,
    error_code: turn.errorCode,
    regeneration_no: turn.regenerationNo,
    regeneration_base_state: turn.regenerationBaseState,
    accepted_at: turn.acceptedAt.toISOString(),
    started_at: turn.startedAt?.toISOString() ?? null,
    waiting_at: turn.waitingAt?.toISOString() ?? null,
    finished_at: turn.finishedAt?.toISOString() ?? null,
    version_no: turn.versionNo,
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
