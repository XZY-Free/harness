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
  TOOL_ETAG_PREFIX,
  adminAuthErrorResponse,
  etagMismatchTable,
  parseToolEtag,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
/**
 * GET / PATCH /admin/api/v1/tools/{tool_id} — Tool 单资源（阶段 6 S06-C02）。
 *
 * 事实源：阶段 6 Tool/Capability 模型（参考 skills/[skill_id]/route.ts 模式）。
 *
 * 行为：
 * - GET：获取单个 Tool（含 currentSchemaRevision 摘要）。
 * - PATCH：更新 Tool 元数据（If-Match 必填 + ETag 校验）。
 *
 * ETag 前缀：`tool-{versionNo}`。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Tool 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - If-Match 缺失或格式非法 → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - ToolValidationError → 400 REQUEST_SCHEMA_INVALID
 * - ETag 不匹配 → 412 ETAG_MISMATCH
 * - ToolVersionConflictError → 412 ETAG_MISMATCH（乐观锁冲突）
 * - ToolLifecycleError → 422 BUSINESS_CONSTRAINT_VIOLATION
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
  getCurrentToolSchemaRevision,
  getToolById,
  updateTool,
} from "@/lib/capability/tool-queries";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ tool_id: string }>;
}

/** PATCH 请求体 schema。 */
interface PatchToolBody {
  display_name?: string;
  description?: string | null;
  risk_class?: ToolRiskClass;
  lifecycle_state?: ToolLifecycleState;
}

/** 校验 PATCH 请求体。 */
function validatePatchBody(body: unknown): body is PatchToolBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.display_name !== undefined) {
    if (typeof b.display_name !== "string" || b.display_name.length === 0) return false;
  }
  if (b.description !== undefined && b.description !== null && typeof b.description !== "string") {
    return false;
  }
  if (b.risk_class !== undefined) {
    if (typeof b.risk_class !== "string") return false;
    if (!(TOOL_RISK_CLASSES as readonly string[]).includes(b.risk_class)) return false;
  }
  if (b.lifecycle_state !== undefined) {
    if (typeof b.lifecycle_state !== "string") return false;
    if (!(TOOL_LIFECYCLE_STATES as readonly string[]).includes(b.lifecycle_state)) return false;
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

/** 投影 Tool 为响应体（snake_case + etag）。 */
function projectTool(tool: {
  id: string;
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

// ─── GET /admin/api/v1/tools/{tool_id} ────────────────────

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { tool_id: toolId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 校验 action scope: tool.update + resource { type: "tool", id: toolId }
  // GET 复用 tool.update 作为读权限（与 PATCH 一致）
  const scopeResult = await requireAdminActionScope(
    principal,
    "tool.update",
    { type: "tool", id: toolId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 校验 Tool 存在且属于当前租户
  const tool = await getToolById({ tenantId: principal.tenantId, toolId });
  if (!tool) {
    return resourceNotFound(requestId, `Tool 不存在或无权访问: ${toolId}`);
  }

  // 加载 currentSchemaRevision 摘要
  const currentRevision = await getCurrentToolSchemaRevision({
    tenantId: principal.tenantId,
    toolId,
  });

  const body = projectTool(tool);
  if (currentRevision) {
    body.current_schema_revision = {
      id: currentRevision.id,
      revision_no: currentRevision.revisionNo,
      schema_hash: currentRevision.schemaHash,
      revision_state: currentRevision.revisionState,
      published_at: currentRevision.publishedAt?.toISOString() ?? null,
    };
  } else {
    body.current_schema_revision = null;
  }

  return apiSuccess(body, {
    status: 200,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`${TOOL_ETAG_PREFIX}${tool.versionNo}`),
    },
  });
}

// ─── PATCH /admin/api/v1/tools/{tool_id} ──────────────────

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { tool_id: toolId } = await context.params;

  // 1. 解析身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析 If-Match（必填）→ Tool ETag
  const ifMatch = parseIfMatch(request);
  if (!ifMatch) {
    return schemaInvalidTable(requestId, "缺少必填头 If-Match");
  }
  let expectedVersionNo: number;
  try {
    expectedVersionNo = parseToolEtag(ifMatch);
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
      "请求体非法：display_name/description/risk_class/lifecycle_state 字段类型错误",
    );
  }

  // 5. 校验 Tool 存在且属于当前租户
  const tool = await getToolById({ tenantId: principal.tenantId, toolId });
  if (!tool) {
    return resourceNotFound(requestId, `Tool 不存在或无权访问: ${toolId}`);
  }

  // 6. 校验 action scope
  const scopeResult = await requireAdminActionScope(
    principal,
    "tool.update",
    { type: "tool", id: toolId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 7. 提前校验 ETag 与当前 versionNo 一致
  if (expectedVersionNo !== tool.versionNo) {
    return etagMismatchTable(
      requestId,
      `If-Match tool-${expectedVersionNo} 与当前 tool-${tool.versionNo} 不匹配`,
    );
  }

  // 8. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("PATCH", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `tool.update:${toolId}`;

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

  // 9. 执行业务：更新 Tool
  try {
    const updated = await updateTool({
      tenantId: principal.tenantId,
      toolId,
      displayName: body.display_name,
      description: body.description,
      riskClass: body.risk_class,
      lifecycleState: body.lifecycle_state,
      expectedVersionNo,
    });

    const responseBody = projectTool(updated);
    await completeRecord({
      recordId,
      httpStatus: 200,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 200,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`${TOOL_ETAG_PREFIX}${updated.versionNo}`),
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
