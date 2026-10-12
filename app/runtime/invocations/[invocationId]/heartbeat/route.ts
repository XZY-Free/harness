import { IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import { handleRuntimeHeartbeat } from "@/lib/runtime/application/runtime-heartbeat";
import {
  type WorkloadTokenClaims,
  ingressErrorToResponse,
  resolveRuntimePrincipal,
  runtimeAuthErrorResponse,
  runtimeSchemaInvalidTable,
} from "@/lib/runtime/route-helpers";

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
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object")
    return runtimeSchemaInvalidTable(requestId, "Heartbeat 请求体非法");
  const authority = (body as { authority?: unknown }).authority as
    | Record<string, unknown>
    | undefined;
  if (
    !authority ||
    authority.invocationId !== claims.invocationId ||
    authority.runtimeRevisionId !== claims.runtimeRevisionId ||
    authority.attemptId !== claims.attemptId ||
    authority.ownershipId !== claims.ownershipId ||
    authority.leaseEpoch !== claims.leaseEpoch ||
    authority.sessionBindingId !== claims.sessionBindingId
  )
    return runtimeSchemaInvalidTable(requestId, "Heartbeat Authority 与认证凭据不一致");
  try {
    const result = await handleRuntimeHeartbeat({
      tenantId: claims.tenantId,
      invocationId,
      request: body,
    });
    return apiSuccess(result, { headers: { [REQUEST_ID_HEADER]: requestId } });
  } catch (error) {
    const response = await ingressErrorToResponse(error, requestId);
    if (response) return response;
    return runtimeSchemaInvalidTable(
      requestId,
      error instanceof Error ? error.message : "Heartbeat rejected",
    );
  }
}
