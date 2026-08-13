/**
 * POST /runtime/v1/invocations/{invocation_id}:steer — Hosted Runtime 引导（steer）Invocation（S05-C04 + S05-C05 参考实现）。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md §4（Runtime Protocol API）
 * - docs/architecture/agent-control-plane.md §3.7（Steer）
 * - docs/architecture/runtime-control-plane.md S05-C04/S05-C05
 *
 * 行为：
 * - 解析 Bearer Token（Workload Token，audience=runtime + invocation 绑定校验）。
 * - 校验 Idempotency-Key（必填）。
 * - 校验请求体（steer_payload 必填）。
 * - S05-C05 扩展：调用 RuntimeAdapter.handleSteer，返回 steer ack。
 * - 返回 steered=true（Runtime ack，平台标记命令 acknowledged + 写 turn.steered Event）。
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
  SteerInvocationRequestBody,
  SteerInvocationResponse,
} from "@/lib/runtime/runtime-client";

export const dynamic = "force-dynamic";

/**
 * 路径参数上下文（Next.js App Router 动态段，含冒号 custom method 段）。
 *
 * Next.js 类型验证器可能不识别 `:steer` 为标准静态段，
 * 故使用 Record 宽类型；运行时 params key 为 "invocation_id"。
 */
interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/** 校验请求体结构。 */
function validateBody(body: unknown): body is SteerInvocationRequestBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.steer_payload === undefined || b.steer_payload === null) return false;
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
    return runtimeSchemaInvalidTable(requestId, "请求体非法：steer_payload 必填");
  }

  // 4. S05-C05 扩展：调用 RuntimeAdapter.handleSteer，返回 steer ack
  //
  // adapter.handleSteer 返回 steer_state="accepted" + applies_at="next_safe_point" +
  // generation_interrupted=false。路由层把 adapter 响应翻译为 SteerInvocationResponse
  // （保持外部 API 契约不变）。
  const authToken = extractBearerToken(request.headers) ?? undefined;
  const adapter = getRouteHostedAdapter();
  if (!adapter) {
    return apiError("RUNTIME_UNAVAILABLE", "Hosted Runtime 尚未配置模型执行器", { requestId });
  }
  await adapter.handleSteer({
    invocationId,
    steerPayload: body.steer_payload,
    authToken,
  });

  // 5. 返回 steered=true（Runtime ack）
  const response: SteerInvocationResponse = {
    invocation_id: invocationId,
    steered: true,
    attempt_no: 1,
  };

  return apiSuccess(response, {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
