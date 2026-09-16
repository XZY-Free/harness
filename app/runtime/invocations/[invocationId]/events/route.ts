import { IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import {
  type WorkloadTokenClaims,
  ingressErrorToResponse,
  resolveRuntimePrincipal,
  runtimeAuthErrorResponse,
  runtimeSchemaInvalidTable,
} from "@/lib/runtime/route-helpers";
import { RuntimeEventBatchSchema } from "@/lib/runtime/runtime-protocol";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ invocationId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { invocationId } = await context.params;
  if (!invocationId) return runtimeSchemaInvalidTable(requestId, "路径参数 invocationId 缺失");

  let claims: WorkloadTokenClaims;
  try {
    claims = await resolveRuntimePrincipal(request.headers, invocationId);
  } catch (error) {
    return runtimeAuthErrorResponse(error, requestId) ?? Promise.reject(error);
  }
  if (!request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim()) {
    return runtimeSchemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }
  const body = await request.json().catch(() => null);
  const parsed = RuntimeEventBatchSchema.safeParse(body);
  if (!parsed.success)
    return runtimeSchemaInvalidTable(requestId, "Runtime Event batch 不符合 protocol 3");
  const authority = parsed.data.authority;
  if (
    authority.invocationId !== claims.invocationId ||
    authority.runtimeRevisionId !== claims.runtimeRevisionId ||
    authority.attemptId !== claims.attemptId ||
    authority.ownershipId !== claims.ownershipId ||
    authority.leaseEpoch !== claims.leaseEpoch ||
    authority.sessionBindingId !== claims.sessionBindingId
  )
    return runtimeSchemaInvalidTable(requestId, "请求 Authority 与认证凭据不一致");
  try {
    const result = await ingressRuntimeEvents({
      tenantId: claims.tenantId,
      invocationId,
      batch: parsed.data,
    });
    return apiSuccess(result, { headers: { [REQUEST_ID_HEADER]: requestId } });
  } catch (error) {
    const response = await ingressErrorToResponse(error, requestId);
    if (response) return response;
    throw error;
  }
}
