/**
 * POST /runtime/v1/invocations/{invocation_id}/events:batch — Runtime 回传候选事件批次（S05-C03）。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md §4（Runtime Protocol API）
 * - docs/architecture/persistence.md §6.9（RuntimeEventIngress L486-500）
 * - docs/architecture/runtime-control-plane.md S05-C03
 *
 * 行为：
 * - 解析 Bearer Token（Workload Token，audience=runtime + invocation 绑定校验）。
 * - 校验 Idempotency-Key（必填）。
 * - 校验请求体（producer_sequence_start + events 数组，每个事件含 producer_event_id/producer_sequence/type/payload）。
 * - 调用 ingressEventBatch 事务内去重 + 序列校验 + 映射到平台状态。
 * - 返回 200 + accepted_through_producer_sequence + mapped_events。
 *
 * 错误映射：
 * - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - Invocation 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - Invocation 已终态 → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - producerSequence 不连续 → 409 EVENT_SEQUENCE_GAP（retryable）
 * - hash 冲突 → 409 IDEMPOTENCY_CONFLICT（不可修复，原子终止）
 * - 未知 candidateType → 422 EVENT_SCHEMA_UNSUPPORTED
 */
import { IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import {
  type WorkloadTokenClaims,
  ingressErrorToResponse,
  resolveRuntimePrincipal,
  runtimeAuthErrorResponse,
  runtimeSchemaInvalidTable,
} from "@/lib/runtime/route-helpers";

export const dynamic = "force-dynamic";

/**
 * 路径参数上下文（Next.js App Router 动态段，含冒号 custom method 段）。
 *
 * Next.js 类型验证器可能不识别 `events:batch` 为标准静态段，
 * 故使用 Record 宽类型；运行时 params key 为 "invocation_id"。
 */
interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/** 请求体 schema（§4 events:batch requestBody）。 */
interface EventsBatchBody {
  /** 本批次起始 producer_sequence（必须等于 events[0].producer_sequence）。 */
  producer_sequence_start: number;
  /** 候选事件列表（按 producer_sequence 升序）。 */
  events: Array<{
    producer_event_id: string;
    producer_sequence: number;
    type: string;
    schema_version?: number;
    occurred_at?: string;
    payload: Record<string, unknown>;
  }>;
}

/** 校验请求体结构。 */
function validateBody(body: unknown): body is EventsBatchBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.producer_sequence_start !== "number" || b.producer_sequence_start < 1) return false;
  if (!Array.isArray(b.events) || b.events.length === 0) return false;
  for (const ev of b.events) {
    if (!ev || typeof ev !== "object") return false;
    const e = ev as Record<string, unknown>;
    if (typeof e.producer_event_id !== "string" || e.producer_event_id.length === 0) return false;
    if (typeof e.producer_sequence !== "number" || e.producer_sequence < 1) return false;
    if (typeof e.type !== "string" || e.type.length === 0) return false;
    if (!e.payload || typeof e.payload !== "object") return false;
  }
  return true;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const params = await context.params;
  const rawValue = params.invocation_id;
  const invocationId = typeof rawValue === "string" ? rawValue : "";

  if (!invocationId) {
    return runtimeSchemaInvalidTable(requestId, "路径参数 invocation_id 缺失");
  }

  // 1. 解析 Bearer Token（audience=runtime + invocation 绑定校验）
  let claims: WorkloadTokenClaims;
  try {
    claims = await resolveRuntimePrincipal(request.headers, invocationId);
  } catch (err) {
    const authResp = runtimeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Idempotency-Key（必填）
  if (!request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim()) {
    return runtimeSchemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 3. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return runtimeSchemaInvalidTable(
      requestId,
      "请求体非法：producer_sequence_start 必填且≥1，events 必填且为非空数组，每个事件含 producer_event_id/producer_sequence/type/payload",
    );
  }

  // 4. 执行业务：事务内去重 + 序列校验 + 映射
  try {
    const result = await ingressEventBatch({
      tenantId: claims.tenantId,
      invocationId,
      producerSequenceStart: body.producer_sequence_start,
      events: body.events,
      correlationId: requestId,
    });

    const responseBody = {
      invocation_id: result.invocationId,
      accepted_through_producer_sequence: result.acceptedThroughProducerSequence,
      mapped_events: result.mappedEvents.map((m) => ({
        producer_event_id: m.producerEventId,
        thread_event_id: m.threadEventId,
        thread_sequence: m.threadSequence,
        item_id: m.itemId,
      })),
    };

    return apiSuccess(responseBody, {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    const errorResp = await ingressErrorToResponse(err, requestId);
    if (errorResp) return errorResp;
    throw err;
  }
}
