/**
 * POST /api/v1/threads/{thread_id}/handoffs/{handoff_id}:resolve — 员工解析 Handoff 请求（S10-W04，§3.18）。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md §3.18（解析 UserActionRequest）、
 *   §7.2（handoff.completed Event）
 * - docs/architecture/capability-and-collaboration-api.md §5（Handoff 统一规则）
 * - docs/architecture/decision-ledger.md 行 52、174（Workflow Handoff 必须员工确认）
 * - docs/architecture/conversations.md S09-W03
 * - docs/architecture/product-surfaces-and-admin.md S10-W04
 *
 * 行为：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（resolution: "approve" | "deny"）。
 * - 校验 UserActionRequest 属于该 Thread + purpose=handoff + state=pending（否则 404 隐藏式）。
 * - 调用 resolveHandoff 事务内：
 *   - approve：UPDATE Thread.primary_agent_id + 写 user_action.resolved +
 *     thread.primary_agent_changed + handoff.completed Event + 入队 resume InvocationCommand。
 *   - deny：写 user_action.resolved Event + 入队 resume InvocationCommand；主 Agent 不变。
 * - completeRecord + 返回 200 + Handoff 解析结果投影。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - UserActionRequest 不存在/非该 Thread/非 handoff purpose → 404 RESOURCE_NOT_FOUND
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - HandoffAlreadyResolvedError → 409 OPERATION_PAYLOAD_CONFLICT
 * - HandoffValidationError（AGENT_NOT_AVAILABLE/PURPOSE_MISMATCH/INVOCATION_NOT_RUNNING/RESOLUTION_NOT_ALLOWED）
 *   → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - HandoffVersionConflictError → 412 ETAG_MISMATCH
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 */
import { resolveHandoff } from "@/lib/conversations/handoff-queries";
import {
  type Principal,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
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
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * 路径参数上下文（含冒号 custom method 段）。
 *
 * Next.js 把 `[handoff_id]:resolve` 作为整体段名；运行时 params key 为 "handoff_id:resolve"，
 * 段值形如 `{handoff_id}`（不包含 `:resolve` 后缀）。
 */
interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/** 请求体 schema。 */
interface ResolveHandoffBody {
  resolution: "approve" | "deny";
}

function validateBody(body: unknown): body is ResolveHandoffBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.resolution !== "approve" && b.resolution !== "deny") return false;
  return true;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const params = await context.params;
  const threadIdRaw = params.thread_id;
  const threadId = typeof threadIdRaw === "string" ? threadIdRaw : "";
  const handoffRaw = params["handoff_id:resolve"];
  const handoffId = typeof handoffRaw === "string" ? handoffRaw : "";

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
    return schemaInvalidTable(requestId, "请求体非法：resolution 仅接受 approve/deny");
  }

  // 5. 校验 UserActionRequest 属于该 Thread + purpose=handoff + state=pending
  //    （非该 Thread / 非 handoff / 非 pending → 404 隐藏式，不泄露存在）
  const [requestRow] = await db
    .select()
    .from(userActionRequestTable)
    .where(
      and(
        eq(userActionRequestTable.tenantId, principal.tenantId),
        eq(userActionRequestTable.id, handoffId),
      ),
    )
    .limit(1);
  if (
    !requestRow ||
    requestRow.threadId !== threadId ||
    requestRow.purpose !== "handoff" ||
    requestRow.requestState !== "pending"
  ) {
    return resourceNotFound(requestId, `Handoff 请求不存在或无权访问: ${handoffId}`);
  }

  // 6. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromPrincipal(principal);
  const commandScope = `thread.resolve_handoff:${handoffId}`;

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

  // 8. 执行业务：事务内解析 Handoff
  try {
    const result = await resolveHandoff({
      tenantId: principal.tenantId,
      requestId: handoffId,
      resolution: body.resolution,
      resolvedBy: principal.userIdentityId,
      actorType: "user",
      actorId: principal.userIdentityId,
      idempotencyKey,
    });

    const responseBody = {
      thread_id: result.thread.id,
      request_id: result.request.id,
      resolution: body.resolution,
      request_state: result.request.requestState,
      handed_off: result.handedOff,
      previous_agent_id:
        body.resolution === "approve" ? thread.primaryAgentId : result.thread.primaryAgentId,
      primary_agent_id: result.thread.primaryAgentId,
      invocation_id: result.invocation.id,
      invocation_state: result.invocation.executionState,
      resume_command_id: result.resumeCommand.id,
      resume_command_state: result.resumeCommand.commandState,
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
