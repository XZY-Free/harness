import {
  type Principal,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
/**
 * POST /api/v1/turns/{turn_id}/steer — Steer Turn（S04-C06，§3.7）。
 *
 * 事实源：../v11-agentkit-platform/11-api-and-event-boundaries.md §3.7、
 *         ../v11-agentkit-platform/02-agent-thread-and-runtime.md §3.7（Steer）。
 *
 * 行为：
 * - 解析员工身份 + 校验 Turn 属于当前员工（非 owner → 404 隐藏式）。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（guidance_text 必填，非空字符串）。
 * - 调用 queueSteer 事务内创建 user_guidance Item + 入队 Steer 命令 + 写事件。
 * - completeRecord + 返回 202 + Steer 结果（异步命令，Turn 状态未变）。
 *
 * 错误映射：
 * - Turn 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - Turn 状态为 waiting_user → 409 TURN_REQUIRES_USER_ACTION（必须解析 UserActionRequest）
 * - Turn 非 running 状态 → 409 TURN_ALREADY_TERMINAL
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 */
import { queueSteer } from "@/lib/conversations/steer-queries";
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

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ turn_id: string }>;
}

/** 请求体 schema（§3.7 requestBody）。 */
interface SteerBody {
  guidance_text: string;
}

function validateBody(body: unknown): body is SteerBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.guidance_text !== "string" || b.guidance_text.length === 0) return false;
  return true;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { turn_id: turnId } = await context.params;

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
    return schemaInvalidTable(requestId, "请求体非法：缺少 guidance_text 或字段类型错误");
  }

  // 5. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromPrincipal(principal);
  const commandScope = `turn.steer:${turnId}`;

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

  // 7. 执行业务：queueSteer 事务内创建 user_guidance Item + 入队 Steer 命令
  try {
    const result = await queueSteer({
      tenantId: principal.tenantId,
      ownerUserId: principal.userIdentityId,
      turnId,
      guidanceText: body.guidance_text,
      idempotencyKey,
      correlationId: requestId,
    });

    const responseBody = {
      turn_id: result.turnId,
      turn_state: result.turnState,
      steer_state: result.steerState,
      guidance_item_id: result.guidanceItemId,
      command: {
        id: result.command.id,
        command_state: result.command.commandState,
      },
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
