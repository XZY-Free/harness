/**
 * Gateway API route handler 公共助手（阶段 6 S06-C04）。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md §3（Gateway API）、
 * （身份与授权：Gateway API 走 Workload Token，audience=gateway）、
 * （公共请求头：Idempotency-Key / X-Request-ID）、
 * （成功与错误格式）。
 * - docs/architecture/capability-and-collaboration-api.md §3（Runtime Capability API）。
 *
 * 职责：
 * - resolveGatewayPrincipal：解析 Workload Token（audience=gateway）。
 * - gatewayAuthErrorResponse：把 WorkloadTokenError / AuthenticationError 转成 401 响应。
 * - gatewaySchemaInvalidTable：构造 400 REQUEST_SCHEMA_INVALID 响应。
 * - gatewayCapabilityNotAllowedTable：构造 404 CAPABILITY_NOT_ALLOWED 响应（隐藏式，跨租户统一返回）。
 * - gatewayCapabilityContentBlockedTable：构造 422 CAPABILITY_CONTENT_BLOCKED 响应。
 * - gatewayToolSchemaChangedTable：构造 409 TOOL_SCHEMA_CHANGED 响应（retryable）。
 * - gatewayCatalogRevisionInvalidTable：构造 400 CATALOG_REVISION_INVALID 响应。
 *
 * 安全边界：
 * - Gateway API 走 Workload Token（type=gateway），绑定 tenant + invocation。
 * - Token 的 invocationId 是 Invocation 唯一来源（route handler 不读 body 里的 invocation_id）。
 * - 跨租户隔离由仓储层保证（tenantId 来自 Token claims，不信任请求体）。
 */
import { apiError } from "@/lib/http";
import { AuthenticationError } from "@/lib/identity/resolver";
import {
  type WorkloadTokenClaims,
  WorkloadTokenError,
  assertAudienceMatch,
  decodeWorkloadToken,
  extractBearerToken,
  workloadTokenErrorResponse,
} from "@/lib/identity/workload-token";
import { isTokenRevoked } from "@/lib/identity/workload-token-revocation-queries";

// ─── 类型再导出（route handlers 统一从此处 import） ────────
export type { WorkloadTokenClaims };

/**
 * Gateway 身份主体：在 WorkloadTokenClaims 基础上把 invocationId 收窄为必填字符串。
 *
 * decodeWorkloadToken 已强制要求 type=gateway 必须携带 invocationId；
 * 此类型供 route handler 直接读取，避免在调用处使用 non-null assertion。
 */
export type GatewayPrincipal = Omit<WorkloadTokenClaims, "invocationId"> & {
  invocationId: string;
};

/**
 * 解析 Gateway 身份（audience=gateway + jti 撤销校验）。
 *
 * 流程：
 * 1. 提取 Bearer Token；缺失 → WorkloadTokenError(missing_token)。
 * 2. 解码 Token claims；格式/过期错误 → WorkloadTokenError。
 * 3. 校验 audience=gateway。
 * 4. S12-W05：校验 jti 未被撤销；命中 → WorkloadTokenError(token_revoked)。
 *
 * Gateway Token 的 invocationId 由 decodeWorkloadToken 强制要求（type=gateway 必须有 invocationId）；
 * 此处再做一次类型守卫，把 invocationId 收窄为必填字符串返回。
 * Route handler 直接从 claims.invocationId 读取，不信任请求体。
 *
 * @throws WorkloadTokenError 缺少/非法/过期 Token、audience 不匹配、token 已撤销
 * @throws AuthenticationError 缺少 Token（包装为 missing_identity）
 */
export async function resolveGatewayPrincipal(headers: Headers): Promise<GatewayPrincipal> {
  const token = extractBearerToken(headers);
  if (!token) {
    throw new WorkloadTokenError("missing_token", "缺少 Authorization Bearer Token");
  }
  const claims = decodeWorkloadToken(token);
  assertAudienceMatch(claims, "gateway");
  if (!claims.invocationId) {
    // decodeWorkloadToken 已强制要求 type=gateway 必须有 invocationId；此处只是类型守卫。
    throw new WorkloadTokenError("malformed_token", "Gateway Token 缺失 invocationId");
  }
  // S12-W05：撤销校验（DB 查询）
  if (await isTokenRevoked(claims.tenantId, claims.jti)) {
    throw new WorkloadTokenError("token_revoked", `Workload Token 已被撤销（jti=${claims.jti}）`);
  }
  return { ...claims, invocationId: claims.invocationId };
}

/**
 * 把 WorkloadTokenError / AuthenticationError 转成 401 响应；非身份错误返回 null。
 */
export function gatewayAuthErrorResponse(error: unknown, requestId: string): Response | null {
  if (error instanceof AuthenticationError) {
    return apiError("AUTHENTICATION_REQUIRED", error.message, { requestId });
  }
  return workloadTokenErrorResponse(error, requestId);
}

/** 构造 400 REQUEST_SCHEMA_INVALID 响应（请求体校验失败）。 */
export function gatewaySchemaInvalidTable(requestId: string, message: string): Response {
  return apiError("REQUEST_SCHEMA_INVALID", message, { requestId });
}

/**
 * 构造 404 CAPABILITY_NOT_ALLOWED 响应（隐藏式跨租户隔离）。
 *
 * 资源不存在 / 跨租户不可见 / lifecycle 不允许 Gateway 读取，统一返回此错误，
 * 不暴露「存在但无权」与「不存在」的区别。
 */
export function gatewayCapabilityNotAllowedTable(requestId: string, message: string): Response {
  return apiError("CAPABILITY_NOT_ALLOWED", message, { requestId });
}

/** 构造 422 CAPABILITY_CONTENT_BLOCKED 响应（Skill 内容不可读，如未发布版本）。 */
export function gatewayCapabilityContentBlockedTable(requestId: string, message: string): Response {
  return apiError("CAPABILITY_CONTENT_BLOCKED", message, { requestId });
}

/**
 * 构造 409 TOOL_SCHEMA_CHANGED 响应（caller 期望的 schema_revision_id 不再是 current）。
 *
 * retryable=true：客户端应重新搜索目录 + 读取最新 currentSchemaRevisionId 后重试。
 */
export function gatewayToolSchemaChangedTable(
  requestId: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return apiError("TOOL_SCHEMA_CHANGED", message, { requestId, ...(details ? { details } : {}) });
}

/** 构造 400 CATALOG_REVISION_INVALID 响应（If-None-Match ETag 格式非法）。 */
export function gatewayCatalogRevisionInvalidTable(requestId: string, message: string): Response {
  return apiError("CATALOG_REVISION_INVALID", message, { requestId });
}
