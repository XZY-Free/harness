import { getItemById } from "@/lib/conversations/thread-item-queries";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
/**
 * GET /admin/api/v1/threads/{thread_id}/items/{item_id} — ThreadItem 单资源详情（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 调用 getItemById（innerJoin Thread 实现跨租户隔离）。
 * - 校验 Item 属于路径 thread_id（否则 404）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Item 不存在/跨租户/不属于该 Thread → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ thread_id: string; item_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { thread_id: threadId, item_id: itemId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const item = await getItemById(principal.tenantId, itemId);
  if (!item || item.threadId !== threadId) {
    return resourceNotFound(requestId, `Item 不存在或无权访问: ${itemId}`);
  }

  const body = {
    id: item.id,
    thread_id: item.threadId,
    turn_id: item.turnId,
    item_sequence: item.itemSequence,
    item_type: item.itemType,
    item_state: item.itemState,
    author_type: item.authorType,
    author_id: item.authorId,
    content_json: item.contentJson,
    content_hash: item.contentHash,
    context_policy: item.contextPolicy,
    invocation_id: item.invocationId,
    superseded_by_item_id: item.supersededByItemId,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
