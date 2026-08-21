/**
 * POST /api/v1/threads/{thread_id}/pending-inputs/reorder — 重排 PendingInput 队列（S04-C04，§3.8）。
 *
 * 事实源：docs/architecture/api-and-events.md §3.8、
 *         docs/architecture/persistence.md §5.6。
 *
 * 行为：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 解析 If-Match 队列 ETag（必填）→ expectedQueueVersionNo（乐观锁）。
 * - 校验请求体（ordered_ids 必填，非空数组，每个元素为 string）。
 * - 调用 reorderPendingInputs 事务内重排 + 写 pending_input.reordered Event。
 * - 返回 200 + pending_inputs + queue_etag。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 缺少 If-Match → 400 REQUEST_SCHEMA_INVALID
 * - 队列 ETag 格式非法 → 400 REQUEST_SCHEMA_INVALID
 * - ordered_ids 集合不一致 → 409 BUSINESS_CONSTRAINT_VIOLATION
 * - 乐观锁冲突 → 412 ETAG_MISMATCH
 */
import { reorderPendingInputs } from "@/lib/conversations/pending-input-queries";
import {
  type Principal,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  parsePendingQueueEtag,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import {
  ETAG_HEADER,
  REQUEST_ID_HEADER,
  apiSuccess,
  getRequestId,
  parseIfMatch,
  resourceNotFound,
} from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * 路径参数上下文（Next.js App Router 原生动态段）。
 * 命令作为资源子路径（`/{id}/command`），动态参数直接从 params 解构。
 */
interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/** 请求体 schema（§3.8 requestBody）。 */
interface ReorderPendingInputsBody {
  ordered_ids: string[];
}

function validateBody(body: unknown): body is ReorderPendingInputsBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.ordered_ids) || b.ordered_ids.length === 0) return false;
  for (const id of b.ordered_ids) {
    if (typeof id !== "string" || id.length === 0) return false;
  }
  return true;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const params = await context.params;
  const rawValue = params.thread_id;
  const threadId = typeof rawValue === "string" ? rawValue : "";

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

  // 3. 解析 If-Match 队列 ETag（必填）
  const ifMatchRaw = parseIfMatch(request);
  if (!ifMatchRaw) {
    return schemaInvalidTable(requestId, "缺少必填头 If-Match（队列 ETag）");
  }

  let expectedQueueVersionNo: number;
  try {
    expectedQueueVersionNo = parsePendingQueueEtag(ifMatchRaw);
  } catch {
    return schemaInvalidTable(requestId, `If-Match ETag 格式非法: ${ifMatchRaw}`);
  }

  // 4. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(requestId, "请求体非法：ordered_ids 必填且为非空 string 数组");
  }

  // 5. 执行业务：事务内重排 + 写 Event
  try {
    const result = await reorderPendingInputs({
      tenantId: principal.tenantId,
      threadId,
      ownerUserId: principal.userIdentityId,
      expectedQueueVersionNo,
      orderedIds: body.ordered_ids,
      correlationId: requestId,
    });

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
  } catch (err) {
    const errorResp = conversationErrorToResponse(err, requestId);
    if (errorResp) return errorResp;
    throw err;
  }
}
