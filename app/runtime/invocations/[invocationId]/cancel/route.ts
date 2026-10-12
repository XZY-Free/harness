import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
} from "@/lib/http";
import {
  type WorkloadTokenClaims,
  resolveRuntimePrincipal,
  runtimeAuthErrorResponse,
  runtimeSchemaInvalidTable,
} from "@/lib/runtime/route-helpers";
import {
  CancelRequestSchema,
  type CancelResponse,
  CancelResponseSchema,
} from "@/lib/runtime/runtime-protocol";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ invocationId: string }> };

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
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) return runtimeSchemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  const parsed = CancelRequestSchema.safeParse(await request.json().catch(() => null));
  if (
    !parsed.success ||
    parsed.data.targetAuthority.invocationId !== claims.invocationId ||
    parsed.data.targetAuthority.ownershipId !== claims.ownershipId ||
    parsed.data.targetAuthority.leaseEpoch !== claims.leaseEpoch
  )
    return runtimeSchemaInvalidTable(requestId, "CancelRequest 或 Authority 非法");
  const response: CancelResponse = {
    accepted: true,
    targetAuthority: parsed.data.targetAuthority,
    stopState: "requested",
  };
  CancelResponseSchema.parse(response);
  return apiSuccess(response, { status: 202, headers: { [REQUEST_ID_HEADER]: requestId } });
}
