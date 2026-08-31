import {
  type TurnAgentActivityProjection,
  emptyTurnAgentActivity,
  loadTurnAgentActivity,
} from "@/lib/agents/calls/application/agent-call-projection";
import {
  type Principal,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
/**
 * POST /api/v1/threads/{thread_id}/turns — 创建 Turn（§3.4）。
 *
 * 事实源：docs/architecture/api-and-events.md §3.4、
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
import { requireAgentInvokeScope } from "@/lib/identity/authorization";
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
  /** 本 Turn 显式 Agent 使用偏好；null/省略均表示本 Turn 无 directive。 */
  agent_use?: { mode: "preferred"; agent_id: string } | null;
}

function validateBody(body: unknown): body is CreateTurnBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const allowedKeys = new Set(["input", "selected_model", "workspace_attachment_ids", "agent_use"]);
  if (Object.keys(b).some((key) => !allowedKeys.has(key))) return false;
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
  if (b.agent_use !== undefined && b.agent_use !== null) {
    if (typeof b.agent_use !== "object" || Array.isArray(b.agent_use)) return false;
    const directive = b.agent_use as Record<string, unknown>;
    const directiveKeys = new Set(["mode", "agent_id"]);
    if (Object.keys(directive).some((key) => !directiveKeys.has(key))) return false;
    if (directive.mode !== "preferred") return false;
    if (typeof directive.agent_id !== "string" || directive.agent_id.trim().length === 0) {
      return false;
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

  // Catalog 是发现入口，不是安全边界。任何 Agent directive 都必须在写入幂等记录和 Turn 前
  // 按当前 RoleActionBinding 重新检查 exact agent.invoke；统一 403，不查询 Agent 存在性。
  const preferredAgentId = body.agent_use?.agent_id.trim() ?? null;
  if (preferredAgentId) {
    const authorization = await requireAgentInvokeScope(principal, preferredAgentId, requestId);
    if (!authorization.ok) return authorization.response;
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
      agentUse: body.agent_use ? { mode: "preferred", agentId: preferredAgentId as string } : null,
      idempotencyKey,
      correlationId: requestId,
    });

    const dispatch = await dispatchEmployeeTurn({
      tenantId: principal.tenantId,
      threadId,
      turnId: result.turn.id,
      correlationId: requestId,
      modelRef: body.selected_model,
      // ExecutionSubject：服务端从认证 Principal 生成，禁止 caller 自报。
      executionSubject: {
        tenantId: principal.tenantId,
        subjectType: "user",
        subjectId: principal.userIdentityId,
      },
    });
    if (!dispatch.dispatched) {
      // 顶层无有效 Runtime Route → Turn 保持 accepted（Agent 与 Runtime Authority 分离）。
      // 用户选择 Agent 是本 Turn 偏好，不作为顶层 Route 判断；顶层无 Route 时
      // 由正式控制面初始化供应 / dispatch retry 处理，POST Turn 不在此做同步失败。
      logger.warn("[runtime] 顶层 Harness Route 未就绪，Turn 保持 accepted", {
        threadId,
        turnId: result.turn.id,
        reason: dispatch.reason ?? "no_effective_route",
      });
    }

    // 8. 构造响应（Turn directive 与真实 AgentCall 分开投影）。调度是异步的，
    // 因此这里只返回响应生成时已经持久化的真实调用，不预判后续 Harness 行动。
    const agentActivityByTurn = await loadTurnAgentActivity(principal.tenantId, [result.turn]);
    const agentActivity = agentActivityByTurn.get(result.turn.id) ?? emptyTurnAgentActivity();
    const lastEvent = result.events[result.events.length - 1];
    const responseBody = {
      turn: {
        id: result.turn.id,
        thread_id: result.turn.threadId,
        turn_sequence: result.turn.turnSequence,
        trigger_type: result.turn.triggerType,
        turn_state: result.turn.turnState,
        agent_use: agentActivity.agent_use,
        actual_agent_calls: agentActivity.actual_agent_calls,
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

// ─── GET /api/v1/threads/{thread_id}/turns — 查询 Turn 列表 ────────

import { getTurnsByThread } from "@/lib/conversations/turn-queries";
import type { Turn } from "@/lib/persistence/schema/conversation";
import { type TurnControls, resolveTurnControls } from "@/lib/runtime/capabilities/turn-controls";

/**
 * 投影 Turn 为响应体（snake_case）。
 * controls由服务端按精确 Binding 派生（EffectiveInvocationCapabilities），
 * 终态 Turn 恒 false；无 Binding → fail-closed 全 false。
 */
function projectTurn(
  turn: Turn,
  controls: TurnControls = {
    cancel_supported: false,
    resume_supported: false,
    steer_supported: false,
  },
  agentActivity: TurnAgentActivityProjection = emptyTurnAgentActivity(),
): Record<string, unknown> {
  return {
    controls: {
      cancel_supported: controls.cancel_supported,
      resume_supported: controls.resume_supported,
      steer_supported: controls.steer_supported,
    },
    id: turn.id,
    turn_sequence: turn.turnSequence,
    trigger_type: turn.triggerType,
    agent_use: agentActivity.agent_use,
    actual_agent_calls: agentActivity.actual_agent_calls,
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
 * GET /api/v1/threads/{thread_id}/turns — 查询 Thread 的 Turn 列表（§3.4）。
 *
 * 事实源：docs/architecture/api-and-events.md §3.4、
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

  // 5. 解析 Turn controls（服务端 Binding 派生，05 §9）并返回列表（按 turn_sequence 升序）
  const visibleTurns = turns.slice(0, limit);
  const controlsByTurn = await resolveTurnControls(principal.tenantId, visibleTurns);
  const agentActivityByTurn = await loadTurnAgentActivity(principal.tenantId, visibleTurns);
  const responseBody = {
    turns: visibleTurns.map((turn) =>
      projectTurn(turn, controlsByTurn.get(turn.id), agentActivityByTurn.get(turn.id)),
    ),
  };

  return apiSuccess(responseBody, {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
