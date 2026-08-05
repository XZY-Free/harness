import { listItemsByThread } from "@/lib/conversations/thread-item-queries";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/v11/admin/route-helpers";
/**
 * GET /admin/api/v1/threads/{thread_id}/items — 列出 Thread 下所有 Item（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Thread 存在且属于当前租户（跨租户隐藏为 404）。
 * - 支持查询参数 turn_id、include_superseded（默认 false）、limit、after_sequence。
 * - 调用 listItemsByThread 返回 Item 列表。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Thread 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - limit / after_sequence 非法 → 400 REQUEST_SCHEMA_INVALID
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

  // 解析查询参数
  const url = new URL(request.url);
  const turnId = url.searchParams.get("turn_id") ?? undefined;
  const includeSuperseded = url.searchParams.get("include_superseded") === "true";
  const limitParam = url.searchParams.get("limit");
  const afterSequenceParam = url.searchParams.get("after_sequence");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }
  let afterSequence: number | undefined;
  if (afterSequenceParam) {
    afterSequence = Number.parseInt(afterSequenceParam, 10);
    if (!Number.isFinite(afterSequence)) {
      return schemaInvalidTable(requestId, "after_sequence 必须是整数");
    }
  }

  const items = await listItemsByThread(principal.tenantId, threadId, {
    turnId,
    includeSuperseded,
    limit,
    afterSequence,
  });

  const projected = items.map((i) => ({
    id: i.id,
    thread_id: i.threadId,
    turn_id: i.turnId,
    item_sequence: i.itemSequence,
    item_type: i.itemType,
    item_state: i.itemState,
    author_type: i.authorType,
    author_id: i.authorId,
    content_json: i.contentJson,
    content_hash: i.contentHash,
    context_policy: i.contextPolicy,
    invocation_id: i.invocationId,
    superseded_by_item_id: i.supersededByItemId,
    created_at: i.createdAt.toISOString(),
    updated_at: i.updatedAt.toISOString(),
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
