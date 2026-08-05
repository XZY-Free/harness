import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  getRequestId,
  resourceNotFound,
  apiSuccess,
} from "@/lib/http";
/**
 * POST /api/v1/threads/{thread_id}/forks — Fork Thread（S04-C06，§3.10）。
 *
 * 事实源：../v11-agentkit-platform/11-api-and-event-boundaries.md §3.10、
 *         ../v11-agentkit-platform/02-agent-thread-and-runtime.md §3.10（Fork）、
 *         ../v11-agentkit-platform/05-continuity-collaboration-and-reliability.md §4（Fork 语义）。
 *
 * 行为：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（from_turn_id 必填；title 可选；workspace_mode 可选，默认 none）。
 * - 调用 forkThread 事务内创建子 Thread + 父子关系 + 两条 Event。
 * - completeRecord + 返回 201 + Fork 结果。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - Fork 源 Turn 不属于源 Thread → 409 BUSINESS_CONSTRAINT_VIOLATION
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 */
import { type ForkWorkspaceMode, forkThread } from "@/lib/v11/conversation/fork-queries";
import {
  type Principal,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  v11SchemaInvalid,
} from "@/lib/v11/conversation/route-helpers";
import { getThreadById } from "@/lib/v11/conversation/thread-queries";
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
  params: Promise<{ thread_id: string }>;
}

/** 请求体 schema（§3.10 requestBody）。 */
interface ForkBody {
  from_turn_id: string;
  title?: string | null;
  workspace_mode?: ForkWorkspaceMode;
}

function validateBody(body: unknown): body is ForkBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.from_turn_id !== "string" || b.from_turn_id.length === 0) return false;
  if (b.title !== undefined && b.title !== null && typeof b.title !== "string") return false;
  if (b.workspace_mode !== undefined) {
    if (b.workspace_mode !== "none" && b.workspace_mode !== "checkpoint_copy") return false;
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
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return v11SchemaInvalid(requestId, "请求体非法：缺少 from_turn_id 或字段类型错误");
  }

  // 5. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromPrincipal(principal);
  const commandScope = `thread.fork:${threadId}`;

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

  // 7. 执行业务：forkThread 事务内创建子 Thread + 父子关系 + 两条 Event
  try {
    const result = await forkThread({
      tenantId: principal.tenantId,
      ownerUserId: principal.userIdentityId,
      parentThreadId: threadId,
      fromTurnId: body.from_turn_id,
      title: body.title ?? null,
      workspaceMode: body.workspace_mode ?? "none",
      idempotencyKey,
      correlationId: requestId,
    });

    const responseBody = {
      thread: {
        id: result.thread.id,
        tenant_id: result.thread.tenantId,
        owner_user_id: result.thread.ownerUserId,
        primary_agent_id: result.thread.primaryAgentId,
        title: result.thread.title,
        lifecycle_state: result.thread.lifecycleState,
        last_event_sequence: result.thread.lastEventSequence,
        version_no: result.thread.versionNo,
        created_at: result.thread.createdAt.toISOString(),
      },
      relation: {
        id: result.relation.id,
        parent_thread_id: result.relation.parentThreadId,
        child_thread_id: result.relation.childThreadId,
        relation_type: result.relation.relationType,
        source_turn_id: result.relation.sourceTurnId,
        relation_state: result.relation.relationState,
      },
      copied_through_turn_id: result.copiedThroughTurnId,
      filesystem_checkpoint_id: result.filesystemCheckpointId,
      child_created_event_id: result.childCreatedEvent.id,
      parent_child_thread_created_event_id: result.parentChildThreadCreatedEvent.id,
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
    await failRecord(recordId);
    const errorResp = conversationErrorToResponse(err, requestId);
    if (errorResp) return errorResp;
    throw err;
  }
}
