import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  etagHeader,
  getRequestId,
  parseIfMatch,
  resourceNotFound,
} from "@/lib/http";
import {
  buildIdempotencyErrorResponse,
  buildReplayResponse,
  callerFromPrincipal,
  callerFromWorkloadPrincipal,
  completeRecord,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/identity/idempotency";
import {
  type AdminPrincipal,
  CONNECTION_ETAG_PREFIX,
  adminAuthErrorResponse,
  etagMismatchTable,
  parseConnectionEtag,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/v11/admin/route-helpers";
/**
 * GET / PATCH /admin/api/v1/connections/{connection_id} — Connection 单资源（阶段 6 S06-C02）。
 *
 * 事实源：阶段 6 Tool/Capability 模型（参考 skills/[skill_id]/route.ts 模式）。
 *
 * 行为：
 * - GET：获取单个 Connection。
 * - PATCH：更新 Connection 元数据（If-Match 必填 + ETag 校验）。
 *
 * ETag 前缀：`connection-{versionNo}`。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Connection 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - If-Match 缺失或格式非法 → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - ToolValidationError → 400 REQUEST_SCHEMA_INVALID
 * - ETag 不匹配 → 412 ETAG_MISMATCH
 * - ToolVersionConflictError → 412 ETAG_MISMATCH（乐观锁冲突）
 * - ToolLifecycleError → 422 BUSINESS_CONSTRAINT_VIOLATION
 */
import {
  CONNECTION_AUTH_METHODS,
  CONNECTION_LIFECYCLE_STATES,
  type ConnectionAuthMethod,
  type ConnectionLifecycleState,
  ToolLifecycleError,
  ToolNotFoundError,
  ToolValidationError,
  ToolVersionConflictError,
  getConnectionById,
  updateConnection,
} from "@/lib/v11/capability/tool-queries";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ connection_id: string }>;
}

/** PATCH 请求体 schema。 */
interface PatchConnectionBody {
  endpoint_ref?: string | null;
  auth_method?: ConnectionAuthMethod;
  lifecycle_state?: ConnectionLifecycleState;
}

/** 校验 PATCH 请求体。 */
function validatePatchBody(body: unknown): body is PatchConnectionBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.endpoint_ref !== undefined && b.endpoint_ref !== null) {
    if (typeof b.endpoint_ref !== "string" || b.endpoint_ref.length === 0) return false;
  }
  if (b.auth_method !== undefined) {
    if (typeof b.auth_method !== "string") return false;
    if (!(CONNECTION_AUTH_METHODS as readonly string[]).includes(b.auth_method)) return false;
  }
  if (b.lifecycle_state !== undefined) {
    if (typeof b.lifecycle_state !== "string") return false;
    if (!(CONNECTION_LIFECYCLE_STATES as readonly string[]).includes(b.lifecycle_state))
      return false;
  }
  return true;
}

/** 从主体提取幂等 caller。 */
function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) {
    return callerFromPrincipal(principal);
  }
  return callerFromWorkloadPrincipal(principal);
}

/** 投影 Connection 为响应体（snake_case + etag）。 */
function projectConnection(conn: {
  id: string;
  connectionKey: string;
  connectionType: string;
  endpointRef: string | null;
  authMethod: string;
  ownerUserId: string;
  lifecycleState: string;
  versionNo: number;
  createdAt: Date;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: conn.id,
    connection_key: conn.connectionKey,
    connection_type: conn.connectionType,
    endpoint_ref: conn.endpointRef,
    auth_method: conn.authMethod,
    owner_user_id: conn.ownerUserId,
    lifecycle_state: conn.lifecycleState,
    version_no: conn.versionNo,
    created_at: conn.createdAt.toISOString(),
    updated_at: conn.updatedAt.toISOString(),
    etag: `${CONNECTION_ETAG_PREFIX}${conn.versionNo}`,
  };
}

// ─── GET /admin/api/v1/connections/{connection_id} ────────

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { connection_id: connectionId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 校验 action scope: connection.update + resource { type: "connection", id: connection_id }
  // GET 复用 connection.update 作为读权限（与 PATCH 一致，简化权限模型）
  const scopeResult = await requireAdminActionScope(
    principal,
    "connection.update",
    { type: "connection", id: connectionId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 校验 Connection 存在且属于当前租户
  const conn = await getConnectionById({ tenantId: principal.tenantId, connectionId });
  if (!conn) {
    return resourceNotFound(requestId, `Connection 不存在或无权访问: ${connectionId}`);
  }

  return apiSuccess(projectConnection(conn), {
    status: 200,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`${CONNECTION_ETAG_PREFIX}${conn.versionNo}`),
    },
  });
}

// ─── PATCH /admin/api/v1/connections/{connection_id} ──────

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { connection_id: connectionId } = await context.params;

  // 1. 解析身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析 If-Match（必填）→ Connection ETag
  const ifMatch = parseIfMatch(request);
  if (!ifMatch) {
    return schemaInvalidTable(requestId, "缺少必填头 If-Match");
  }
  let expectedVersionNo: number;
  try {
    expectedVersionNo = parseConnectionEtag(ifMatch);
  } catch (err) {
    return schemaInvalidTable(
      requestId,
      err instanceof Error ? err.message : "If-Match ETag 格式非法",
    );
  }

  // 3. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validatePatchBody(body)) {
    return schemaInvalidTable(
      requestId,
      "请求体非法：endpoint_ref/auth_method/lifecycle_state 字段类型错误",
    );
  }

  // 5. 校验 Connection 存在且属于当前租户
  const conn = await getConnectionById({ tenantId: principal.tenantId, connectionId });
  if (!conn) {
    return resourceNotFound(requestId, `Connection 不存在或无权访问: ${connectionId}`);
  }

  // 6. 校验 action scope: connection.update + resource { type: "connection", id: connectionId }
  const scopeResult = await requireAdminActionScope(
    principal,
    "connection.update",
    { type: "connection", id: connectionId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 7. 提前校验 ETag 与当前 versionNo 一致
  if (expectedVersionNo !== conn.versionNo) {
    return etagMismatchTable(
      requestId,
      `If-Match connection-${expectedVersionNo} 与当前 connection-${conn.versionNo} 不匹配`,
    );
  }

  // 8. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("PATCH", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `connection.update:${connectionId}`;

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

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

  // 9. 执行业务：更新 Connection
  try {
    const updated = await updateConnection({
      tenantId: principal.tenantId,
      connectionId,
      endpointRef: body.endpoint_ref,
      authMethod: body.auth_method,
      lifecycleState: body.lifecycle_state,
      expectedVersionNo,
    });

    const responseBody = projectConnection(updated);
    await completeRecord({
      recordId,
      httpStatus: 200,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 200,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`${CONNECTION_ETAG_PREFIX}${updated.versionNo}`),
      },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof ToolNotFoundError) {
      return resourceNotFound(requestId, err.message);
    }
    if (err instanceof ToolValidationError) {
      return schemaInvalidTable(requestId, err.message);
    }
    if (err instanceof ToolLifecycleError) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    if (err instanceof ToolVersionConflictError) {
      return etagMismatchTable(requestId, err.message);
    }
    throw err;
  }
}
