import { getProjectionHealth } from "@/lib/conversations/read-model-queries";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
/**
 * GET /admin/api/v1/threads/{thread_id}/projection-health — 投影健康检查（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 调用 getProjectionHealth 返回 thread_list_projection 与 turn_timeline_projection 的
 *   checkpoint / latestEventSequence / lag。
 * - Thread 不存在或跨租户 → 404（getProjectionHealth 返回 null）。
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

  const health = await getProjectionHealth(principal.tenantId, threadId);
  if (!health) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  const body = {
    thread_list_checkpoint: health.threadListCheckpoint,
    turn_timeline_checkpoint: health.turnTimelineCheckpoint,
    latest_event_sequence: health.latestEventSequence,
    thread_list_lag: health.threadListLag,
    turn_timeline_lag: health.turnTimelineLag,
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
