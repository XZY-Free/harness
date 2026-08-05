import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  etagHeader,
  getRequestId,
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
  TOOL_PROVIDER_ETAG_PREFIX,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/v11/admin/route-helpers";
/**
 * GET / POST /admin/api/v1/tool-providers — ToolProvider 集合（阶段 6 S06-C02）。
 *
 * 事实源：阶段 6 Tool/Capability 模型（参考 skills/route.ts 模式）。
 *
 * 行为：
 * - GET：列出 ToolProvider（分页 + providerType / lifecycle 过滤）。
 * - POST：创建 ToolProvider（Idempotency-Key 必填，返回 201 + ETag）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - ToolValidationError → 400 REQUEST_SCHEMA_INVALID
 * - ToolVersionConflictError → 409 IDEMPOTENCY_CONFLICT
 */
import {
  TOOL_PROVIDER_LIFECYCLE_STATES,
  TOOL_PROVIDER_TRUST_LEVELS,
  TOOL_PROVIDER_TYPES,
  type ToolProviderLifecycleState,
  type ToolProviderTrustLevel,
  type ToolProviderType,
  ToolValidationError,
  ToolVersionConflictError,
  createToolProvider,
  listToolProviders,
} from "@/lib/v11/capability/tool-queries";

export const dynamic = "force-dynamic";

/** 请求体 schema（与 OpenAPI requestBody 对齐）。 */
interface CreateToolProviderBody {
  provider_key: string;
  provider_type: ToolProviderType;
  connection_id?: string;
  trust_level?: ToolProviderTrustLevel;
  display_name: string;
  description?: string;
  owner_user_id: string;
}

/** 校验请求体。 */
function validateBody(body: unknown): body is CreateToolProviderBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.provider_key !== "string" || b.provider_key.length === 0) return false;
  if (typeof b.provider_type !== "string") return false;
  if (!(TOOL_PROVIDER_TYPES as readonly string[]).includes(b.provider_type)) return false;
  if (typeof b.display_name !== "string" || b.display_name.length === 0) return false;
  if (typeof b.owner_user_id !== "string" || b.owner_user_id.length === 0) return false;
  if (b.trust_level !== undefined) {
    if (typeof b.trust_level !== "string") return false;
    if (!(TOOL_PROVIDER_TRUST_LEVELS as readonly string[]).includes(b.trust_level)) return false;
  }
  if (b.connection_id !== undefined && typeof b.connection_id !== "string") return false;
  if (b.description !== undefined && typeof b.description !== "string") return false;
  return true;
}

/** 从主体提取幂等 caller。 */
function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) {
    return callerFromPrincipal(principal);
  }
  return callerFromWorkloadPrincipal(principal);
}

/** 投影 ToolProvider 为响应体（snake_case + etag）。 */
function projectProvider(p: {
  id: string;
  tenantId: string;
  providerKey: string;
  providerType: string;
  connectionId: string | null;
  trustLevel: string;
  displayName: string;
  description: string | null;
  ownerUserId: string;
  lifecycleState: string;
  versionNo: number;
  createdAt: Date;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: p.id,
    provider_key: p.providerKey,
    provider_type: p.providerType,
    connection_id: p.connectionId,
    trust_level: p.trustLevel,
    display_name: p.displayName,
    description: p.description,
    owner_user_id: p.ownerUserId,
    lifecycle_state: p.lifecycleState,
    version_no: p.versionNo,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
    etag: `${TOOL_PROVIDER_ETAG_PREFIX}${p.versionNo}`,
  };
}

// ─── GET /admin/api/v1/tool-providers ─────────────────────

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

  // GET 使用 tool.provider.create tenant 级 scope 校验（与 POST 一致）
  const scopeResult = await requireAdminActionScope(
    principal,
    "tool.provider.create",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 解析查询参数
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const providerTypeParam = url.searchParams.get("provider_type");
  const lifecycleParam = url.searchParams.get("lifecycle_state");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }

  const providerTypes: ToolProviderType[] | undefined = providerTypeParam
    ? (providerTypeParam
        .split(",")
        .filter((s) =>
          (TOOL_PROVIDER_TYPES as readonly string[]).includes(s),
        ) as ToolProviderType[])
    : undefined;
  const lifecycleStates: ToolProviderLifecycleState[] | undefined = lifecycleParam
    ? (lifecycleParam
        .split(",")
        .filter((s) =>
          (TOOL_PROVIDER_LIFECYCLE_STATES as readonly string[]).includes(s),
        ) as ToolProviderLifecycleState[])
    : undefined;

  const { items, nextCursor } = await listToolProviders({
    tenantId: principal.tenantId,
    providerTypes,
    lifecycleStates,
    limit,
    cursor: cursor ?? null,
  });

  return apiSuccess(
    {
      items: items.map(projectProvider),
      next_cursor: nextCursor,
    },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}

// ─── POST /admin/api/v1/tool-providers ────────────────────

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
    "tool.provider.create",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

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
      "请求体非法：缺少 provider_key/provider_type/display_name/owner_user_id 或字段类型错误",
    );
  }

  // 5. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = "tool.provider.create";

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

  // 6. 执行业务：创建 ToolProvider
  try {
    const provider = await createToolProvider({
      tenantId: principal.tenantId,
      providerKey: body.provider_key,
      providerType: body.provider_type,
      connectionId: body.connection_id ?? null,
      trustLevel: body.trust_level,
      displayName: body.display_name,
      description: body.description ?? null,
      ownerUserId: body.owner_user_id,
    });

    const responseBody = projectProvider(provider);
    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 201,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`${TOOL_PROVIDER_ETAG_PREFIX}${provider.versionNo}`),
      },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof ToolValidationError) {
      return schemaInvalidTable(requestId, err.message);
    }
    if (err instanceof ToolVersionConflictError) {
      return apiError("IDEMPOTENCY_CONFLICT", err.message, { requestId });
    }
    throw err;
  }
}
