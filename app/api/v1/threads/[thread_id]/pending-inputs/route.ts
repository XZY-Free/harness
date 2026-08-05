/**
 * GET  /api/v1/threads/{thread_id}/pending-inputs — 查询 PendingInput 队列（S04-C04，§3.6）。
 * POST /api/v1/threads/{thread_id}/pending-inputs — 创建 PendingInput（S04-C04，§3.7）。
 *
 * 事实源：../v11-agentkit-platform/11-api-and-event-boundaries.md §3.6-3.7、
 *         ../v11-agentkit-platform/02-agent-thread-and-runtime.md §3.14（创建不生成 user_message Item）。
 *
 * 行为（GET）：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 调用 listPendingInputs 读取队列快照 + queue_etag。
 * - 返回 200 + pending_inputs + queue_etag。
 *
 * 行为（POST）：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 解析 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（input 必填，client_message_id 可选）。
 * - 调用 createPendingInput 事务内创建 + 写 pending_input.created Event。
 * - completeRecord + 返回 201 + pending_input + queue_etag。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 */
import {
  type PendingInputContent,
  createPendingInput,
  listPendingInputs,
} from "@/lib/conversations/pending-input-queries";
import {
  type Principal,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import {
  ETAG_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiSuccess,
  etagHeader,
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
  params: Promise<{ thread_id: string }>;
}

/** input 对象 schema（type 必填，其余字段自由结构）。 */
interface PendingInputBody {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** 请求体 schema（POST 创建）。 */
interface CreatePendingInputBody {
  input: PendingInputBody;
  client_message_id?: string;
}

function validateInput(input: unknown): input is PendingInputBody {
  if (!input || typeof input !== "object") return false;
  const i = input as Record<string, unknown>;
  if (typeof i.type !== "string" || i.type.length === 0) return false;
  return true;
}

function validateCreateBody(body: unknown): body is CreatePendingInputBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (!validateInput(b.input)) return false;
  if (b.client_message_id !== undefined && typeof b.client_message_id !== "string") return false;
  return true;
}

// ─── GET：查询 PendingInput 队列 ────────────────────────────

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

  // 3. 查询队列快照
  const result = await listPendingInputs(principal.tenantId, threadId);

  // 4. 返回 200 + pending_inputs + queue_etag
  const responseBody = {
    thread_id: result.thread_id,
    queue_etag: result.queue_etag,
    pending_inputs: result.pending_inputs,
  };

  return apiSuccess(responseBody, {
    status: 200,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      [ETAG_HEADER]: `"${result.queue_etag}"`,
    },
  });
}

// ─── POST：创建 PendingInput ────────────────────────────────

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
  if (!validateCreateBody(body)) {
    return schemaInvalidTable(requestId, "请求体非法：缺少 input 或 input.type 为空");
  }

  // 5. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromPrincipal(principal);
  const commandScope = `pending_input.create:${threadId}`;

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

  // 7. 执行业务：createPendingInput 事务内创建 + 写 Event
  try {
    const result = await createPendingInput({
      tenantId: principal.tenantId,
      threadId,
      ownerUserId: principal.userIdentityId,
      input: body.input as PendingInputContent,
      clientMessageId: body.client_message_id,
      idempotencyKey,
      correlationId: requestId,
    });

    const responseBody = {
      pending_input: {
        id: result.id,
        thread_id: result.thread_id,
        input_state: result.input_state,
        queue_position: result.queue_position,
        input: result.input,
        etag: result.etag,
      },
      queue_etag: result.queue_etag,
    };

    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 201,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(result.etag),
        [ETAG_HEADER]: `"${result.queue_etag}"`,
      },
    });
  } catch (err) {
    await failRecord(recordId);
    const errorResp = conversationErrorToResponse(err, requestId);
    if (errorResp) return errorResp;
    throw err;
  }
}
