import { REQUEST_ID_HEADER, getRequestId, v11NotFound, v11Ok } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import { getThreadById, listThreadEvents } from "@/lib/v11/conversation/thread-queries";
/**
 * GET /admin/api/v1/threads/{thread_id}/events — 列出 Thread 事件流（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Thread 存在且属于当前租户（跨租户隐藏为 404）。
 * - 支持查询参数 after_sequence、limit。
 * - 调用 listThreadEvents 返回事件流（按 event_sequence 升序）。
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
    return v11NotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  // 解析查询参数
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const afterSequenceParam = url.searchParams.get("after_sequence");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }
  let afterSequence: number | undefined;
  if (afterSequenceParam) {
    afterSequence = Number.parseInt(afterSequenceParam, 10);
    if (!Number.isFinite(afterSequence)) {
      return v11SchemaInvalid(requestId, "after_sequence 必须是整数");
    }
  }

  const events = await listThreadEvents(principal.tenantId, threadId, {
    afterSequence,
    limit,
  });

  const projected = events.map((e) => ({
    id: e.id,
    thread_id: e.threadId,
    event_sequence: e.eventSequence,
    event_type: e.eventType,
    schema_version: e.schemaVersion,
    turn_id: e.turnId,
    item_id: e.itemId,
    invocation_id: e.invocationId,
    actor_type: e.actorType,
    actor_id: e.actorId,
    payload_json: e.payloadJson,
    correlation_id: e.correlationId,
    causation_id: e.causationId,
    idempotency_key: e.idempotencyKey,
    occurred_at: e.occurredAt.toISOString(),
    ingested_at: e.ingestedAt.toISOString(),
  }));

  return v11Ok(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
