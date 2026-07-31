/**
 * POST /runtime/v1/invocations/{invocation_id}/transient-events:batch — Runtime 回传 transient 事件批次（S05-C03）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §4（Runtime Protocol API：transient 通道）
 * - ../v11-agentkit-platform/10-core-data-model.md §6.9（RuntimeEventIngress L486-500）
 * - ../v11-agentkit-platform-development-plan/05-runtime-dispatch-and-attempt.md S05-C03
 *
 * 行为：
 * - 解析 Bearer Token（Workload Token，audience=runtime + invocation 绑定校验）。
 * - 校验 Idempotency-Key（必填）。
 * - 校验请求体（transient_sequence_start + events 数组，每个事件含 transient_id/transient_sequence/type/payload）。
 * - 调用 ingressTransientBatch：不持久化，只记录日志 + 返回 accepted_through_transient_sequence。
 * - 返回 200 + accepted_through_transient_sequence + persisted=false。
 *
 * 错误映射：
 * - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - Invocation 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - Invocation 已终态 → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - transient_sequence 不连续 → 409 EVENT_SEQUENCE_GAP（retryable）
 */
import { IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER, getRequestId, v11Ok } from "@/lib/http";
import {
  type WorkloadTokenClaims,
  ingressErrorToResponse,
  resolveRuntimePrincipal,
  runtimeAuthErrorResponse,
  v11RuntimeSchemaInvalid,
} from "@/lib/v11/runtime/route-helpers";
import { ingressTransientBatch } from "@/lib/v11/runtime/transient-events";

export const dynamic = "force-dynamic";

/**
 * 路径参数上下文（Next.js App Router 动态段，含冒号 custom method 段）。
 *
 * Next.js 类型验证器可能不识别 `transient-events:batch` 为标准静态段，
 * 故使用 Record 宽类型；运行时 params key 为 "invocation_id"。
 */
interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/** 请求体 schema（§4 transient-events:batch requestBody）。 */
interface TransientBatchBody {
  /** 本批次起始 transient_sequence（必须等于 events[0].transient_sequence）。 */
  transient_sequence_start: number;
  /** Transient 事件列表（按 transient_sequence 升序）。 */
  events: Array<{
    transient_id: string;
    transient_sequence: number;
    type: string;
    payload: Record<string, unknown>;
  }>;
}

/** 校验请求体结构。 */
function validateBody(body: unknown): body is TransientBatchBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.transient_sequence_start !== "number" || b.transient_sequence_start < 1)
    return false;
  if (!Array.isArray(b.events) || b.events.length === 0) return false;
  for (const ev of b.events) {
    if (!ev || typeof ev !== "object") return false;
    const e = ev as Record<string, unknown>;
    if (typeof e.transient_id !== "string" || e.transient_id.length === 0) return false;
    if (typeof e.transient_sequence !== "number" || e.transient_sequence < 1) return false;
    if (typeof e.type !== "string" || e.type.length === 0) return false;
    if (!e.payload || typeof e.payload !== "object") return false;
  }
  return true;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const params = await context.params;
  const rawValue = params.invocation_id;
  const invocationId = typeof rawValue === "string" ? rawValue : "";

  if (!invocationId) {
    return v11RuntimeSchemaInvalid(requestId, "路径参数 invocation_id 缺失");
  }

  // 1. 解析 Bearer Token（audience=runtime + invocation 绑定校验）
  let claims: WorkloadTokenClaims;
  try {
    claims = await resolveRuntimePrincipal(request.headers, invocationId);
  } catch (err) {
    const authResp = runtimeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Idempotency-Key（必填）
  if (!request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim()) {
    return v11RuntimeSchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  // 3. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return v11RuntimeSchemaInvalid(
      requestId,
      "请求体非法：transient_sequence_start 必填且≥1，events 必填且为非空数组，每个事件含 transient_id/transient_sequence/type/payload",
    );
  }

  // 4. 执行业务：不持久化，只记录日志
  try {
    const result = await ingressTransientBatch({
      tenantId: claims.tenantId,
      invocationId,
      transientSequenceStart: body.transient_sequence_start,
      events: body.events,
      correlationId: requestId,
    });

    const responseBody = {
      invocation_id: result.invocationId,
      accepted_through_transient_sequence: result.acceptedThroughTransientSequence,
      persisted: result.persisted,
    };

    return v11Ok(responseBody, {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    const errorResp = await ingressErrorToResponse(err, requestId);
    if (errorResp) return errorResp;
    throw err;
  }
}
