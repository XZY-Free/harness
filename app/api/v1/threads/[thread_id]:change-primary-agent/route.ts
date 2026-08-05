/**
 * POST /api/v1/threads/{thread_id}:change-primary-agent — 更换 Thread 主 Agent（S04-C03，§3.3）。
 *
 * 事实源：../v11-agentkit-platform/11-api-and-event-boundaries.md §3.3、
 *         ../v11-agentkit-platform-development-plan/04-thread-turn-item-and-event-core.md S04-W01。
 *
 * 行为：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（agent_id + reason 必填）。
 * - 校验新 Agent 存在且 enabled 且同租户（无权/不存在 → 404，不泄露存在）。
 * - 调用 changePrimaryAgentWithEvent 事务内更换主 Agent + 写 thread.primary_agent_changed Event。
 * - completeRecord + 返回 200 + 主 Agent 变更投影。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - Agent 不存在/非 enabled/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - 乐观锁冲突 → 412 ETAG_MISMATCH
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 */
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import {
  type Principal,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { changePrimaryAgentWithEvent } from "@/lib/conversations/thread-settings-queries";
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
 * Next.js 类型验证器不识别 `[thread_id]:change-primary-agent` 为标准动态段（生成 Promise<{}>），
 * 故使用 Record 宽类型；运行时 params key 为 "thread_id:change-primary-agent"。
 */
interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/** 请求体 schema（§3.3 requestBody）。 */
interface ChangePrimaryAgentBody {
  agent_id: string;
  reason: string;
}

function validateBody(body: unknown): body is ChangePrimaryAgentBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.agent_id !== "string" || b.agent_id.length === 0) return false;
  if (typeof b.reason !== "string" || b.reason.length === 0) return false;
  return true;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const params = await context.params;
  // Next.js 把 [thread_id]:change-primary-agent 段名作为 key；thread_id 是冒号前的部分。
  const rawValue = params["thread_id:change-primary-agent"];
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
    return schemaInvalidTable(requestId, "请求体非法：缺少 agent_id 或 reason");
  }

  // 5. 校验新 Agent 存在且 enabled（无权/不存在 → 404 隐藏式）
  const newAgent = await getAgentById(principal.tenantId, body.agent_id);
  if (!newAgent || newAgent.lifecycleState !== "enabled") {
    return resourceNotFound(requestId, `Agent 不存在或无权使用: ${body.agent_id}`);
  }

  // 6. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromPrincipal(principal);
  const commandScope = `thread.change_primary_agent:${threadId}`;

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

  // 8. 执行业务：事务内更换主 Agent + 写 thread.primary_agent_changed Event
  try {
    const { thread: updatedThread, event } = await changePrimaryAgentWithEvent({
      tenantId: principal.tenantId,
      threadId,
      nextAgentId: body.agent_id,
      expectedVersionNo: thread.versionNo,
      reason: body.reason,
      actorType: "user",
      actorId: principal.userIdentityId,
      idempotencyKey,
    });

    const responseBody = {
      thread_id: updatedThread.id,
      previous_agent_id: thread.primaryAgentId,
      primary_agent_id: updatedThread.primaryAgentId,
      event_id: event.id,
      applies_to_new_invocations: true,
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
