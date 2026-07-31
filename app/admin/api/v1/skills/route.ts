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
  SKILL_ETAG_PREFIX,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
/**
 * GET / POST /admin/api/v1/skills — Skill 集合（阶段 6 S06-C01）。
 *
 * 事实源：阶段 6 Skill/Capability 模型（参考 agents/[agent_id]/revisions/route.ts 模式）。
 *
 * 行为：
 * - GET：列出 Skill（分页 + lifecycle / visibility 过滤）。
 * - POST：创建 Skill（Idempotency-Key 必填，返回 201 + ETag）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - SkillValidationError → 400 REQUEST_SCHEMA_INVALID
 * - SkillVersionConflictError → 409 IDEMPOTENCY_CONFLICT
 */
import {
  type SkillLifecycleState,
  SkillValidationError,
  SkillVersionConflictError,
  type SkillVisibilityScope,
  createSkill,
  listSkills,
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
} from "@/lib/v11/identity/idempotency";

export const dynamic = "force-dynamic";

const VALID_LIFECYCLE_STATES: readonly SkillLifecycleState[] = [
  "draft",
  "enabled",
  "disabled",
  "retired",
];
const VALID_VISIBILITY_SCOPES: readonly SkillVisibilityScope[] = ["tenant", "internal", "owner"];

/** 请求体 schema（与 OpenAPI requestBody 对齐）。 */
interface CreateSkillBody {
  skill_key: string;
  display_name: string;
  description?: string;
  owner_user_id: string;
  visibility_scope?: SkillVisibilityScope;
  source_type?: "local" | "capability_market" | "external";
}

/** 校验请求体。 */
function validateBody(body: unknown): body is CreateSkillBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.skill_key !== "string" || b.skill_key.length === 0) return false;
  if (typeof b.display_name !== "string" || b.display_name.length === 0) return false;
  if (typeof b.owner_user_id !== "string" || b.owner_user_id.length === 0) return false;
  if (b.visibility_scope !== undefined) {
    if (typeof b.visibility_scope !== "string") return false;
    if (!(VALID_VISIBILITY_SCOPES as readonly string[]).includes(b.visibility_scope)) return false;
  }
  if (b.source_type !== undefined) {
    if (typeof b.source_type !== "string") return false;
    if (!["local", "capability_market", "external"].includes(b.source_type)) return false;
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

/** 从主体提取 createdBy（userIdentityId 或 serviceId）。 */
function createdByFromAdminPrincipal(principal: AdminPrincipal): string {
  if ("userIdentityId" in principal) {
    return principal.userIdentityId;
  }
  return principal.serviceId ?? principal.claims.tenantId;
}

/** 投影 Skill 为响应体（snake_case + etag）。 */
function projectSkill(skill: {
  id: string;
  tenantId: string;
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

// ─── GET /admin/api/v1/skills ──────────────────────────────

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

  // GET 不需要 resource.id，使用 tenant 级 scope 校验
  const scopeResult = await requireAdminActionScope(
    principal,
    "skill.create",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 解析查询参数
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const lifecycleParam = url.searchParams.get("lifecycle_state");
  const visibilityParam = url.searchParams.get("visibility_scope");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  const lifecycleStates: SkillLifecycleState[] | undefined = lifecycleParam
    ? (lifecycleParam
        .split(",")
        .filter((s) =>
          (VALID_LIFECYCLE_STATES as readonly string[]).includes(s),
        ) as SkillLifecycleState[])
    : undefined;
  const visibilityScopes: SkillVisibilityScope[] | undefined = visibilityParam
    ? (visibilityParam
        .split(",")
        .filter((s) =>
          (VALID_VISIBILITY_SCOPES as readonly string[]).includes(s),
        ) as SkillVisibilityScope[])
    : undefined;

  const { items, nextCursor } = await listSkills({
    tenantId: principal.tenantId,
    lifecycleStates,
    visibilityScopes,
    limit,
    cursor: cursor ?? null,
  });

  return v11Ok(
    {
      items: items.map(projectSkill),
      next_cursor: nextCursor,
    },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}

// ─── POST /admin/api/v1/skills ─────────────────────────────

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
    "skill.create",
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
      "请求体非法：缺少 skill_key/display_name/owner_user_id 或字段类型错误",
    );
  }

  // 5. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = "skill.create";

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

  // 6. 执行业务：创建 Skill
  try {
    const skill = await createSkill({
      tenantId: principal.tenantId,
      skillKey: body.skill_key,
      displayName: body.display_name,
      description: body.description ?? null,
      ownerUserId: body.owner_user_id,
      visibilityScope: body.visibility_scope,
      sourceType: body.source_type,
      createdBy: createdByFromAdminPrincipal(principal),
    });

    const responseBody = projectSkill(skill);
    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return v11Ok(responseBody, {
      status: 201,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`${SKILL_ETAG_PREFIX}${skill.versionNo}`),
      },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof SkillValidationError) {
      return v11SchemaInvalid(requestId, err.message);
    }
    if (err instanceof SkillVersionConflictError) {
      return v11Error("IDEMPOTENCY_CONFLICT", err.message, { requestId });
    }
    throw err;
  }
}
