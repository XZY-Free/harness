import { IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import {
  type WorkloadTokenClaims,
  ingressErrorToResponse,
  resolveRuntimePrincipal,
  runtimeAuthErrorResponse,
  runtimeSchemaInvalidTable,
} from "@/lib/runtime/route-helpers";
import { ingressTransientBatch } from "@/lib/runtime/transient-events";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ invocationId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { invocationId } = await context.params;
  let claims: WorkloadTokenClaims;
  try {
    claims = await resolveRuntimePrincipal(request.headers, invocationId);
  } catch (error) {
    const response = runtimeAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }
  if (!request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim())
    return runtimeSchemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.transientSequenceStart !== "number" || !Array.isArray(body.events)) {
    return runtimeSchemaInvalidTable(requestId, "transientSequenceStart 和 events 必填");
  }
  try {
    const result = await ingressTransientBatch({
      tenantId: claims.tenantId,
      invocationId,
      // A11：transient 通道也必须带代际身份。Workload Token 已经冻结了本代际的完整
      // tuple（Start/Resume 时签发），直接用它作为 authority，不另造身份来源。
      authority: {
        invocationId,
        runtimeRevisionId: claims.runtimeRevisionId,
        attemptId: claims.attemptId,
        ownershipId: claims.ownershipId,
        leaseEpoch: String(claims.leaseEpoch),
        sessionBindingId: claims.sessionBindingId,
      },
      transientSequenceStart: body.transientSequenceStart,
      events: body.events as never,
      correlationId: requestId,
    });
    return apiSuccess(result, { headers: { [REQUEST_ID_HEADER]: requestId } });
  } catch (error) {
    const response = await ingressErrorToResponse(error, requestId);
    if (response) return response;
    throw error;
  }
}
