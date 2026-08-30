/**
 * POST /api/v1/threads — 创建 Thread（§3.1）。
 *
 * 事实源：docs/architecture/api-and-events.md §3.1、
 *
 * 行为：
 * - 解析员工身份（employee audience）。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（title/workspace_id 可选）。
 * - 调用 createThread 同事务写 Thread + thread.created Event。
 * - completeRecord + 返回 201 + Thread 投影。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 */
import { aiConfig } from "@/lib/config";
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { createThread, listThreadsForUser } from "@/lib/conversations/thread-queries";
import { IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
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
 * GET /api/v1/threads — Desktop 本地渲染 Shell 的启动数据。
 *
 * Electron 不再加载服务端 /desktop 页面；本地 renderer 通过此端点读取当前员工的
 * 会话列表、可用助手和稳定的 viewer id，再用相对路径调用其余 API。
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const threads = await listThreadsForUser(principal.tenantId, principal.userIdentityId);
  return apiSuccess(
    {
      viewer_id: principal.userIdentityId,
      threads: threads.map((thread) => ({
        id: thread.id,
        title: thread.title,
      })),
      default_model_ref: aiConfig.chatModel,
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}

/** 请求体 schema（与 §3.1 requestBody 对齐）。 */
interface CreateThreadBody {
  title?: string;
  workspace_id?: string;
}

/** 校验请求体。 */
function validateBody(body: unknown): body is CreateThreadBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.title !== undefined && typeof b.title !== "string") return false;
  if (b.workspace_id !== undefined && typeof b.workspace_id !== "string") return false;
  return true;
}

/** 投影 Thread 为响应体（snake_case）。 */
function projectThread(thread: {
  id: string;
  title: string | null;
  defaultWorkspaceId: string | null;
  lifecycleState: string;
  lastEventSequence: number;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: thread.id,
    title: thread.title,
    default_workspace_id: thread.defaultWorkspaceId,
    lifecycle_state: thread.lifecycleState,
    last_event_sequence: thread.lastEventSequence,
    created_at: thread.createdAt.toISOString(),
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析员工身份
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 3. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(requestId, "请求体非法：字段类型错误");
  }

  // 4. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromPrincipal(principal);
  const commandScope = "thread.create";

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

  // retry_allowed：重置 failed 记录后重新执行
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

  // 7. 执行业务：创建 Thread（同事务写 thread.created Event）
  try {
    const { thread } = await createThread({
      tenantId: principal.tenantId,
      ownerUserId: principal.userIdentityId,
      title: body.title ?? null,
      defaultWorkspaceId: body.workspace_id ?? null,
      actorId: principal.userIdentityId,
      idempotencyKey,
    });

    // 8. completeRecord + 返回 201
    const responseBody = projectThread(thread);
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
    throw err;
  }
}
