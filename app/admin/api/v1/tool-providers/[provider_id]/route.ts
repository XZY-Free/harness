import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  etagHeader,
  getRequestId,
  parseIfMatch,
  v11Error,
  v11NotFound,
  v11Ok,
} from "@/lib/http";
import {
  type AdminPrincipal,
  TOOL_PROVIDER_ETAG_PREFIX,
  adminAuthErrorResponse,
  parseToolProviderEtag,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11EtagMismatch,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
/**
 * GET / PATCH /admin/api/v1/tool-providers/{provider_id} — ToolProvider 单资源（阶段 6 S06-C02）。
 *
 * 事实源：阶段 6 Tool/Capability 模型（参考 skills/[skill_id]/route.ts 模式）。
 *
 * 行为：
 * - GET：获取单个 ToolProvider。
 * - PATCH：更新 ToolProvider 元数据（If-Match 必填 + ETag 校验）。
 *
 * ETag 前缀：`tool-provider-{versionNo}`。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - ToolProvider 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - If-Match 缺失或格式非法 → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - ToolValidationError → 400 REQUEST_SCHEMA_INVALID
 * - ETag 不匹配 → 412 ETAG_MISMATCH
 * - ToolVersionConflictError → 412 ETAG_MISMATCH（乐观锁冲突）
 * - ToolLifecycleError → 422 BUSINESS_CONSTRAINT_VIOLATION
 */
import {
  TOOL_PROVIDER_LIFECYCLE_STATES,
  TOOL_PROVIDER_TRUST_LEVELS,
  ToolLifecycleError,
  ToolNotFoundError,
  type ToolProviderLifecycleState,
  type ToolProviderTrustLevel,
  ToolValidationError,
  ToolVersionConflictError,
  getToolProviderById,
  updateToolProvider,
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

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ provider_id: string }>;
}

/** PATCH 请求体 schema。 */
interface PatchToolProviderBody {
  display_name?: string;
  description?: string | null;
  trust_level?: ToolProviderTrustLevel;
  connection_id?: string | null;
  lifecycle_state?: ToolProviderLifecycleState;
}

/** 校验 PATCH 请求体。 */
function validatePatchBody(body: unknown): body is PatchToolProviderBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.display_name !== undefined) {
    if (typeof b.display_name !== "string" || b.display_name.length === 0) return false;
  }
  if (b.description !== undefined && b.description !== null && typeof b.description !== "string") {
    return false;
  }
  if (b.trust_level !== undefined) {
    if (typeof b.trust_level !== "string") return false;
    if (!(TOOL_PROVIDER_TRUST_LEVELS as readonly string[]).includes(b.trust_level)) return false;
  }
  if (b.connection_id !== undefined && b.connection_id !== null) {
    if (typeof b.connection_id !== "string" || b.connection_id.length === 0) return false;
  }
  if (b.lifecycle_state !== undefined) {
    if (typeof b.lifecycle_state !== "string") return false;
    if (!(TOOL_PROVIDER_LIFECYCLE_STATES as readonly string[]).includes(b.lifecycle_state))
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

/** 投影 ToolProvider 为响应体（snake_case + etag）。 */
function projectProvider(p: {
  id: string;
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

// ─── GET /admin/api/v1/tool-providers/{provider_id} ───────

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { provider_id: providerId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 校验 action scope: tool.provider.update + resource { type: "provider", id: providerId }
  // GET 复用 tool.provider.update 作为读权限（与 PATCH 一致）
  const scopeResult = await requireAdminActionScope(
    principal,
    "tool.provider.update",
    { type: "provider", id: providerId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 校验 ToolProvider 存在且属于当前租户
  const provider = await getToolProviderById({ tenantId: principal.tenantId, providerId });
  if (!provider) {
    return v11NotFound(requestId, `ToolProvider 不存在或无权访问: ${providerId}`);
  }

  return v11Ok(projectProvider(provider), {
    status: 200,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`${TOOL_PROVIDER_ETAG_PREFIX}${provider.versionNo}`),
    },
  });
}

// ─── PATCH /admin/api/v1/tool-providers/{provider_id} ─────

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { provider_id: providerId } = await context.params;

  // 1. 解析身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析 If-Match（必填）→ ToolProvider ETag
  const ifMatch = parseIfMatch(request);
  if (!ifMatch) {
    return v11SchemaInvalid(requestId, "缺少必填头 If-Match");
  }
  let expectedVersionNo: number;
  try {
    expectedVersionNo = parseToolProviderEtag(ifMatch);
  } catch (err) {
    return v11SchemaInvalid(
      requestId,
      err instanceof Error ? err.message : "If-Match ETag 格式非法",
    );
  }

  // 3. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validatePatchBody(body)) {
    return v11SchemaInvalid(
      requestId,
      "请求体非法：display_name/description/trust_level/connection_id/lifecycle_state 字段类型错误",
    );
  }

  // 5. 校验 ToolProvider 存在且属于当前租户
  const provider = await getToolProviderById({ tenantId: principal.tenantId, providerId });
  if (!provider) {
    return v11NotFound(requestId, `ToolProvider 不存在或无权访问: ${providerId}`);
  }

  // 6. 校验 action scope
  const scopeResult = await requireAdminActionScope(
    principal,
    "tool.provider.update",
    { type: "provider", id: providerId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 7. 提前校验 ETag 与当前 versionNo 一致
  if (expectedVersionNo !== provider.versionNo) {
    return v11EtagMismatch(
      requestId,
      `If-Match tool-provider-${expectedVersionNo} 与当前 tool-provider-${provider.versionNo} 不匹配`,
    );
  }

  // 8. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("PATCH", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `tool.provider.update:${providerId}`;

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

  // 9. 执行业务：更新 ToolProvider
  try {
    const updated = await updateToolProvider({
      tenantId: principal.tenantId,
      providerId,
      displayName: body.display_name,
      description: body.description,
      trustLevel: body.trust_level,
      connectionId: body.connection_id,
      lifecycleState: body.lifecycle_state,
      expectedVersionNo,
    });

    const responseBody = projectProvider(updated);
    await completeRecord({
      recordId,
      httpStatus: 200,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return v11Ok(responseBody, {
      status: 200,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`${TOOL_PROVIDER_ETAG_PREFIX}${updated.versionNo}`),
      },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof ToolNotFoundError) {
      return v11NotFound(requestId, err.message);
    }
    if (err instanceof ToolValidationError) {
      return v11SchemaInvalid(requestId, err.message);
    }
    if (err instanceof ToolLifecycleError) {
      return v11Error("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    if (err instanceof ToolVersionConflictError) {
      return v11EtagMismatch(requestId, err.message);
    }
    throw err;
  }
}
