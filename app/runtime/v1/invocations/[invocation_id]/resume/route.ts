/**
 * POST /runtime/v1/invocations/{invocation_id}/resume — Hosted Runtime 恢复 waiting_user Invocation（ +  参考实现）。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md §4（Runtime Protocol API）
 * - docs/architecture/agent-control-plane.md §3.10（Resume）
 * - docs/architecture/runtime-control-plane.md
 *
 * 行为：
 * - 解析 Bearer Token（Workload Token，audience=runtime + invocation 绑定校验）。
 * - 校验 Idempotency-Key（必填）。
 * - 校验请求体（resume_payload 必填）。
 * -  扩展：调用 RuntimeAdapter.handleResume，返回 resume ack。
 * - 返回 resumed=true（Runtime ack，平台标记命令 acknowledged + Invocation waiting_user → running）。
 *
 * 错误映射：
 * - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 */
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
} from "@/lib/http";
import { extractBearerToken } from "@/lib/identity/workload-token";
import { getRouteHostedAdapter } from "@/lib/runtime/adapters/hosted-adapter";
import {
  resolveRuntimePrincipal,
  runtimeAuthErrorResponse,
  runtimeSchemaInvalidTable,
} from "@/lib/runtime/route-helpers";
import type {
  ResumeInvocationRequestBody,
  ResumeInvocationResponse,
} from "@/lib/runtime/runtime-client";

export const dynamic = "force-dynamic";

/**
 * 路径参数上下文（Next.js App Router 原生动态段）。
 * 命令作为资源子路径（`/{id}/command`），动态参数直接从 params 解构。
 */
interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/** 校验请求体结构。 */
function validateBody(body: unknown): body is ResumeInvocationRequestBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.resume_payload === undefined || b.resume_payload === null) return false;
  return true;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const params = await context.params;
  const rawValue = params.invocation_id;
  const invocationId = typeof rawValue === "string" ? rawValue : "";

  if (!invocationId) {
    return runtimeSchemaInvalidTable(requestId, "路径参数 invocation_id 缺失");
  }

  // 1. 解析 Bearer Token（audience=runtime + invocation 绑定校验）
  try {
    await resolveRuntimePrincipal(request.headers, invocationId);
  } catch (err) {
    const authResp = runtimeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Idempotency-Key（必填）
  if (!request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim()) {
    return runtimeSchemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 3. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return runtimeSchemaInvalidTable(requestId, "请求体非法：resume_payload 必填");
  }

  // 4.  扩展：调用 RuntimeAdapter.handleResume，返回 resume ack
  //
  // adapter.handleResume 返回 resume_state="accepted" + runtime_execution_ref + requires_redispatch。
  // 路由层把 adapter 响应翻译为 ResumeInvocationResponse（保持外部 API 契约不变）。
  const authToken = extractBearerToken(request.headers) ?? undefined;
  const adapter = getRouteHostedAdapter();
  if (!adapter) {
    return apiError("RUNTIME_UNAVAILABLE", "Hosted Runtime 尚未配置模型执行器", { requestId });
  }
  await adapter.handleResume({
    invocationId,
    resumePayload: body.resume_payload,
    authToken,
  });

  // 5. 返回 resumed=true（Runtime ack）
  const response: ResumeInvocationResponse = {
    invocation_id: invocationId,
    resumed: true,
    attempt_no: 1,
  };

  return apiSuccess(response, {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
