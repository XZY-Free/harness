import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  gatewaySchemaInvalidTable,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";
import { IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import { type RuntimeCandidateEvent, ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { ingressErrorToResponse } from "@/lib/runtime/route-helpers";

/**
 * POST /gateway/v1/runtime-events — External Runtime 回传候选事件批次。
 *
 * External Runtime 只能持有 StartInvocation 下发的 Gateway Workload Token；
 * 因此回调不再拼接 `in-process://` 标识或复用 Runtime inbound token，而是走
 * 与其它 Gateway API 相同的 invocation-scoped 鉴权，再进入唯一 ingressEventBatch 事实源。
 */

export const dynamic = "force-dynamic";

export interface RuntimeEventsBody {
  invocation_id: string;
  producer_sequence_start: number;
  events: RuntimeCandidateEvent[];
}

export function parseGatewayRuntimeEventsBody(raw: unknown): RuntimeEventsBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const keys = new Set(["invocation_id", "producer_sequence_start", "events"]);
  if (Object.keys(body).some((key) => !keys.has(key))) return null;
  if (typeof body.invocation_id !== "string" || body.invocation_id.trim().length === 0) return null;
  if (
    !Number.isInteger(body.producer_sequence_start) ||
    (body.producer_sequence_start as number) < 1
  ) {
    return null;
  }
  if (!Array.isArray(body.events) || body.events.length === 0) return null;
  for (const candidate of body.events) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const event = candidate as Record<string, unknown>;
    if (
      typeof event.producer_event_id !== "string" ||
      event.producer_event_id.trim().length === 0 ||
      !Number.isInteger(event.producer_sequence) ||
      (event.producer_sequence as number) < 1 ||
      typeof event.type !== "string" ||
      event.type.trim().length === 0 ||
      !event.payload ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload)
    ) {
      return null;
    }
  }
  return {
    invocation_id: body.invocation_id,
    producer_sequence_start: body.producer_sequence_start as number,
    events: body.events as RuntimeCandidateEvent[],
  };
}

export function gatewayRuntimeEventsResponseBody(
  principal: GatewayPrincipal,
  result: Awaited<ReturnType<typeof ingressEventBatch>>,
) {
  return {
    invocation_id: principal.invocationId,
    accepted_through_producer_sequence: result.acceptedThroughProducerSequence,
    mapped_events: result.mappedEvents.map((mapped) => ({
      producer_event_id: mapped.producerEventId,
      thread_event_id: mapped.threadEventId,
      thread_sequence: mapped.threadSequence,
      item_id: mapped.itemId,
    })),
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  let principal: GatewayPrincipal;
  try {
    principal = await resolveGatewayPrincipal(request.headers);
  } catch (error) {
    const response = gatewayAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }
  if (!request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim()) {
    return gatewaySchemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }
  const body = parseGatewayRuntimeEventsBody(await request.json().catch(() => null));
  if (!body || body.invocation_id !== principal.invocationId) {
    return gatewaySchemaInvalidTable(
      requestId,
      "请求体必须包含与 Gateway Token 匹配的 invocation_id、producer_sequence_start 与 events",
    );
  }
  try {
    const result = await ingressEventBatch({
      tenantId: principal.tenantId,
      invocationId: principal.invocationId,
      producerSequenceStart: body.producer_sequence_start,
      events: body.events,
      correlationId: requestId,
    });
    return apiSuccess(gatewayRuntimeEventsResponseBody(principal, result), {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (error) {
    const response = await ingressErrorToResponse(error, requestId);
    if (response) return response;
    throw error;
  }
}
