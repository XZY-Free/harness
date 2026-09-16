import { IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import {
  type WorkloadTokenClaims,
  resolveRuntimePrincipal,
  runtimeAuthErrorResponse,
  runtimeSchemaInvalidTable,
} from "@/lib/runtime/route-helpers";
import {
  SteerRequestSchema,
  type SteerResponse,
  SteerResponseSchema,
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
  if (!request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim())
    return runtimeSchemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  const parsed = SteerRequestSchema.safeParse(await request.json().catch(() => null));
  if (
    !parsed.success ||
    parsed.data.targetAuthority.invocationId !== claims.invocationId ||
    parsed.data.targetAuthority.ownershipId !== claims.ownershipId ||
    parsed.data.targetAuthority.leaseEpoch !== claims.leaseEpoch
  )
    return runtimeSchemaInvalidTable(requestId, "SteerRequest 或 Authority 非法");
  const response: SteerResponse = {
    accepted: true,
    commandId: parsed.data.commandId,
    targetAuthority: parsed.data.targetAuthority,
    inputDigest: parsed.data.inputDigest,
  };
  SteerResponseSchema.parse(response);
  return apiSuccess(response, { status: 202, headers: { [REQUEST_ID_HEADER]: requestId } });
}
