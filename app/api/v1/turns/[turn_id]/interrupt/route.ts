/**
 * POST /api/v1/turns/{turn_id}/interrupt — Interrupt Turn（S04-C06，§3.8）。
 *
 * 事实源：docs/architecture/api-and-events.md §3.8、
 *         docs/architecture/agent-control-plane.md §3.8（Stop/Interrupt）。
 *
 * 行为：
 * - 解析员工身份 + 校验 Turn 属于当前员工（非 owner → 404 隐藏式）。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（reason_code 必填；preserve_pending_inputs 可选，默认 true）。
 * - 调用 requestInterrupt 事务内入队 Interrupt 命令 + 写事件（不立即改变 Turn 状态）。
 * - completeRecord + 返回 202 + Interrupt 结果（异步命令，Turn 状态未变）。
 *
 * 错误映射：
 * - Turn 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - Turn 已终态 → 409 TURN_ALREADY_TERMINAL
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 */
import { requestInterrupt } from "@/lib/conversations/interrupt-queries";
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
import { logger } from "@/lib/logger";
import { dispatchInterruptCommandToRuntime } from "@/lib/runtime/command-dispatch-gateway";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ turn_id: string }>;
}

/** 请求体 schema（§3.8 requestBody）。 */
interface InterruptBody {
  reason_code: string;
  preserve_pending_inputs?: boolean;
}

function validateBody(body: unknown): body is InterruptBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.reason_code !== "string" || b.reason_code.length === 0) return false;
  if (b.preserve_pending_inputs !== undefined && typeof b.preserve_pending_inputs !== "boolean") {
    return false;
  }
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
    return schemaInvalidTable(requestId, "请求体非法：缺少 reason_code 或字段类型错误");
  }

  // 5. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromPrincipal(principal);
  const commandScope = `turn.interrupt:${turnId}`;

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

  // 7. 执行业务：requestInterrupt 事务内入队 Interrupt 命令
  try {
    const result = await requestInterrupt({
      tenantId: principal.tenantId,
      ownerUserId: principal.userIdentityId,
      turnId,
      reasonCode: body.reason_code,
      preservePendingInputs: body.preserve_pending_inputs ?? true,
      idempotencyKey,
      correlationId: requestId,
    });

    // 08 §6：A2A 协议下真实调用远端 tasks/cancel（hosted 协议由既有状态机吸收）。
    // 网关幂等：命令已终态/非远端协议时跳过，不影响本响应。
    await dispatchInterruptCommandToRuntime({
      tenantId: principal.tenantId,
      commandId: result.command.id,
      actorId: principal.userIdentityId,
      correlationId: requestId,
    }).catch((err) => {
      logger.warn("Interrupt 命令远端调度失败（保持命令状态机重试）", {
        commandId: result.command.id,
        error: String(err),
      });
    });

    const responseBody = {
      turn_id: result.turnId,
      turn_state: result.turnState,
      interrupt_state: result.interruptState,
      command: {
        id: result.command.id,
        command_state: result.command.commandState,
      },
      already_completed_effects_preserved: result.alreadyCompletedEffectsPreserved,
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
