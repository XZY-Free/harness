import { REQUEST_ID_HEADER, decodeCursor, getRequestId, v11Ok } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import { listThreadProjectionsByTenant } from "@/lib/v11/conversation/read-model-queries";
/**
 * GET /admin/api/v1/threads — 跨 owner 列出租户所有 Thread（S11-W04）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md
 *   S11-W04：「会话、协作与 Job 排障」
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 支持查询参数 lifecycle_state（active/archived/deleted）、limit、cursor。
 * - cursor 为不透明 base64url(JSON{ created_at, id })，由 listThreadProjectionsByTenant 解析为 afterCreatedAt。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - lifecycle_state 非法 → 400 REQUEST_SCHEMA_INVALID
 * - cursor 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

const VALID_LIFECYCLE_STATES = new Set(["active", "archived", "deleted"]);

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析 admin 主体
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析查询参数
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const lifecycleStateParam = url.searchParams.get("lifecycle_state");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  let lifecycleState: "active" | "archived" | "deleted" | undefined;
  if (lifecycleStateParam) {
    if (!VALID_LIFECYCLE_STATES.has(lifecycleStateParam)) {
      return v11SchemaInvalid(requestId, `lifecycle_state 非法: ${lifecycleStateParam}`);
    }
    lifecycleState = lifecycleStateParam as "active" | "archived" | "deleted";
  }

  let afterCreatedAt: Date | undefined;
  if (cursor) {
    try {
      const decoded = decodeCursor(cursor) as { created_at?: string };
      if (typeof decoded.created_at !== "string") {
        return v11SchemaInvalid(requestId, "cursor 缺少 created_at 字段");
      }
      afterCreatedAt = new Date(decoded.created_at);
      if (Number.isNaN(afterCreatedAt.getTime())) {
        return v11SchemaInvalid(requestId, "cursor.created_at 不是合法 ISO 时间");
      }
    } catch (err) {
      return v11SchemaInvalid(requestId, `cursor 解析失败: ${(err as Error).message}`);
    }
  }

  // 3. 查询 Thread 投影
  const projections = await listThreadProjectionsByTenant(principal.tenantId, {
    lifecycleState,
    limit,
    afterCreatedAt,
  });

  // 4. 投影并返回 200
  const projected = projections.map((p) => ({
    thread_id: p.threadId,
    tenant_id: p.tenantId,
    owner_user_id: p.ownerUserId,
    primary_agent_id: p.primaryAgentId,
    title: p.title,
    lifecycle_state: p.lifecycleState,
    last_activity_at: p.lastActivityAt.toISOString(),
    last_item_summary: p.lastItemSummary,
    last_item_type: p.lastItemType,
    last_item_sequence: p.lastItemSequence,
    last_item_author_type: p.lastItemAuthorType,
    last_item_created_at: p.lastItemCreatedAt?.toISOString() ?? null,
    current_turn_id: p.currentTurnId,
    current_turn_sequence: p.currentTurnSequence,
    current_turn_state: p.currentTurnState,
    latest_event_sequence: p.latestEventSequence,
    latest_event_id: p.latestEventId,
    has_unread_events: p.hasUnreadEvents,
    updated_at: p.updatedAt.toISOString(),
    version_no: p.versionNo,
  }));

  // 构造 next_cursor：取最后一行的 last_activity_at
  let nextCursor: string | null = null;
  const last = projections[projections.length - 1];
  if (last && projections.length === limit) {
    nextCursor = Buffer.from(
      JSON.stringify({
        created_at: last.lastActivityAt.toISOString(),
        id: last.threadId,
      }),
      "utf-8",
    ).toString("base64url");
  }

  return v11Ok(
    { items: projected, next_cursor: nextCursor, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
