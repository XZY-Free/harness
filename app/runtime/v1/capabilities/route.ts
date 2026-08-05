/**
 * GET /runtime/v1/capabilities — Hosted Runtime 能力探测（S05-C02 参考实现）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §4（Runtime Protocol API）
 * - ../v11-agentkit-platform-development-plan/05-runtime-dispatch-and-attempt.md S05-C02
 *
 * 行为：
 * - 解析 Bearer Token（Workload Token，audience=runtime）。
 * - 校验 protocol_version 查询参数（当前支持 "1"）。
 * - 返回 Hosted Runtime 能力声明（defaultRuntimeCapabilities）。
 *
 * 错误映射：
 * - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 * - protocol_version 不支持 → 400 REQUEST_SCHEMA_INVALID
 */
import { REQUEST_ID_HEADER, apiError, apiSuccess, getRequestId } from "@/lib/http";
import {
  assertAudienceMatch,
  decodeWorkloadToken,
  extractBearerToken,
  workloadTokenErrorResponse,
} from "@/lib/identity/workload-token";
import {
  type RuntimeCapabilitiesResponse,
  defaultRuntimeCapabilities,
} from "@/lib/runtime/runtime-client";

export const dynamic = "force-dynamic";

/** 支持的协议版本。 */
const SUPPORTED_PROTOCOL_VERSIONS = ["1"];

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析 Bearer Token
  const token = extractBearerToken(request.headers);
  if (!token) {
    return apiError("AUTHENTICATION_REQUIRED", "缺少 Authorization Bearer Token", { requestId });
  }

  try {
    const claims = decodeWorkloadToken(token);
    // 仅允许 runtime audience 探测能力
    assertAudienceMatch(claims, "runtime");
  } catch (err) {
    const resp = workloadTokenErrorResponse(err, requestId);
    if (resp) return resp;
    throw err;
  }

  // 2. 校验 protocol_version 查询参数
  const url = new URL(request.url);
  const protocolVersion = url.searchParams.get("protocol_version");
  if (protocolVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return apiError(
      "REQUEST_SCHEMA_INVALID",
      `不支持的 protocol_version: ${protocolVersion}（当前支持 ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}）`,
      { requestId },
    );
  }

  // 3. 返回能力声明
  const capabilities: RuntimeCapabilitiesResponse = defaultRuntimeCapabilities();
  return apiSuccess(capabilities, {
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
