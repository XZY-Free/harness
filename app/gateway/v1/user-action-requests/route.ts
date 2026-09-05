/**
 * POST /gateway/v1/user-action-requests — External Runtime 用户行动回调。
 *
 * 请求沿用 runtime-events 的事件 envelope，但只允许一个
 * `user_action.requested` 候选事件；Authority/Projection 仍由唯一
 * ingressEventBatch 映射，避免出现第二套 UserActionRequest 写入路径。
 */
import {
  gatewayRuntimeEventsResponseBody,
  parseGatewayRuntimeEventsBody,
} from "@/app/gateway/v1/runtime-events/route";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  gatewaySchemaInvalidTable,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";
import { IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { ingressErrorToResponse } from "@/lib/runtime/route-helpers";

export const dynamic = "force-dynamic";

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
  if (
    !body ||
    body.invocation_id !== principal.invocationId ||
    body.events.length !== 1 ||
    body.events[0]?.type !== "user_action.requested"
  ) {
    return gatewaySchemaInvalidTable(
      requestId,
      "请求体必须是与 Gateway Token 匹配的单个 user_action.requested 事件",
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
