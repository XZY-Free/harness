import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  getRequestId,
  apiError,
  resourceNotFound,
  apiSuccess,
} from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
/**
 * POST /admin/api/v1/skills/{skill_id}/versions — 创建 SkillVersion（阶段 6 S06-C01）。
 *
 * 事实源：阶段 6 Skill/Capability 模型（参考 agents/[agent_id]/revisions/route.ts 模式）。
 *
 * 行为：
 * - 解析 admin 主体（SSO 管理员或 CI/CD Service Identity）。
 * - 校验 action scope: skill.version.create + resource { type: "skill", id: skill_id }。
 * - 校验 Idempotency-Key（必填）+ computeRequestHash → enforceIdempotency。
 * - 校验 Skill 存在且属于当前租户（跨租户隐藏为 404）。
 * - 校验请求体（content_ref/content_hash/manifest/source_type/source_ref）。
 * - 调用 createSkillVersion 创建 draft SkillVersion。
 * - completeRecord + 返回 201 + version 投影 + ETag。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - Skill 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 请求体非法 / contentHash 格式 → 400 REQUEST_SCHEMA_INVALID
 * - Skill 已 retired → 422 BUSINESS_CONSTRAINT_VIOLATION
 */
import {
  SkillLifecycleError,
  SkillNotFoundError,
  type SkillRevisionState,
  SkillValidationError,
  SkillVersionConflictError,
  createSkillVersion,
  getSkillById,
  listSkillVersions,
} from "@/lib/v11/capability/skill-queries";
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

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ skill_id: string }>;
}

/** 请求体 schema。 */
interface CreateSkillVersionBody {
  content_ref: string;
  content_hash: string;
  manifest?: Record<string, unknown>;
  source_type?: "local" | "capability_market" | "external";
  source_ref?: string;
}

/** 校验请求体。 */
function validateBody(body: unknown): body is CreateSkillVersionBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.content_ref !== "string" || b.content_ref.length === 0) return false;
  if (typeof b.content_hash !== "string" || b.content_hash.length === 0) return false;
  if (b.source_type !== undefined) {
    if (typeof b.source_type !== "string") return false;
    if (!["local", "capability_market", "external"].includes(b.source_type)) return false;
  }
  if (b.source_ref !== undefined && typeof b.source_ref !== "string") return false;
  if (b.manifest !== undefined && (typeof b.manifest !== "object" || b.manifest === null)) {
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

/** 从主体提取 createdBy（userIdentityId 或 serviceId）。 */
function createdByFromAdminPrincipal(principal: AdminPrincipal): string {
  if ("userIdentityId" in principal) {
    return principal.userIdentityId;
  }
  return principal.serviceId ?? principal.claims.tenantId;
}

/** 投影 SkillVersion 为响应体（snake_case）。 */
function projectVersion(version: {
  id: string;
  skillId: string;
  versionNo: number;
  contentRef: string;
  contentHash: string;
  manifestJson: unknown;
  revisionState: string;
  sourceType: string;
  sourceRef: string | null;
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
}): Record<string, unknown> {
  return {
    id: version.id,
    skill_id: version.skillId,
    version_no: version.versionNo,
    content_ref: version.contentRef,
    content_hash: version.contentHash,
    manifest: version.manifestJson,
    revision_state: version.revisionState,
    source_type: version.sourceType,
    source_ref: version.sourceRef,
    created_by: version.createdBy,
    created_at: version.createdAt.toISOString(),
    published_at: version.publishedAt?.toISOString() ?? null,
  };
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { skill_id: skillId } = await context.params;

  // 1. 解析身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 action scope
  const scopeResult = await requireAdminActionScope(
    principal,
    "skill.version.create",
    { type: "skill", id: skillId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 3. 校验 Skill 存在且属于当前租户（跨租户隐藏为 404）
  const skill = await getSkillById({ tenantId: principal.tenantId, skillId });
  if (!skill) {
    return resourceNotFound(requestId, `Skill 不存在或无权访问: ${skillId}`);
  }

  // 4. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  // 5. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return v11SchemaInvalid(requestId, "请求体非法：缺少 content_ref/content_hash 或字段类型错误");
  }

  // 6. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `skill.version.create:${skillId}`;

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

  // 7. 执行业务：创建 draft SkillVersion
  try {
    const version = await createSkillVersion({
      tenantId: principal.tenantId,
      skillId,
      contentRef: body.content_ref,
      contentHash: body.content_hash,
      manifestJson: body.manifest,
      sourceType: body.source_type,
      sourceRef: body.source_ref,
      createdBy: createdByFromAdminPrincipal(principal),
    });

    const responseBody = projectVersion(version);
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

    if (err instanceof SkillNotFoundError) {
      return resourceNotFound(requestId, err.message);
    }
    if (err instanceof SkillValidationError) {
      return v11SchemaInvalid(requestId, err.message);
    }
    if (err instanceof SkillLifecycleError) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    if (err instanceof SkillVersionConflictError) {
      return apiError("IDEMPOTENCY_CONFLICT", err.message, { requestId });
    }
    throw err;
  }
}

/**
 * GET /admin/api/v1/skills/{skill_id}/versions — 列出 SkillVersion（S11-W03）。
 *
 * 事实源：阶段 6 Skill/Capability 模型（参考 agents/[agent_id]/revisions/route.ts GET 范式）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Skill 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 listSkillVersions 返回版本列表（按 versionNo 降序）。
 * - 支持查询参数 state（draft / published / withdrawn）过滤、limit 分页（默认 100）。
 * - 投影为 snake_case + 每条附带 ETag（skill-version-{versionNo}）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Skill 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */
const VALID_REVISION_STATES: readonly SkillRevisionState[] = ["draft", "published", "withdrawn"];

/** 投影 SkillVersion 为 GET 响应体（snake_case + etag，与 OpenAPI 契约一致）。 */
function projectVersionForGet(version: {
  id: string;
  skillId: string;
  versionNo: number;
  contentRef: string;
  contentHash: string;
  manifestJson: unknown;
  revisionState: string;
  sourceType: string;
  sourceRef: string | null;
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
}): Record<string, unknown> {
  return {
    id: version.id,
    skill_id: version.skillId,
    version_no: version.versionNo,
    revision_state: version.revisionState,
    content_ref: version.contentRef,
    content_hash: version.contentHash,
    source_type: version.sourceType,
    source_ref: version.sourceRef,
    manifest_json: version.manifestJson,
    created_by: version.createdBy,
    published_at: version.publishedAt?.toISOString() ?? null,
    created_at: version.createdAt.toISOString(),
    etag: `skill-version-${version.versionNo}`,
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { skill_id: skillId } = await context.params;

  // 1. 解析 admin 主体
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Skill 存在且属于当前租户（跨租户隐藏为 404）
  const skill = await getSkillById({ tenantId: principal.tenantId, skillId });
  if (!skill) {
    return resourceNotFound(requestId, `Skill 不存在或无权访问: ${skillId}`);
  }

  // 3. 解析查询参数 state / limit
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");
  const limitParam = url.searchParams.get("limit");

  const revisionStates: SkillRevisionState[] | undefined = stateParam
    ? (stateParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) =>
          (VALID_REVISION_STATES as readonly string[]).includes(s),
        ) as SkillRevisionState[])
    : undefined;

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  // 4. 查询版本列表
  const versions = await listSkillVersions({
    tenantId: principal.tenantId,
    skillId,
    revisionStates,
    limit,
  });
  const projected = versions.map(projectVersionForGet);

  return apiSuccess(
    { items: projected, total: projected.length },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}
