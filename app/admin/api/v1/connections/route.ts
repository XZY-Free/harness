import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  etagHeader,
  getRequestId,
  v11Error,
  v11Ok,
} from "@/lib/http";
import {
  type AdminPrincipal,
  CONNECTION_ETAG_PREFIX,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
/**
 * GET / POST /admin/api/v1/connections — Connection 集合（阶段 6 S06-C02）。
 *
 * 事实源：阶段 6 Tool/Capability 模型（参考 skills/route.ts 模式）。
 *
 * 行为：
 * - GET：列出 Connection（分页 + lifecycle 过滤）。
 * - POST：创建 Connection（Idempotency-Key 必填，返回 201 + ETag）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - ToolValidationError → 400 REQUEST_SCHEMA_INVALID
 * - ToolVersionConflictError → 409 IDEMPOTENCY_CONFLICT
 */
import {
  CONNECTION_AUTH_METHODS,
  CONNECTION_LIFECYCLE_STATES,
  CONNECTION_TYPES,
  type ConnectionLifecycleState,
  type ConnectionType,
  ToolValidationError,
  ToolVersionConflictError,
  createConnection,
  listConnections,
} from "@/lib/v11/capability/tool-queries";
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
} from "@/lib/v11/identity/idempotency";

export const dynamic = "force-dynamic";

/** 请求体 schema（与 OpenAPI requestBody 对齐）。 */
interface CreateConnectionBody {
  connection_key: string;
  connection_type: ConnectionType;
  endpoint_ref?: string;
  auth_method?: (typeof CONNECTION_AUTH_METHODS)[number];
  owner_user_id: string;
}

/** 校验请求体。 */
function validateBody(body: unknown): body is CreateConnectionBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.connection_key !== "string" || b.connection_key.length === 0) return false;
  if (typeof b.connection_type !== "string") return false;
  if (!(CONNECTION_TYPES as readonly string[]).includes(b.connection_type)) return false;
  if (typeof b.owner_user_id !== "string" || b.owner_user_id.length === 0) return false;
  if (b.auth_method !== undefined) {
    if (typeof b.auth_method !== "string") return false;
    if (!(CONNECTION_AUTH_METHODS as readonly string[]).includes(b.auth_method)) return false;
  }
  if (b.endpoint_ref !== undefined && typeof b.endpoint_ref !== "string") return false;
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
  tenantId: string;
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

// ─── GET /admin/api/v1/connections ────────────────────────

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // GET 使用 connection.create tenant 级 scope 校验（与 POST 一致，简化权限模型）
  const scopeResult = await requireAdminActionScope(
    principal,
    "connection.create",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 解析查询参数
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const lifecycleParam = url.searchParams.get("lifecycle_state");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  const lifecycleStates: ConnectionLifecycleState[] | undefined = lifecycleParam
    ? (lifecycleParam
        .split(",")
        .filter((s) =>
          (CONNECTION_LIFECYCLE_STATES as readonly string[]).includes(s),
        ) as ConnectionLifecycleState[])
    : undefined;

  const { items, nextCursor } = await listConnections({
    tenantId: principal.tenantId,
    lifecycleStates,
    limit,
    cursor: cursor ?? null,
  });

  return v11Ok(
    {
      items: items.map(projectConnection),
      next_cursor: nextCursor,
    },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}

// ─── POST /admin/api/v1/connections ───────────────────────

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 action scope（tenant 级创建）
  const scopeResult = await requireAdminActionScope(
    principal,
    "connection.create",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 3. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return v11SchemaInvalid(
      requestId,
      "请求体非法：缺少 connection_key/connection_type/owner_user_id 或字段类型错误",
    );
  }

  // 5. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = "connection.create";

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

  // 6. 执行业务：创建 Connection
  try {
    const conn = await createConnection({
      tenantId: principal.tenantId,
      connectionKey: body.connection_key,
      connectionType: body.connection_type,
      endpointRef: body.endpoint_ref ?? null,
      authMethod: body.auth_method,
      ownerUserId: body.owner_user_id,
    });

    const responseBody = projectConnection(conn);
    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return v11Ok(responseBody, {
      status: 201,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`${CONNECTION_ETAG_PREFIX}${conn.versionNo}`),
      },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof ToolValidationError) {
      return v11SchemaInvalid(requestId, err.message);
    }
    if (err instanceof ToolVersionConflictError) {
      return v11Error("IDEMPOTENCY_CONFLICT", err.message, { requestId });
    }
    throw err;
  }
}
