import { listDeliveryFailures } from "@/lib/conversations/projection-operations";
/**
 * GET /admin/api/v1/event-delivery — 列出租户事件交付失败记录（S12-W01）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 支持查询参数 consumer_name、state、stream_type、stream_id、limit。
 * - 调用 listDeliveryFailures（租户隔离，inner join eventStreamFloorTable）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - state 非法 → 400 REQUEST_SCHEMA_INVALID
 * - stream_type 非法 → 400 REQUEST_SCHEMA_INVALID
 * - limit 非法 → 400 REQUEST_SCHEMA_INVALID
 */
import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import {
  DELIVERY_FAILURE_STATES,
  type DeliveryFailureState,
  STREAM_TYPES,
  type StreamType,
} from "@/lib/persistence/schema/projection";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/v11/admin/route-helpers";

export const dynamic = "force-dynamic";

const VALID_STATES: Set<string> = new Set(DELIVERY_FAILURE_STATES);
const VALID_STREAM_TYPES: Set<string> = new Set(STREAM_TYPES);

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
  const consumerName = url.searchParams.get("consumer_name") ?? undefined;
  const stateParam = url.searchParams.get("state");
  const streamTypeParam = url.searchParams.get("stream_type");
  const streamId = url.searchParams.get("stream_id") ?? undefined;
  const limitParam = url.searchParams.get("limit");

  let failureState: DeliveryFailureState | undefined;
  if (stateParam) {
    if (!VALID_STATES.has(stateParam)) {
      return schemaInvalidTable(requestId, `state 非法: ${stateParam}`);
    }
    failureState = stateParam as DeliveryFailureState;
  }

  let streamType: StreamType | undefined;
  if (streamTypeParam) {
    if (!VALID_STREAM_TYPES.has(streamTypeParam)) {
      return schemaInvalidTable(requestId, `stream_type 非法: ${streamTypeParam}`);
    }
    streamType = streamTypeParam as StreamType;
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }

  // 3. 查询交付失败记录（租户隔离）
  const failures = await listDeliveryFailures(principal.tenantId, {
    consumerName,
    failureState,
    streamType,
    streamId,
    limit,
  });

  // 4. 投影并返回 200
  const projected = failures.map(projectFailure);
  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}

/** 投影 EventDeliveryFailure 为 snake_case 响应体。 */
function projectFailure(f: {
  id: string;
  consumerName: string;
  streamType: string;
  streamId: string;
  eventId: string;
  eventSequence: number;
  payloadHash: string | null;
  failureClass: string;
  failureState: string;
  attemptCount: number;
  nextRetryAt: Date | null;
  lastErrorCode: string | null;
  lastErrorDetailJson: unknown;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
}) {
  return {
    id: f.id,
    consumer_name: f.consumerName,
    stream_type: f.streamType,
    stream_id: f.streamId,
    event_id: f.eventId,
    event_sequence: f.eventSequence,
    payload_hash: f.payloadHash,
    failure_class: f.failureClass,
    failure_state: f.failureState,
    attempt_count: f.attemptCount,
    next_retry_at: f.nextRetryAt ? f.nextRetryAt.toISOString() : null,
    last_error_code: f.lastErrorCode,
    last_error_detail: f.lastErrorDetailJson,
    created_at: f.createdAt.toISOString(),
    updated_at: f.updatedAt.toISOString(),
    resolved_at: f.resolvedAt ? f.resolvedAt.toISOString() : null,
  };
}
