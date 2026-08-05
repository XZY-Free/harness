import { IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
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
  CAPABILITY_REVIEW_RESOURCE_TYPES,
  type CapabilityReviewResourceType,
  type CapabilityReviewState,
} from "@/lib/persistence/schema/tool-call";
/**
 * GET / POST /admin/api/v1/capability-reviews — CapabilityReview 集合（阶段 6 S06-C05）。
 *
 * 事实源：../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §5（能力变化与审核）。
 *
 * 行为：
 * - GET：列出审核记录（默认 pending；支持 resource_type / resource_id / review_state 过滤 + cursor 分页）。
 * - POST：创建审核记录（Idempotency-Key 必填，返回 201）。
 *   - 请求体含 risk_diff（调用方预先通过 compareSchemaRevisions 计算的差异结果），
 *     也可由 route 内部接收 old/new risk_metadata + affected_agents 自行计算差异。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - CapabilityReviewValidationError → 400 REQUEST_SCHEMA_INVALID
 */
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/v11/admin/route-helpers";
import {
  type RiskDiffResult,
  type RiskMetadata,
  compareSchemaRevisions,
} from "@/lib/v11/capability/risk-diff";
import {
  CapabilityReviewValidationError,
  createCapabilityReview,
  listPendingReviews,
} from "@/lib/v11/capability/risk-review-queries";

export const dynamic = "force-dynamic";

const VALID_REVIEW_STATES: readonly CapabilityReviewState[] = ["pending", "approved", "rejected"];

/** POST 请求体 schema（snake_case）。 */
interface CreateCapabilityReviewBody {
  /** 资源类型。 */
  resource_type: CapabilityReviewResourceType;
  /** 资源稳定 id。 */
  resource_id: string;
  /** 旧修订 id；首次发布可不传。 */
  old_revision_id?: string | null;
  /** 新修订 id。 */
  new_revision_id: string;
  /** 受影响的 Agent id 列表。 */
  affected_agents?: string[];
  /** 旧风险元数据；与 new_risk_metadata 一起传入时由 route 内部计算 diff。 */
  old_risk_metadata?: unknown;
  /** 新风险元数据；与 old_risk_metadata 一起传入时由 route 内部计算 diff。 */
  new_risk_metadata?: unknown;
  /** 已计算好的 diff 结果；与 old/new_risk_metadata 二选一传入。 */
  risk_diff?: {
    diff_type: string;
    requires_review: boolean;
    description: string;
  };
}

/** 校验 POST 请求体。 */
function validateBody(body: unknown): body is CreateCapabilityReviewBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.resource_type !== "string") return false;
  if (!(CAPABILITY_REVIEW_RESOURCE_TYPES as readonly string[]).includes(b.resource_type)) {
    return false;
  }
  if (typeof b.resource_id !== "string" || b.resource_id.length === 0) return false;
  if (typeof b.new_revision_id !== "string" || b.new_revision_id.length === 0) return false;
  if (b.old_revision_id !== undefined && b.old_revision_id !== null) {
    if (typeof b.old_revision_id !== "string") return false;
  }
  if (b.affected_agents !== undefined) {
    if (!Array.isArray(b.affected_agents)) return false;
    if (!b.affected_agents.every((a) => typeof a === "string")) return false;
  }
  if (b.risk_diff !== undefined && b.risk_diff !== null) {
    if (typeof b.risk_diff !== "object") return false;
    const rd = b.risk_diff as Record<string, unknown>;
    if (typeof rd.diff_type !== "string" || rd.diff_type.length === 0) return false;
    if (typeof rd.requires_review !== "boolean") return false;
    if (typeof rd.description !== "string") return false;
  }
  if (b.old_risk_metadata !== undefined && b.old_risk_metadata !== null) {
    if (typeof b.old_risk_metadata !== "object") return false;
  }
  if (b.new_risk_metadata !== undefined && b.new_risk_metadata !== null) {
    if (typeof b.new_risk_metadata !== "object") return false;
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

/** 投影 CapabilityReview 为响应体（snake_case）。 */
function projectReview(review: {
  id: string;
  tenantId: string;
  resourceType: string;
  resourceId: string;
  oldRevisionId: string | null;
  newRevisionId: string;
  diffType: string;
  requiresReview: boolean;
  description: string;
  affectedAgentsJson: unknown;
  reviewState: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: review.id,
    resource_type: review.resourceType,
    resource_id: review.resourceId,
    old_revision_id: review.oldRevisionId,
    new_revision_id: review.newRevisionId,
    diff_type: review.diffType,
    requires_review: review.requiresReview,
    description: review.description,
    affected_agents: review.affectedAgentsJson,
    review_state: review.reviewState,
    reviewed_by: review.reviewedBy,
    reviewed_at: review.reviewedAt?.toISOString() ?? null,
    review_notes: review.reviewNotes,
    created_at: review.createdAt.toISOString(),
    updated_at: review.updatedAt.toISOString(),
  };
}

// ─── GET /admin/api/v1/capability-reviews ─────────────────

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

  // capability.review + tenant wildcard：本租户内所有审核记录。
  const scopeResult = await requireAdminActionScope(
    principal,
    "capability.review",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 解析查询参数
  const url = new URL(request.url);
  const resourceTypeParam = url.searchParams.get("resource_type");
  const resourceIdParam = url.searchParams.get("resource_id");
  const reviewStateParam = url.searchParams.get("review_state");
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");

  let resourceType: CapabilityReviewResourceType | null = null;
  if (resourceTypeParam) {
    if (!(CAPABILITY_REVIEW_RESOURCE_TYPES as readonly string[]).includes(resourceTypeParam)) {
      return schemaInvalidTable(requestId, `resource_type 非法: ${resourceTypeParam}`);
    }
    resourceType = resourceTypeParam as CapabilityReviewResourceType;
  }

  let reviewState: CapabilityReviewState | null = null;
  if (reviewStateParam) {
    if (!(VALID_REVIEW_STATES as readonly string[]).includes(reviewStateParam)) {
      return schemaInvalidTable(requestId, `review_state 非法: ${reviewStateParam}`);
    }
    reviewState = reviewStateParam as CapabilityReviewState;
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }

  const { items, nextCursor } = await listPendingReviews({
    tenantId: principal.tenantId,
    resourceType,
    resourceId: resourceIdParam,
    reviewState,
    limit,
    cursor: cursor ?? null,
  });

  return apiSuccess(
    {
      items: items.map(projectReview),
      next_cursor: nextCursor,
    },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}

// ─── POST /admin/api/v1/capability-reviews ────────────────

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
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 3. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(
      requestId,
      "请求体非法：缺少 resource_type/resource_id/new_revision_id 或字段类型错误",
    );
  }

  // 4. 校验 action scope：capability.review + tenant wildcard（本租户内创建审核记录）
  const scopeResult = await requireAdminActionScope(
    principal,
    "capability.review",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 5. 计算 diff：优先使用调用方传入的 risk_diff；否则按 old/new_risk_metadata 计算
  let diffResult: RiskDiffResult;
  if (body.risk_diff) {
    diffResult = {
      diffType: body.risk_diff.diff_type as RiskDiffResult["diffType"],
      requiresReview: body.risk_diff.requires_review,
      description: body.risk_diff.description,
      affectedAgents: body.affected_agents ?? [],
      resourceType: body.resource_type,
      oldRevisionId: body.old_revision_id ?? null,
      newRevisionId: body.new_revision_id,
    };
  } else {
    // 内部计算 diff：要求 new_risk_metadata 必填
    if (!body.new_risk_metadata) {
      return schemaInvalidTable(requestId, "请求体非法：必须提供 risk_diff 或 new_risk_metadata");
    }
    const oldMeta = body.old_risk_metadata as RiskMetadata | null;
    const newMeta = body.new_risk_metadata as RiskMetadata;
    diffResult = compareSchemaRevisions({
      resourceType: body.resource_type,
      resourceId: body.resource_id,
      oldRevisionId: body.old_revision_id ?? null,
      newRevisionId: body.new_revision_id,
      oldRiskMetadata: oldMeta,
      newRiskMetadata: newMeta,
      affectedAgents: body.affected_agents,
    });
  }

  // 6. 计算请求 hash + 幂等守卫
  //    commandScope 固定为 capability.review.create（与 skill.create 模式一致），
  //    使同一 caller 下相同 Idempotency-Key 在不同请求体上触发冲突（409），
  //    而非按 resource_id 拆分作用域导致重复 key 被误判为新操作。
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = "capability.review.create";

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

  // 7. 执行业务：创建审核记录
  try {
    const review = await createCapabilityReview({
      tenantId: principal.tenantId,
      resourceType: body.resource_type,
      resourceId: body.resource_id,
      oldRevisionId: body.old_revision_id ?? null,
      newRevisionId: body.new_revision_id,
      diffType: diffResult.diffType,
      requiresReview: diffResult.requiresReview,
      description: diffResult.description,
      affectedAgents: diffResult.affectedAgents,
    });

    const responseBody = projectReview(review);
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

    if (err instanceof CapabilityReviewValidationError) {
      return schemaInvalidTable(requestId, err.message);
    }
    throw err;
  }
}
