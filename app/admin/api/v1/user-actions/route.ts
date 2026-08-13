import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { REQUEST_ID_HEADER, apiSuccess, decodeCursor, getRequestId } from "@/lib/http";
import { listUserActionRequestsByTenant } from "@/lib/permission/user-action-queries";
/**
 * GET /admin/api/v1/user-actions — 跨 invocation 列出租户所有 UserActionRequest（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 支持查询参数 request_state、request_type、limit、cursor。
 * - cursor 为不透明 base64url(JSON{ created_at, id })，由 listUserActionRequestsByTenant 解析为 afterCreatedAt。
 * - 调用 listUserActionRequestsByTenant（按 createdAt 降序）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - request_state / request_type 非法 → 400 REQUEST_SCHEMA_INVALID
 * - cursor 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

const VALID_REQUEST_STATES = new Set(["pending", "resolved", "expired"]);
const VALID_REQUEST_TYPES = new Set(["confirmation", "auth", "grant", "input"]);

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
  const requestStateParam = url.searchParams.get("request_state");
  const requestTypeParam = url.searchParams.get("request_type");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }

  let requestState: "pending" | "resolved" | "expired" | undefined;
  if (requestStateParam) {
    if (!VALID_REQUEST_STATES.has(requestStateParam)) {
      return schemaInvalidTable(requestId, `request_state 非法: ${requestStateParam}`);
    }
    requestState = requestStateParam as "pending" | "resolved" | "expired";
  }

  let requestType: "confirmation" | "auth" | "grant" | "input" | undefined;
  if (requestTypeParam) {
    if (!VALID_REQUEST_TYPES.has(requestTypeParam)) {
      return schemaInvalidTable(requestId, `request_type 非法: ${requestTypeParam}`);
    }
    requestType = requestTypeParam as "confirmation" | "auth" | "grant" | "input";
  }

  let afterCreatedAt: Date | undefined;
  if (cursor) {
    try {
      const decoded = decodeCursor(cursor) as { created_at?: string };
      if (typeof decoded.created_at !== "string") {
        return schemaInvalidTable(requestId, "cursor 缺少 created_at 字段");
      }
      afterCreatedAt = new Date(decoded.created_at);
      if (Number.isNaN(afterCreatedAt.getTime())) {
        return schemaInvalidTable(requestId, "cursor.created_at 不是合法 ISO 时间");
      }
    } catch (err) {
      return schemaInvalidTable(requestId, `cursor 解析失败: ${(err as Error).message}`);
    }
  }

  // 3. 查询 UserActionRequest 列表
  const { items, nextCursor } = await listUserActionRequestsByTenant(principal.tenantId, {
    requestState,
    requestType,
    limit,
    afterCreatedAt,
  });

  // 4. 投影并返回 200
  const projected = items.map((r) => ({
    id: r.id,
    tenant_id: r.tenantId,
    thread_id: r.threadId,
    turn_id: r.turnId,
    invocation_id: r.invocationId,
    tool_call_id: r.toolCallId,
    item_id: r.itemId,
    request_type: r.requestType,
    purpose: r.purpose,
    request_state: r.requestState,
    prompt_json: r.promptJson,
    input_schema_json: r.inputSchemaJson,
    auth_state_hash: r.authStateHash,
    nonce_hash: r.nonceHash,
    resolution: r.resolution,
    resolved_by: r.resolvedBy,
    resolved_at: r.resolvedAt?.toISOString() ?? null,
    response_redacted_json: r.responseRedactedJson,
    grant_id: r.grantId,
    expires_at: r.expiresAt?.toISOString() ?? null,
    version_no: r.versionNo,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }));

  return apiSuccess(
    { items: projected, next_cursor: nextCursor, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
