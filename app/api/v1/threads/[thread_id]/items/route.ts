/**
 * GET /api/v1/threads/{thread_id}/items — 查询 Item（S04-C03，§3.5）。
 *
 * 事实源：docs/architecture/api-and-events.md §3.5、
 *         docs/architecture/conversations.md S04-W03。
 *
 * 行为：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 解析查询参数（cursor/limit/turn_id/include_superseded）。
 * - 调用 getItemSnapshotWithCursor 一致性读点读取 Item + latest_event_cursor。
 * - 返回 200 + items + next_cursor + latest_event_cursor。
 *
 * 关键约束（§3.5 行 301）：
 * - Item 列表与 latest_event_cursor 在同一一致性读点生成。
 * - 不返回 Token delta、隐藏思维链或 Credential。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - cursor 非法 → 400 REQUEST_SCHEMA_INVALID
 */
import { getItemSnapshotWithCursor } from "@/lib/conversations/read-model-queries";
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import {
  REQUEST_ID_HEADER,
  apiSuccess,
  decodeCursor,
  encodeCursor,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
import type { ThreadItem } from "@/lib/persistence/schema/conversation";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ thread_id: string }>;
}

/** 投影 Item 为响应体（snake_case）。 */
function projectItem(item: ThreadItem): Record<string, unknown> {
  return {
    id: item.id,
    turn_id: item.turnId,
    item_sequence: item.itemSequence,
    item_type: item.itemType,
    item_state: item.itemState,
    content: item.contentJson,
    created_at: item.createdAt.toISOString(),
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { thread_id: threadId } = await context.params;

  // 1. 解析员工身份
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Thread 属于当前员工（非 owner → 404 隐藏式）
  const thread = await getThreadById(principal.tenantId, threadId);
  if (!thread || thread.ownerUserId !== principal.userIdentityId) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  // 3. 解析查询参数
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");
  const turnId = url.searchParams.get("turn_id") ?? undefined;
  const includeSupersededParam = url.searchParams.get("include_superseded");
  const includeSuperseded = includeSupersededParam === "true";

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
    return schemaInvalidTable(requestId, "limit 必须为 1–200 之间的整数");
  }

  // 解析 cursor（不透明 base64url JSON）
  let afterSequence: number | undefined;
  if (cursor) {
    try {
      const decoded = decodeCursor(cursor) as { after_sequence?: number };
      if (typeof decoded.after_sequence !== "number") {
        return schemaInvalidTable(requestId, "cursor 非法：缺少 after_sequence");
      }
      afterSequence = decoded.after_sequence;
    } catch {
      return schemaInvalidTable(requestId, "cursor 非法：无法解码");
    }
  }

  // 4. 一致性读点读取 Item + latest_event_cursor
  const { items, latestEventCursor } = await getItemSnapshotWithCursor(
    principal.tenantId,
    threadId,
    {
      turnId,
      includeSuperseded,
      limit,
    },
  );

  // 5. 构造 next_cursor（按 item_sequence 升序，最后一条的 sequence 作为游标）
  let nextCursor: string | null = null;
  if (items.length === limit) {
    const lastItem = items[items.length - 1];
    if (lastItem) {
      nextCursor = encodeCursor({ after_sequence: lastItem.itemSequence });
    }
  }

  // 6. 返回 200 + items + next_cursor + latest_event_cursor
  const responseBody = {
    items: items.map(projectItem),
    next_cursor: nextCursor,
    latest_event_cursor: latestEventCursor
      ? {
          sequence: latestEventCursor.sequence,
          event_id: latestEventCursor.eventId,
        }
      : null,
  };

  return apiSuccess(responseBody, {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
