import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
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
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
/**
 * POST /admin/api/v1/tools/{tool_id}/schema-revisions — 创建 ToolSchemaRevision
 * （阶段 6 S06-C02）。
 *
 * 事实源：阶段 6 Tool/Capability 模型（参考 skills/[skill_id]/versions/route.ts 模式）。
 *
 * 行为：
 * - 解析 admin 主体（SSO 管理员或 CI/CD Service Identity）。
 * - 校验 Tool 存在且属于当前租户（跨租户隐藏为 404）。
 * - 校验 action scope: tool.update + resource { type: "tool", id: tool_id }
 *   （创建 SchemaRevision 视为对 Tool 的修改操作；与 GET/PATCH /tools/{tool_id} 一致）。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验请求体（input_schema 必填为对象；output_schema / risk_metadata / description 可选）。
 * - 调用 createToolSchemaRevision 创建 draft SchemaRevision（仓储内分配 revisionNo + 计算 schemaHash）。
 * - completeRecord + 返回 201 + revision 投影。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - Tool 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 请求体非法 / input_schema 非对象 → 400 REQUEST_SCHEMA_INVALID
 * - Tool 已 retired → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - 并发 revisionNo 冲突 → 409 IDEMPOTENCY_CONFLICT
 */
import {
  ToolLifecycleError,
  ToolNotFoundError,
  type ToolRevisionState,
  ToolValidationError,
  ToolVersionConflictError,
  createToolSchemaRevision,
  getToolById,
  listToolSchemaRevisions,
} from "@/lib/capability/tool-queries";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ tool_id: string }>;
}

/** 请求体 schema（snake_case，与 OpenAPI requestBody 对齐）。 */
interface CreateToolSchemaRevisionBody {
  description?: string;
  input_schema: Record<string, unknown>;
  output_schema?: unknown;
  risk_metadata?: unknown;
}

/** 校验请求体。 */
function validateBody(body: unknown): body is CreateToolSchemaRevisionBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  // input_schema 必须为非空对象（不能是数组）
  if (
    typeof b.input_schema !== "object" ||
    b.input_schema === null ||
    Array.isArray(b.input_schema)
  ) {
    return false;
  }
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== "string") return false;
  }
  if (b.output_schema !== undefined && b.output_schema !== null) {
    if (typeof b.output_schema !== "object") return false;
  }
  if (b.risk_metadata !== undefined && b.risk_metadata !== null) {
    if (typeof b.risk_metadata !== "object") return false;
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

/** 从主体提取 createdBy（userIdentityId 或 serviceId）。 */
function createdByFromAdminPrincipal(principal: AdminPrincipal): string {
  if ("userIdentityId" in principal) {
    return principal.userIdentityId;
  }
  return principal.serviceId ?? principal.claims.tenantId;
}

/** 投影 ToolSchemaRevision 为响应体（snake_case）。 */
function projectRevision(revision: {
  id: string;
  toolId: string;
  revisionNo: number;
  description: string | null;
  inputSchemaJson: unknown;
  outputSchemaJson: unknown;
  schemaHash: string;
  riskMetadataJson: unknown;
  revisionState: string;
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
}): Record<string, unknown> {
  return {
    id: revision.id,
    tool_id: revision.toolId,
    revision_no: revision.revisionNo,
    description: revision.description,
    input_schema: revision.inputSchemaJson,
    output_schema: revision.outputSchemaJson,
    schema_hash: revision.schemaHash,
    risk_metadata: revision.riskMetadataJson,
    revision_state: revision.revisionState,
    created_by: revision.createdBy,
    created_at: revision.createdAt.toISOString(),
    published_at: revision.publishedAt?.toISOString() ?? null,
  };
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
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

  // 2. 校验 Tool 存在且属于当前租户（跨租户隐藏为 404，在 scope 校验前）
  const tool = await getToolById({ tenantId: principal.tenantId, toolId });
  if (!tool) {
    return resourceNotFound(requestId, `Tool 不存在或无权访问: ${toolId}`);
  }

  // 3. 校验 action scope：tool.update + resource { type: "tool", id: toolId }
  //    创建 SchemaRevision 视为对 Tool 的修改操作（与 PATCH /tools/{tool_id} 复用 scope）
  const scopeResult = await requireAdminActionScope(
    principal,
    "tool.update",
    { type: "tool", id: toolId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 4. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 5. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(
      requestId,
      "请求体非法：缺少 input_schema（必须为对象）或字段类型错误",
    );
  }

  // 6. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `tool.schema.create:${toolId}`;

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

  // 7. 执行业务：创建 draft ToolSchemaRevision
  try {
    const revision = await createToolSchemaRevision({
      tenantId: principal.tenantId,
      toolId,
      description: body.description ?? null,
      inputSchemaJson: body.input_schema,
      outputSchemaJson: body.output_schema ?? null,
      riskMetadataJson: body.risk_metadata ?? null,
      createdBy: createdByFromAdminPrincipal(principal),
    });

    const responseBody = projectRevision(revision);
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
      return apiError("IDEMPOTENCY_CONFLICT", err.message, { requestId });
    }
    throw err;
  }
}

/**
 * GET /admin/api/v1/tools/{tool_id}/schema-revisions — 列出 ToolSchemaRevision（S11-W03）。
 *
 * 事实源：阶段 6 Tool/Capability 模型（参考 agents/[agent_id]/revisions/route.ts GET 范式）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Tool 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 listToolSchemaRevisions 返回版本列表（按 revisionNo 降序）。
 * - 支持查询参数 state（draft / published / withdrawn）过滤、limit 分页（默认 100）。
 * - 投影为 snake_case + 每条附带 ETag（tool-schema-revision-{revisionNo}）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Tool 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */
const VALID_REVISION_STATES: readonly ToolRevisionState[] = ["draft", "published", "withdrawn"];

/** 投影 ToolSchemaRevision 为 GET 响应体（snake_case + etag，与 OpenAPI 契约一致）。 */
function projectRevisionForGet(revision: {
  id: string;
  toolId: string;
  revisionNo: number;
  description: string | null;
  inputSchemaJson: unknown;
  outputSchemaJson: unknown;
  schemaHash: string;
  riskMetadataJson: unknown;
  revisionState: string;
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
}): Record<string, unknown> {
  return {
    id: revision.id,
    tool_id: revision.toolId,
    revision_no: revision.revisionNo,
    revision_state: revision.revisionState,
    input_schema_json: revision.inputSchemaJson,
    output_schema_json: revision.outputSchemaJson,
    schema_hash: revision.schemaHash,
    risk_metadata_json: revision.riskMetadataJson,
    description: revision.description,
    created_by: revision.createdBy,
    published_at: revision.publishedAt?.toISOString() ?? null,
    created_at: revision.createdAt.toISOString(),
    etag: `tool-schema-revision-${revision.revisionNo}`,
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { tool_id: toolId } = await context.params;

  // 1. 解析 admin 主体
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Tool 存在且属于当前租户（跨租户隐藏为 404）
  const tool = await getToolById({ tenantId: principal.tenantId, toolId });
  if (!tool) {
    return resourceNotFound(requestId, `Tool 不存在或无权访问: ${toolId}`);
  }

  // 3. 解析查询参数 state / limit
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");
  const limitParam = url.searchParams.get("limit");

  const revisionStates: ToolRevisionState[] | undefined = stateParam
    ? (stateParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) =>
          (VALID_REVISION_STATES as readonly string[]).includes(s),
        ) as ToolRevisionState[])
    : undefined;

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }

  // 4. 查询 SchemaRevision 列表
  const revisions = await listToolSchemaRevisions({
    tenantId: principal.tenantId,
    toolId,
    revisionStates,
    limit,
  });
  const projected = revisions.map(projectRevisionForGet);

  return apiSuccess(
    { items: projected, total: projected.length },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}
