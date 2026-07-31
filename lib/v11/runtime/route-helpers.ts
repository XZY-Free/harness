/**
 * V11 Runtime API route handler 公共助手（S05-C03）。
 *
 * 事实源：../v11-agentkit-platform/11-api-and-event-boundaries.md §4（Runtime Protocol API）、
 *         §2.2（身份与授权：Runtime API 走 Workload Token，audience=runtime）、
 *         §2.3（公共请求头：Idempotency-Key / X-Request-ID）、
 *         §2.5（成功与错误格式）。
 *
 * 职责：
 * - resolveRuntimePrincipal：解析 Workload Token（audience=runtime + invocation 绑定校验）。
 * - runtimeAuthErrorResponse：把 WorkloadTokenError 转成 401 响应。
 * - ingressErrorToResponse：把 Runtime 域 Error 实例 → HTTP 响应映射。
 *
 * 安全边界：
 * - Runtime API 走 Workload Token（type=runtime），绑定 tenant/invocation/runtime_revision。
 * - Token 的 invocationId 必须等于 path 的 invocation_id（assertInvocationMatch）。
 * - 跨租户隔离由仓储层保证（tenantId 来自 Token claims，不信任请求体）。
 */
import { v11Error, v11NotFound } from "@/lib/http";
import {
  type WorkloadTokenClaims,
  WorkloadTokenError,
  assertAudienceMatch,
  assertInvocationMatch,
  decodeWorkloadToken,
  extractBearerToken,
  workloadTokenErrorResponse,
} from "@/lib/v11/identity/workload-token";
import { isTokenRevoked } from "@/lib/v11/identity/workload-token-revocation-queries";
import {
  EventPayloadHashConflictError,
  IngressInvocationNotFoundError,
  IngressInvocationTerminalError,
} from "@/lib/v11/runtime/errors";
import {
  IngressBatchEmptyError,
  IngressCandidateTypeUnsupportedError,
  IngressSequenceStartMismatchError,
} from "@/lib/v11/runtime/event-ingress-queries";

// ─── 类型再导出（route handlers 统一从此处 import） ────────
export type { WorkloadTokenClaims };

/**
 * 解析 Runtime 身份（audience=runtime + invocation 绑定校验 + jti 撤销校验）。
 *
 * 流程：
 * 1. 提取 Bearer Token；缺失 → WorkloadTokenError(missing_token)。
 * 2. 解码 Token claims；格式/过期错误 → WorkloadTokenError。
 * 3. 校验 audience=runtime。
 * 4. 校验 Token 的 invocationId === path 的 invocationId。
 * 5. S12-W05：校验 jti 未被撤销；命中 → WorkloadTokenError(token_revoked)。
 *
 * @throws WorkloadTokenError 缺少/非法/过期 Token、audience 不匹配、invocation 不匹配、token 已撤销
 */
export async function resolveRuntimePrincipal(
  headers: Headers,
  invocationId: string,
): Promise<WorkloadTokenClaims> {
  const token = extractBearerToken(headers);
  if (!token) {
    throw new WorkloadTokenError("missing_token", "缺少 Authorization Bearer Token");
  }
  const claims = decodeWorkloadToken(token);
  assertAudienceMatch(claims, "runtime");
  assertInvocationMatch(claims, invocationId);
  // S12-W05：撤销校验（DB 查询）
  if (await isTokenRevoked(claims.tenantId, claims.jti)) {
    throw new WorkloadTokenError("token_revoked", `Workload Token 已被撤销（jti=${claims.jti}）`);
  }
  return claims;
}

/**
 * 把 WorkloadTokenError 转成 401 响应；非身份错误返回 null。
 */
export function runtimeAuthErrorResponse(error: unknown, requestId: string): Response | null {
  return workloadTokenErrorResponse(error, requestId);
}

/** 构造 400 REQUEST_SCHEMA_INVALID 响应。 */
export function v11RuntimeSchemaInvalid(requestId: string, message: string): Response {
  return v11Error("REQUEST_SCHEMA_INVALID", message, { requestId });
}

/**
 * 把 Runtime Ingress 域 Error 实例映射为 HTTP 响应。
 *
 * 映射规则：
 * - IngressInvocationNotFoundError → 404 RESOURCE_NOT_FOUND（隐藏式，不泄露存在）
 * - IngressInvocationTerminalError → 422 BUSINESS_CONSTRAINT_VIOLATION（终态不接受新事件）
 * - IngressBatchEmptyError → 400 REQUEST_SCHEMA_INVALID
 * - IngressSequenceStartMismatchError → 400 REQUEST_SCHEMA_INVALID
 * - IngressCandidateTypeUnsupportedError → 422 EVENT_SCHEMA_UNSUPPORTED
 * - EventPayloadHashConflictError → 409 IDEMPOTENCY_CONFLICT（不可修复，原子终止）
 * - EventSequenceGapError → 409 EVENT_SEQUENCE_GAP（retryable）
 * - TransientSequenceGapError → 409 EVENT_SEQUENCE_GAP（retryable）
 *
 * 非 Error 实例返回 null（调用方应向上抛或自行构造响应）。
 */
export async function ingressErrorToResponse(
  error: unknown,
  requestId: string,
): Promise<Response | null> {
  if (error instanceof IngressInvocationNotFoundError) {
    return v11NotFound(requestId, `Invocation 不存在或不可见: ${error.invocationId}`);
  }
  if (error instanceof IngressInvocationTerminalError) {
    return v11Error("BUSINESS_CONSTRAINT_VIOLATION", error.message, {
      requestId,
      details: { invocation_id: error.invocationId, current_state: error.currentState },
    });
  }
  if (error instanceof IngressBatchEmptyError) {
    return v11Error("REQUEST_SCHEMA_INVALID", error.message, {
      requestId,
      details: { invocation_id: error.invocationId },
    });
  }
  if (error instanceof IngressSequenceStartMismatchError) {
    return v11Error("REQUEST_SCHEMA_INVALID", error.message, {
      requestId,
      details: {
        invocation_id: error.invocationId,
        declared_start: error.declaredStart,
        first_event_sequence: error.firstEventSequence,
      },
    });
  }
  if (error instanceof IngressCandidateTypeUnsupportedError) {
    return v11Error("EVENT_SCHEMA_UNSUPPORTED", error.message, {
      requestId,
      details: {
        invocation_id: error.invocationId,
        candidate_type: error.candidateType,
      },
    });
  }
  if (error instanceof EventPayloadHashConflictError) {
    return v11Error("IDEMPOTENCY_CONFLICT", error.message, {
      requestId,
      details: {
        invocation_id: error.invocationId,
        producer_event_id: error.producerEventId,
        producer_sequence: error.producerSequence,
        expected_hash: error.expectedHash,
        actual_hash: error.actualHash,
      },
    });
  }
  // EventSequenceGapError 来自 conversation 域；按其 name 识别
  if (error instanceof Error && error.name === "EventSequenceGapError") {
    return v11Error("EVENT_SEQUENCE_GAP", error.message, { requestId });
  }
  // TransientSequenceGapError 来自 transient 域
  if (error instanceof Error && error.name === "TransientSequenceGapError") {
    return v11Error("EVENT_SEQUENCE_GAP", error.message, { requestId });
  }
  return null;
}
