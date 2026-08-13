/**
 * POST /api/v1/threads/{thread_id}:request-handoff — 发起主 Agent 交接请求（S10-W04，§3.3/§5.5）。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md §3.3（更换主 Agent 命令）、
 *   §5.5（发起 UserActionRequest）、§7.2（handoff.requested Event）
 * - docs/architecture/capability-and-collaboration-api.md §5（Handoff 统一规则）
 * - docs/architecture/conversations.md S09-W03
 * - docs/architecture/product-surfaces-and-admin.md S10-W04
 *
 * 行为：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（invocation_id/turn_id/target_agent_id/reason 必填；impact 可选）。
 * - 校验目标 Agent 存在且 enabled 且同租户（无权/不存在 → 404，不泄露存在）。
 * - 调用 requestHandoff 事务内创建 UserActionRequest + user_action ThreadItem + 写
 *   item.created / user_action.requested / handoff.requested Event；Invocation → waiting_user。
 * - completeRecord + 返回 200 + Handoff 请求投影。
 *
 * 设计说明：
 * - 规范上 requestHandoff 由 Workflow/Runtime 触发；本路由主要服务于：
 *   1) 阶段 10 端到端测试（Workflow/Runtime 未接入前的手测路径）；
 *   2) 员工在异常情况下手动发起交接的 fallback。
 * - 生产环境 Workflow/Runtime 应通过内部服务调用 requestHandoff（不经过本 HTTP 路由）。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - Agent 不存在/非 enabled/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - HandoffValidationError（THREAD_NOT_ACTIVE/SAME_AGENT/INVOCATION_NOT_RUNNING/AGENT_NOT_AVAILABLE）
 *   → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - HandoffVersionConflictError → 412 ETAG_MISMATCH
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 */
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import { requestHandoff } from "@/lib/conversations/handoff-queries";
import {
  type Principal,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
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
 * 路径参数上下文（Next.js App Router 动态段，含冒号 custom method）。
 *
 * 与 :change-primary-agent 一致：Next.js 类型验证器不识别 `[thread_id]:request-handoff`
 * 为标准动态段，故使用 Record 宽类型；运行时 params key 为 "thread_id:request-handoff"。
 */
interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/** 请求体 schema。 */
interface RequestHandoffBody {
  invocation_id: string;
  turn_id: string;
  target_agent_id: string;
  reason: string;
  impact?: string;
}

function validateBody(body: unknown): body is RequestHandoffBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.invocation_id !== "string" || b.invocation_id.length === 0) return false;
  if (typeof b.turn_id !== "string" || b.turn_id.length === 0) return false;
  if (typeof b.target_agent_id !== "string" || b.target_agent_id.length === 0) return false;
  if (typeof b.reason !== "string" || b.reason.length === 0) return false;
  if (b.impact !== undefined && typeof b.impact !== "string") return false;
  return true;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const params = await context.params;
  const rawValue = params["thread_id:request-handoff"];
  const rawSegment = typeof rawValue === "string" ? rawValue : "";
  const threadId = rawSegment.split(":")[0] ?? "";

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
      "请求体非法：缺少 invocation_id/turn_id/target_agent_id/reason",
    );
  }

  // 5. 校验目标 Agent 存在且 enabled（无权/不存在 → 404 隐藏式）
  const targetAgent = await getAgentById(principal.tenantId, body.target_agent_id);
  if (!targetAgent || targetAgent.lifecycleState !== "enabled") {
    return resourceNotFound(requestId, `目标 Agent 不存在或无权使用: ${body.target_agent_id}`);
  }

  // 6. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromPrincipal(principal);
  const commandScope = `thread.request_handoff:${threadId}`;

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  // 7. 处理幂等结果
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

  // 8. 执行业务：事务内创建 UserActionRequest + ThreadItem + 写 3 条 Event
  try {
    const result = await requestHandoff({
      tenantId: principal.tenantId,
      threadId,
      invocationId: body.invocation_id,
      turnId: body.turn_id,
      targetAgentId: body.target_agent_id,
      reason: body.reason,
      impact: body.impact,
      actorType: "user",
      actorId: principal.userIdentityId,
      idempotencyKey,
    });

    const responseBody = {
      thread_id: result.thread.id,
      request_id: result.request.id,
      item_id: result.item.id,
      invocation_id: result.invocation.id,
      previous_agent_id: thread.primaryAgentId,
      target_agent_id: body.target_agent_id,
      target_agent_display_name: targetAgent.displayName,
      purpose: "handoff",
      request_type: "confirmation",
      request_state: result.request.requestState,
      turn_id: body.turn_id,
      event_ids: result.events.map((e) => e.id),
    };

    await completeRecord({
      recordId,
      httpStatus: 200,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);
    const errorResp = conversationErrorToResponse(err, requestId);
    if (errorResp) return errorResp;
    throw err;
  }
}
