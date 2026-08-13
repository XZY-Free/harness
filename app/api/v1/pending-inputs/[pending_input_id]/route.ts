/**
 * PATCH  /api/v1/pending-inputs/{pending_input_id} — 编辑 PendingInput 内容（S04-C04，§3.9）。
 * DELETE /api/v1/pending-inputs/{pending_input_id} — 移除 PendingInput（S04-C04，§3.10）。
 *
 * 事实源：docs/architecture/api-and-events.md §3.9-3.10、
 *         docs/architecture/agent-control-plane.md §3.17（删除不生成 user_message Item）。
 *
 * 行为（PATCH）：
 * - 解析员工身份。
 * - 解析 If-Match 资源 ETag（必填）→ expectedVersionNo（乐观锁）。
 * - 校验请求体（input 必填）。
 * - 调用 editPendingInput 事务内更新 + 写 pending_input.updated Event（隐藏式 404）。
 * - 返回 200 + pending_input + queue_etag。
 *
 * 行为（DELETE）：
 * - 解析员工身份。
 * - 解析 If-Match 资源 ETag（必填）→ expectedVersionNo（乐观锁）。
 * - 调用 removePendingInput 事务内移除 + 写 pending_input.removed Event（隐藏式 404）。
 * - 返回 200 + removed_at + queue_etag。
 *
 * 错误映射：
 * - PendingInput 不存在/跨租户/非 owner → 404 RESOURCE_NOT_FOUND（隐藏式）
 * - PendingInput 非 pending 状态 → 409 BUSINESS_CONSTRAINT_VIOLATION
 * - 缺少 If-Match → 400 REQUEST_SCHEMA_INVALID
 * - ETag 格式非法 → 400 REQUEST_SCHEMA_INVALID
 * - 乐观锁冲突 → 412 ETAG_MISMATCH
 */
import {
  type PendingInputContent,
  editPendingInput,
  removePendingInput,
} from "@/lib/conversations/pending-input-queries";
import {
  type Principal,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  parsePendingInputEtag,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import {
  ETAG_HEADER,
  REQUEST_ID_HEADER,
  apiSuccess,
  etagHeader,
  getRequestId,
  parseIfMatch,
} from "@/lib/http";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ pending_input_id: string }>;
}

/** input 对象 schema（type 必填，其余字段自由结构）。 */
interface PendingInputBody {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** 请求体 schema（PATCH 编辑）。 */
interface EditPendingInputBody {
  input: PendingInputBody;
}

function validateInput(input: unknown): input is PendingInputBody {
  if (!input || typeof input !== "object") return false;
  const i = input as Record<string, unknown>;
  if (typeof i.type !== "string" || i.type.length === 0) return false;
  return true;
}

function validateEditBody(body: unknown): body is EditPendingInputBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (!validateInput(b.input)) return false;
  return true;
}

// ─── PATCH：编辑 PendingInput ───────────────────────────────

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { pending_input_id: pendingInputId } = await context.params;

  // 1. 解析员工身份
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析 If-Match 资源 ETag（必填）
  const ifMatchRaw = parseIfMatch(request);
  if (!ifMatchRaw) {
    return schemaInvalidTable(requestId, "缺少必填头 If-Match（资源 ETag）");
  }

  let expectedVersionNo: number;
  try {
    expectedVersionNo = parsePendingInputEtag(ifMatchRaw);
  } catch {
    return schemaInvalidTable(requestId, `If-Match ETag 格式非法: ${ifMatchRaw}`);
  }

  // 3. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateEditBody(body)) {
    return schemaInvalidTable(requestId, "请求体非法：缺少 input 或 input.type 为空");
  }

  // 4. 执行业务：事务内编辑 + 写 Event（隐藏式 404）
  try {
    const result = await editPendingInput({
      tenantId: principal.tenantId,
      ownerUserId: principal.userIdentityId,
      pendingInputId,
      expectedVersionNo,
      input: body.input as PendingInputContent,
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

    return apiSuccess(responseBody, {
      status: 200,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(result.etag),
        [ETAG_HEADER]: `"${result.queue_etag}"`,
      },
    });
  } catch (err) {
    const errorResp = conversationErrorToResponse(err, requestId);
    if (errorResp) return errorResp;
    throw err;
  }
}

// ─── DELETE：移除 PendingInput ─────────────────────────────

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { pending_input_id: pendingInputId } = await context.params;

  // 1. 解析员工身份
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析 If-Match 资源 ETag（必填）
  const ifMatchRaw = parseIfMatch(request);
  if (!ifMatchRaw) {
    return schemaInvalidTable(requestId, "缺少必填头 If-Match（资源 ETag）");
  }

  let expectedVersionNo: number;
  try {
    expectedVersionNo = parsePendingInputEtag(ifMatchRaw);
  } catch {
    return schemaInvalidTable(requestId, `If-Match ETag 格式非法: ${ifMatchRaw}`);
  }

  // 3. 执行业务：事务内移除 + 写 Event（隐藏式 404）
  try {
    const result = await removePendingInput({
      tenantId: principal.tenantId,
      ownerUserId: principal.userIdentityId,
      pendingInputId,
      expectedVersionNo,
      correlationId: requestId,
    });

    const responseBody = {
      pending_input: {
        id: result.id,
        thread_id: result.thread_id,
        input_state: result.input_state,
        removed_at: result.removed_at,
      },
      queue_etag: result.queue_etag,
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
