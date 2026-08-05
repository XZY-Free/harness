import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  etagHeader,
  getRequestId,
  apiError,
  resourceNotFound,
  apiSuccess,
} from "@/lib/http";
import {
  type AdminPrincipal,
  TOOL_ETAG_PREFIX,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
/**
 * GET / POST /admin/api/v1/tools — Tool 集合（阶段 6 S06-C02）。
 *
 * 事实源：阶段 6 Tool/Capability 模型（参考 skills/route.ts 模式）。
 *
 * 行为：
 * - GET：列出 Tool（分页 + providerId / lifecycle / riskClass 过滤）。
 * - POST：创建 Tool（Idempotency-Key 必填，返回 201 + ETag）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - ToolValidationError → 400 REQUEST_SCHEMA_INVALID
 * - ToolVersionConflictError → 409 IDEMPOTENCY_CONFLICT
 * - ToolNotFoundError（provider 不存在/跨租户）→ 404 RESOURCE_NOT_FOUND
 */
import {
  TOOL_LIFECYCLE_STATES,
  TOOL_RISK_CLASSES,
  ToolLifecycleError,
  type ToolLifecycleState,
  ToolNotFoundError,
  type ToolRiskClass,
  ToolValidationError,
  ToolVersionConflictError,
  createTool,
  getToolProviderById,
  listTools,
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
} from "@/lib/identity/idempotency";

export const dynamic = "force-dynamic";

/** 请求体 schema（与 OpenAPI requestBody 对齐）。 */
interface CreateToolBody {
  provider_id: string;
  tool_key: string;
  display_name: string;
  description?: string;
  risk_class?: ToolRiskClass;
}

/** 校验请求体。 */
function validateBody(body: unknown): body is CreateToolBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.provider_id !== "string" || b.provider_id.length === 0) return false;
  if (typeof b.tool_key !== "string" || b.tool_key.length === 0) return false;
  if (typeof b.display_name !== "string" || b.display_name.length === 0) return false;
  if (b.risk_class !== undefined) {
    if (typeof b.risk_class !== "string") return false;
    if (!(TOOL_RISK_CLASSES as readonly string[]).includes(b.risk_class)) return false;
  }
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

/** 投影 Tool 为响应体（snake_case + etag）。 */
function projectTool(tool: {
  id: string;
  tenantId: string;
  providerId: string;
  toolKey: string;
  displayName: string;
  description: string | null;
  riskClass: string;
  currentSchemaRevisionId: string | null;
  lifecycleState: string;
  versionNo: number;
  createdAt: Date;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: tool.id,
    provider_id: tool.providerId,
    tool_key: tool.toolKey,
    display_name: tool.displayName,
    description: tool.description,
    risk_class: tool.riskClass,
    current_schema_revision_id: tool.currentSchemaRevisionId,
    lifecycle_state: tool.lifecycleState,
    version_no: tool.versionNo,
    created_at: tool.createdAt.toISOString(),
    updated_at: tool.updatedAt.toISOString(),
    etag: `${TOOL_ETAG_PREFIX}${tool.versionNo}`,
  };
}

// ─── GET /admin/api/v1/tools ──────────────────────────────

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

  // 解析查询参数
  const url = new URL(request.url);
  const providerIdParam = url.searchParams.get("provider_id");

  // tool.create action code 允许 ["provider", "tool"]，必须按 provider 资源做 scope 校验
  // 因此 GET /tools 必须提供 provider_id（与权限模型对齐）
  if (!providerIdParam) {
    return v11SchemaInvalid(requestId, "缺少必填查询参数 provider_id");
  }

  // 校验 ToolProvider 存在且属于当前租户
  const provider = await getToolProviderById({
    tenantId: principal.tenantId,
    providerId: providerIdParam,
  });
  if (!provider) {
    return resourceNotFound(requestId, `ToolProvider 不存在或无权访问: ${providerIdParam}`);
  }

  // 校验 action scope：tool.create + resource { type: "provider", id: providerId }
  // GET 复用 tool.create 作为读权限（与 POST 一致）
  const scopeResult = await requireAdminActionScope(
    principal,
    "tool.create",
    { type: "provider", id: providerIdParam },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const lifecycleParam = url.searchParams.get("lifecycle_state");
  const riskClassParam = url.searchParams.get("risk_class");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  const lifecycleStates: ToolLifecycleState[] | undefined = lifecycleParam
    ? (lifecycleParam
        .split(",")
        .filter((s) =>
          (TOOL_LIFECYCLE_STATES as readonly string[]).includes(s),
        ) as ToolLifecycleState[])
    : undefined;
  const riskClasses: ToolRiskClass[] | undefined = riskClassParam
    ? (riskClassParam
        .split(",")
        .filter((s) => (TOOL_RISK_CLASSES as readonly string[]).includes(s)) as ToolRiskClass[])
    : undefined;

  const { items, nextCursor } = await listTools({
    tenantId: principal.tenantId,
    providerId: providerIdParam,
    lifecycleStates,
    riskClasses,
    limit,
    cursor: cursor ?? null,
  });

  return apiSuccess(
    {
      items: items.map(projectTool),
      next_cursor: nextCursor,
    },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}

// ─── POST /admin/api/v1/tools ─────────────────────────────

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

  // 2. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  // 3. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return v11SchemaInvalid(
      requestId,
      "请求体非法：缺少 provider_id/tool_key/display_name 或字段类型错误",
    );
  }

  // 4. 校验 ToolProvider 存在且属于当前租户（在 scope 校验前给出 404）
  const provider = await getToolProviderById({
    tenantId: principal.tenantId,
    providerId: body.provider_id,
  });
  if (!provider) {
    return resourceNotFound(requestId, `ToolProvider 不存在或无权访问: ${body.provider_id}`);
  }

  // 5. 校验 action scope：tool.create + resource { type: "provider", id: providerId }
  const scopeResult = await requireAdminActionScope(
    principal,
    "tool.create",
    { type: "provider", id: body.provider_id },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 6. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `tool.create:${body.provider_id}`;

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

  // 7. 执行业务：创建 Tool
  try {
    const tool = await createTool({
      tenantId: principal.tenantId,
      providerId: body.provider_id,
      toolKey: body.tool_key,
      displayName: body.display_name,
      description: body.description ?? null,
      riskClass: body.risk_class,
    });

    const responseBody = projectTool(tool);
    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 201,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`${TOOL_ETAG_PREFIX}${tool.versionNo}`),
      },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof ToolNotFoundError) {
      return resourceNotFound(requestId, err.message);
    }
    if (err instanceof ToolValidationError) {
      return v11SchemaInvalid(requestId, err.message);
    }
    if (err instanceof ToolLifecycleError) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    if (err instanceof ToolVersionConflictError) {
      return apiError("IDEMPOTENCY_CONFLICT", err.message, { requestId });
    }
    throw err;
  }
}
