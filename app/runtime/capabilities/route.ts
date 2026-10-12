import { REQUEST_ID_HEADER, apiError, apiSuccess, getRequestId } from "@/lib/http";
import {
  assertAudienceMatch,
  decodeWorkloadToken,
  extractBearerToken,
  workloadTokenErrorResponse,
} from "@/lib/identity/workload-token";
import { RUNTIME_PROTOCOL_VERSION, defaultRuntimeCapabilities } from "@/lib/runtime/runtime-client";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  const token = extractBearerToken(request.headers);
  if (!token)
    return apiError("AUTHENTICATION_REQUIRED", "缺少 Authorization Bearer Token", { requestId });
  try {
    const claims = decodeWorkloadToken(token);
    assertAudienceMatch(claims, "runtime");
  } catch (error) {
    const response = workloadTokenErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }
  const version = new URL(request.url).searchParams.get("protocolVersion");
  if (version && version !== String(RUNTIME_PROTOCOL_VERSION)) {
    return apiError("REQUEST_SCHEMA_INVALID", `不支持的 protocolVersion: ${version}`, {
      requestId,
    });
  }
  return apiSuccess(defaultRuntimeCapabilities(), { headers: { [REQUEST_ID_HEADER]: requestId } });
}
