/**
 * POST /api/v1/turns/{turn_id}/regenerate — Regenerate Turn（§3.9）。
 *
 * 事实源：docs/architecture/api-and-events.md §3.9、
 *         docs/architecture/agent-control-plane.md §3.9（Regenerate）。
 *
 * 行为：
 * - 解析员工身份 + 校验 Turn 属于当前员工（非 owner → 404 隐藏式）。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（binding_mode 可选，默认 loose；reason 可选）。
 * - 调用 startRegeneration 事务内创建 InvocationCommand + 更新 Turn 状态 + 写事件。
 * - completeRecord + 返回 202 + Regenerate 结果（异步命令，Turn 已进入 regenerating）。
 *
 * 错误映射：
 * - Turn 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - Turn 状态不允许 Regenerate（cancelled/非终态）→ 409 TURN_ALREADY_TERMINAL
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 */
import {
  type RegenerateBindingMode,
  startRegeneration,
} from "@/lib/conversations/regenerate-queries";
import {
  type Principal,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { getTurnById } from "@/lib/conversations/turn-queries";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiSuccess,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
import {
  buildIdempotencyErrorResponse,
  buildReplayResponse,
  callerFromPrincipal,
  completeRecord,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/identity/idempotency";

export const dynamic = "force-dynamic";

/**
 * 路径参数上下文（Next.js App Router 原生动态段）。
 * 命令作为资源子路径（`/{id}/command`），动态参数直接从 params 解构。
 */
interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/** 请求体 schema（§3.9 requestBody）。 */
interface RegenerateBody {
  binding_mode?: RegenerateBindingMode;
  reason?: string;
}

function validateBody(body: unknown): body is RegenerateBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.binding_mode !== undefined && b.binding_mode !== "loose" && b.binding_mode !== "strict") {
    return false;
  }
  if (b.reason !== undefined && typeof b.reason !== "string") return false;
  return true;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const params = await context.params;
  const turnId = typeof params.turn_id === "string" ? params.turn_id : "";

  // 1. 解析员工身份
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Turn 属于当前员工（非 owner → 404 隐藏式）
  const turn = await getTurnById(principal.tenantId, turnId);
  if (!turn) {
    return resourceNotFound(requestId, `Turn 不存在或无权访问: ${turnId}`);
  }
  const thread = await getThreadById(principal.tenantId, turn.threadId);
  if (!thread || thread.ownerUserId !== principal.userIdentityId) {
    return resourceNotFound(requestId, `Turn 不存在或无权访问: ${turnId}`);
  }

  // 3. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(
      requestId,
      "请求体非法：binding_mode 必须为 loose|strict，reason 必须为字符串",
    );
  }

  // 5. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromPrincipal(principal);
  const commandScope = `turn.regenerate:${turnId}`;

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  // 6. 处理幂等结果
  if (outcome.kind === "replay") {
    return buildReplayResponse(outcome.record, requestId);
  }
  if (outcome.kind === "in_flight" || outcome.kind === "conflict") {
    return buildIdempotencyErrorResponse({
      record: outcome.kind === "conflict" ? outcome.existingRecord : outcome.record,
      reason: outcome.kind === "conflict" ? "conflict" : "in_flight",
      requestId,
    });
  }

  let recordId = outcome.record.id;
  if (outcome.kind === "retry_allowed") {
    const reset = await prepareRetryForFailedRecord({
      record: outcome.record,
      requestHash,
    });
    if (!reset) {
      return buildIdempotencyErrorResponse({
        record: outcome.record,
        reason: "conflict",
        requestId,
      });
    }
    recordId = reset.id;
  }

  // 7. 执行业务：startRegeneration 事务内启动 Regenerate
  try {
    const result = await startRegeneration({
      tenantId: principal.tenantId,
      ownerUserId: principal.userIdentityId,
      turnId,
      bindingMode: body.binding_mode ?? "loose",
      reason: body.reason ?? null,
      idempotencyKey,
      correlationId: requestId,
    });

    const responseBody = {
      turn_id: result.turnId,
      turn_state: result.turnState,
      invocation_id: result.invocationId,
      invocation_kind: result.invocationKind,
      replaces_invocation_id: result.replacesInvocationId,
      original_user_item_id: result.originalUserItemId,
      current_final_item_id: result.currentFinalItemId,
      event_id: result.eventId,
    };

    await completeRecord({
      recordId,
      httpStatus: 202,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 202,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);
    const errorResp = conversationErrorToResponse(err, requestId);
    if (errorResp) return errorResp;
    throw err;
  }
}
