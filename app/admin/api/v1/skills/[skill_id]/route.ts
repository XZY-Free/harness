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
  SKILL_ETAG_PREFIX,
  adminAuthErrorResponse,
  etagMismatchTable,
  parseSkillEtag,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
/**
 * GET / PATCH /admin/api/v1/skills/{skill_id} — Skill 单资源（阶段 6 S06-C01）。
 *
 * 事实源：阶段 6 Skill/Capability 模型（参考 deployment-routes/[route_id]/route.ts 模式）。
 *
 * 行为：
 * - GET：获取单个 Skill（含 currentVersion 摘要）。
 * - PATCH：更新 Skill 元数据（If-Match 必填 + ETag 校验）。
 *
 * ETag 前缀：`skill-{versionNo}`。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Skill 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - If-Match 缺失或格式非法 → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - SkillValidationError → 400 REQUEST_SCHEMA_INVALID
 * - ETag 不匹配 → 412 ETAG_MISMATCH
 * - SkillVersionConflictError → 412 ETAG_MISMATCH（乐观锁冲突）
 * - SkillLifecycleError → 422 BUSINESS_CONSTRAINT_VIOLATION
 */
import {
  SkillLifecycleError,
  type SkillLifecycleState,
  SkillNotFoundError,
  SkillValidationError,
  SkillVersionConflictError,
  type SkillVisibilityScope,
  getCurrentSkillVersion,
  getSkillById,
  updateSkill,
} from "@/lib/capability/skill-queries";

export const dynamic = "force-dynamic";

const VALID_LIFECYCLE_STATES: readonly SkillLifecycleState[] = [
  "draft",
  "enabled",
  "disabled",
  "retired",
];
const VALID_VISIBILITY_SCOPES: readonly SkillVisibilityScope[] = ["tenant", "internal", "owner"];

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ skill_id: string }>;
}

/** PATCH 请求体 schema。 */
interface PatchSkillBody {
  display_name?: string;
  description?: string | null;
  visibility_scope?: SkillVisibilityScope;
  lifecycle_state?: SkillLifecycleState;
}

/** 校验 PATCH 请求体。 */
function validatePatchBody(body: unknown): body is PatchSkillBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.display_name !== undefined) {
    if (typeof b.display_name !== "string" || b.display_name.length === 0) return false;
  }
  if (b.description !== undefined && b.description !== null && typeof b.description !== "string") {
    return false;
  }
  if (b.visibility_scope !== undefined) {
    if (typeof b.visibility_scope !== "string") return false;
    if (!(VALID_VISIBILITY_SCOPES as readonly string[]).includes(b.visibility_scope)) return false;
  }
  if (b.lifecycle_state !== undefined) {
    if (typeof b.lifecycle_state !== "string") return false;
    if (!(VALID_LIFECYCLE_STATES as readonly string[]).includes(b.lifecycle_state)) return false;
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

/** 投影 Skill 为响应体（snake_case + etag）。 */
function projectSkill(skill: {
  id: string;
  skillKey: string;
  displayName: string;
  description: string | null;
  ownerUserId: string;
  lifecycleState: string;
  currentVersionId: string | null;
  visibilityScope: string;
  sourceType: string;
  versionNo: number;
  createdAt: Date;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: skill.id,
    skill_key: skill.skillKey,
    display_name: skill.displayName,
    description: skill.description,
    owner_user_id: skill.ownerUserId,
    lifecycle_state: skill.lifecycleState,
    current_version_id: skill.currentVersionId,
    visibility_scope: skill.visibilityScope,
    source_type: skill.sourceType,
    version_no: skill.versionNo,
    created_at: skill.createdAt.toISOString(),
    updated_at: skill.updatedAt.toISOString(),
    etag: `${SKILL_ETAG_PREFIX}${skill.versionNo}`,
  };
}

// ─── GET /admin/api/v1/skills/{skill_id} ───────────────────

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { skill_id: skillId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 校验 action scope: skill.update + resource { type: "skill", id: skill_id }
  // GET 复用 skill.update 作为读权限（与 PATCH 一致，简化权限模型）
  const scopeResult = await requireAdminActionScope(
    principal,
    "skill.update",
    { type: "skill", id: skillId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 校验 Skill 存在且属于当前租户
  const skill = await getSkillById({ tenantId: principal.tenantId, skillId });
  if (!skill) {
    return resourceNotFound(requestId, `Skill 不存在或无权访问: ${skillId}`);
  }

  // 加载 currentVersion 摘要
  const currentVersion = await getCurrentSkillVersion({
    tenantId: principal.tenantId,
    skillId,
  });

  const body = projectSkill(skill);
  if (currentVersion) {
    body.current_version = {
      id: currentVersion.id,
      version_no: currentVersion.versionNo,
      content_ref: currentVersion.contentRef,
      content_hash: currentVersion.contentHash,
      revision_state: currentVersion.revisionState,
      published_at: currentVersion.publishedAt?.toISOString() ?? null,
    };
  } else {
    body.current_version = null;
  }

  return apiSuccess(body, {
    status: 200,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`${SKILL_ETAG_PREFIX}${skill.versionNo}`),
    },
  });
}

// ─── PATCH /admin/api/v1/skills/{skill_id} ─────────────────

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
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

  // 2. 解析 If-Match（必填）→ Skill ETag
  const ifMatch = parseIfMatch(request);
  if (!ifMatch) {
    return schemaInvalidTable(requestId, "缺少必填头 If-Match");
  }
  let expectedVersionNo: number;
  try {
    expectedVersionNo = parseSkillEtag(ifMatch);
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
      "请求体非法：display_name/description/visibility_scope/lifecycle_state 字段类型错误",
    );
  }

  // 5. 校验 Skill 存在且属于当前租户
  const skill = await getSkillById({ tenantId: principal.tenantId, skillId });
  if (!skill) {
    return resourceNotFound(requestId, `Skill 不存在或无权访问: ${skillId}`);
  }

  // 6. 校验 action scope: skill.update + resource { type: "skill", id: skillId }
  const scopeResult = await requireAdminActionScope(
    principal,
    "skill.update",
    { type: "skill", id: skillId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 7. 提前校验 ETag 与当前 versionNo 一致
  if (expectedVersionNo !== skill.versionNo) {
    return etagMismatchTable(
      requestId,
      `If-Match skill-${expectedVersionNo} 与当前 skill-${skill.versionNo} 不匹配`,
    );
  }

  // 8. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("PATCH", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `skill.update:${skillId}`;

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

  // 9. 执行业务：更新 Skill
  try {
    const updated = await updateSkill({
      tenantId: principal.tenantId,
      skillId,
      displayName: body.display_name,
      description: body.description,
      visibilityScope: body.visibility_scope,
      lifecycleState: body.lifecycle_state,
      expectedVersionNo,
    });

    const responseBody = projectSkill(updated);
    await completeRecord({
      recordId,
      httpStatus: 200,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 200,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`${SKILL_ETAG_PREFIX}${updated.versionNo}`),
      },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof SkillNotFoundError) {
      return resourceNotFound(requestId, err.message);
    }
    if (err instanceof SkillValidationError) {
      return schemaInvalidTable(requestId, err.message);
    }
    if (err instanceof SkillLifecycleError) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    if (err instanceof SkillVersionConflictError) {
      return etagMismatchTable(requestId, err.message);
    }
    throw err;
  }
}
