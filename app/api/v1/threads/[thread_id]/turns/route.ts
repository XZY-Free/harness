import {
  type Principal,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
/**
 * POST /api/v1/threads/{thread_id}/turns — 创建 Turn（S04-C03，§3.4）。
 *
 * 事实源：docs/architecture/api-and-events.md §3.4、
 *         docs/architecture/conversations.md S04-W02。
 *
 * 行为：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 校验 Idempotency-Key（必填，客户端消息重发幂等键）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（input 必填；selected_model/workspace_attachment_ids 可选）。
 * - 调用 acceptUserMessageTurn 原子接纳事务（同事务写 user_message Item + Turn + 2 Events）。
 * - completeRecord + 返回 201 + Turn + input_item + event_cursor。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - Thread archived/deleted → 409 BUSINESS_CONSTRAINT_VIOLATION
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 */
import { acceptUserMessageTurn } from "@/lib/conversations/turn-queries";
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
import { dispatchEmployeeTurn } from "@/lib/runtime/employee-turn-dispatcher";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ thread_id: string }>;
}

/** input 对象 schema（§3.4 input：type + text 或结构化输入）。 */
interface TurnInput {
  type: string;
  text?: string;
  attachments?: Array<{
    workspace_attachment_id: string;
    resource_type: string;
    resource_ref: string;
  }>;
}

/** 请求体 schema。 */
interface CreateTurnBody {
  input: TurnInput;
  selected_model?: string;
  workspace_attachment_ids?: string[];
}

function validateBody(body: unknown): body is CreateTurnBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (!b.input || typeof b.input !== "object") return false;
  const input = b.input as Record<string, unknown>;
  if (typeof input.type !== "string" || input.type.length === 0) return false;
  if (input.text !== undefined && typeof input.text !== "string") return false;
  if (b.selected_model !== undefined && typeof b.selected_model !== "string") return false;
  if (b.workspace_attachment_ids !== undefined) {
    if (!Array.isArray(b.workspace_attachment_ids)) return false;
    for (const id of b.workspace_attachment_ids) {
      if (typeof id !== "string") return false;
    }
  }
  return true;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { thread_id: threadId } = await context.params;

  // 1. 解析员工身份
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Thread 属于当前员工（非 owner → 404 隐藏式）
  const thread = await getThreadById(principal.tenantId, threadId);
  if (!thread || thread.ownerUserId !== principal.userIdentityId) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
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
      "请求体非法：缺少 input 或字段类型错误（input.type 必填）",
    );
  }

  // 5. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromPrincipal(principal);
  const commandScope = `turn.create:${threadId}`;

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

  // 7. 执行业务：acceptUserMessageTurn 原子接纳事务
  try {
    const result = await acceptUserMessageTurn({
      tenantId: principal.tenantId,
      threadId,
      ownerUserId: principal.userIdentityId,
      content: {
        text: body.input.text ?? "",
        attachments: body.input.attachments,
        client_message_id: idempotencyKey,
      },
      actorId: principal.userIdentityId,
      idempotencyKey,
      correlationId: requestId,
    });

    // 8. 构造响应（turn + input_item + event_cursor）
    const lastEvent = result.events[result.events.length - 1];
    const responseBody = {
      turn: {
        id: result.turn.id,
        thread_id: result.turn.threadId,
        turn_sequence: result.turn.turnSequence,
        trigger_type: result.turn.triggerType,
        turn_state: result.turn.turnState,
      },
      input_item: {
        id: result.item.id,
        item_type: result.item.itemType,
        item_sequence: result.item.itemSequence,
        item_state: result.item.itemState,
      },
      event_cursor: {
        sequence: lastEvent?.eventSequence ?? result.thread.lastEventSequence,
        event_id: lastEvent?.id ?? null,
      },
    };

    const dispatch = await dispatchEmployeeTurn({
      tenantId: principal.tenantId,
      threadId,
      turnId: result.turn.id,
    });
    if (!dispatch.dispatched) {
      throw new Error(`Turn 调度未启动（turnId=${result.turn.id}）`);
    }

    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 201,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    logger.error("[runtime] Turn 接纳或调度失败", {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    await failRecord(recordId);
    const errorResp = conversationErrorToResponse(err, requestId);
    if (errorResp) return errorResp;
    throw err;
  }
}

// ─── GET /api/v1/threads/{thread_id}/turns — 查询 Turn 列表（S10-W02） ────────

import { getTurnsByThread } from "@/lib/conversations/turn-queries";
import type { Turn } from "@/lib/persistence/schema/conversation";

/** 投影 Turn 为响应体（snake_case）。 */
function projectTurn(turn: Turn): Record<string, unknown> {
  return {
    id: turn.id,
    turn_sequence: turn.turnSequence,
    trigger_type: turn.triggerType,
    trigger_ref: turn.triggerRef,
    trigger_item_id: turn.triggerItemId,
    turn_state: turn.turnState,
    active_invocation_id: turn.activeInvocationId,
    latest_invocation_id: turn.latestInvocationId,
    adopted_invocation_id: turn.adoptedInvocationId,
    final_item_id: turn.finalItemId,
    error_code: turn.errorCode,
    regeneration_no: turn.regenerationNo,
    accepted_at: turn.acceptedAt.toISOString(),
    started_at: turn.startedAt?.toISOString() ?? null,
    waiting_at: turn.waitingAt?.toISOString() ?? null,
    finished_at: turn.finishedAt?.toISOString() ?? null,
  };
}

/**
 * GET /api/v1/threads/{thread_id}/turns — 查询 Thread 的 Turn 列表（S10-W02，§3.4）。
 *
 * 事实源：docs/architecture/api-and-events.md §3.4、
 *         docs/architecture/product-surfaces-and-admin.md S10-W02。
 *
 * 行为：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 返回 Turn 列表（按 turn_sequence 升序），用于客户端推导当前任务状态。
 * - 支持 limit 参数（默认 50，最大 200）。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - limit 非法 → 400 REQUEST_SCHEMA_INVALID
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { thread_id: threadId } = await context.params;

  // 1. 解析员工身份
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Thread 属于当前员工（非 owner → 404 隐藏式）
  const thread = await getThreadById(principal.tenantId, threadId);
  if (!thread || thread.ownerUserId !== principal.userIdentityId) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  // 3. 解析查询参数
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
    return schemaInvalidTable(requestId, "limit 必须为 1–200 之间的整数");
  }

  // 4. 查询 Turn 列表
  const turns = await getTurnsByThread(principal.tenantId, threadId);

  // 5. 返回 200 + Turn 列表（按 turn_sequence 升序）
  const responseBody = {
    turns: turns.slice(0, limit).map(projectTurn),
  };

  return apiSuccess(responseBody, {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
