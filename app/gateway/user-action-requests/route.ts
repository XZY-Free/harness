import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  gatewaySchemaInvalidTable,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";
import { IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { RuntimeEventBatchSchema } from "@/lib/runtime/runtime-protocol";

export const dynamic = "force-dynamic";

/** Gateway token authenticates the callback; the persisted Authority tuple still fences ingress. */
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
  if (!request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim())
    return gatewaySchemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  const parsed = RuntimeEventBatchSchema.safeParse(await request.json().catch(() => null));
  if (
    !parsed.success ||
    parsed.data.authority.invocationId !== principal.invocationId ||
    parsed.data.events.length !== 1 ||
    parsed.data.events[0]?.type !== "user-action"
  )
    return gatewaySchemaInvalidTable(
      requestId,
      "请求体必须是匹配 Authority 的单个 user-action 事件",
    );
  if (
    parsed.data.authority.runtimeRevisionId !== principal.runtimeRevisionId ||
    parsed.data.authority.attemptId !== principal.attemptId ||
    parsed.data.authority.ownershipId !== principal.ownershipId ||
    parsed.data.authority.leaseEpoch !== principal.leaseEpoch ||
    parsed.data.authority.sessionBindingId !== principal.sessionBindingId
  )
    return gatewaySchemaInvalidTable(requestId, "Authority 与 Gateway Token 不一致");
  const result = await ingressRuntimeEvents({
    tenantId: principal.tenantId,
    invocationId: principal.invocationId,
    batch: parsed.data,
  });
  return apiSuccess(result, { status: 200, headers: { [REQUEST_ID_HEADER]: requestId } });
}
