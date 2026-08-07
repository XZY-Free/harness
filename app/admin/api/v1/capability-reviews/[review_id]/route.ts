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
/**
 * GET / POST /admin/api/v1/capability-reviews/{review_id} — CapabilityReview 单资源（阶段 6 S06-C05）。
 *
 * 事实源：../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §5（能力变化与审核）。
 *
 * 行为：
 * - GET：获取单个审核记录。
 * - POST：审核裁决（pending → approved/rejected），Idempotency-Key 必填。
 *   - 请求体：{ decision: "approved" | "rejected", review_notes?: string }
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 审核记录不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - CapabilityReviewValidationError → 400 REQUEST_SCHEMA_INVALID
 * - CapabilityReviewStateError（终态再迁移）→ 422 BUSINESS_CONSTRAINT_VIOLATION
 */
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  CapabilityReviewNotFoundError,
  CapabilityReviewStateError,
  CapabilityReviewValidationError,
  getCapabilityReviewById,
  resolveCapabilityReview,
} from "@/lib/capability/risk-review-queries";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ review_id: string }>;
}

/** POST 请求体 schema。 */
interface ResolveReviewBody {
  /** 审核裁决：approved / rejected。 */
  decision: "approved" | "rejected";
  /** 审核备注；可空。 */
  review_notes?: string | null;
}

/** 校验 POST 请求体。 */
function validateBody(body: unknown): body is ResolveReviewBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.decision !== "approved" && b.decision !== "rejected") return false;
  if (b.review_notes !== undefined && b.review_notes !== null) {
    if (typeof b.review_notes !== "string") return false;
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

/** 从主体提取 reviewedBy（userIdentityId 或 serviceId）。 */
function reviewedByFromAdminPrincipal(principal: AdminPrincipal): string {
  if ("userIdentityId" in principal) {
    return principal.userIdentityId;
  }
  return principal.serviceId ?? principal.claims.tenantId;
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

// ─── GET /admin/api/v1/capability-reviews/{review_id} ─────

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { review_id: reviewId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 校验 action scope: capability.review + tenant wildcard（本租户内读审核记录）
  const scopeResult = await requireAdminActionScope(
    principal,
    "capability.review",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 校验审核记录存在且属于当前租户
  const review = await getCapabilityReviewById({
    tenantId: principal.tenantId,
    reviewId,
  });
  if (!review) {
    return resourceNotFound(requestId, `CapabilityReview 不存在或无权访问: ${reviewId}`);
  }

  return apiSuccess(projectReview(review), {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}

// ─── POST /admin/api/v1/capability-reviews/{review_id} ────

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { review_id: reviewId } = await context.params;

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
      "请求体非法：缺少 decision（必须为 approved/rejected）或字段类型错误",
    );
  }

  // 4. 校验审核记录存在且属于当前租户
  const review = await getCapabilityReviewById({
    tenantId: principal.tenantId,
    reviewId,
  });
  if (!review) {
    return resourceNotFound(requestId, `CapabilityReview 不存在或无权访问: ${reviewId}`);
  }

  // 5. 校验 action scope：capability.review + tenant wildcard
  const scopeResult = await requireAdminActionScope(
    principal,
    "capability.review",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 6. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `capability.review.resolve:${reviewId}`;

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

  // 7. 执行业务：审核裁决
  try {
    const updated = await resolveCapabilityReview({
      tenantId: principal.tenantId,
      reviewId,
      toState: body.decision,
      reviewedBy: reviewedByFromAdminPrincipal(principal),
      reviewNotes: body.review_notes ?? null,
    });

    const responseBody = projectReview(updated);
    await completeRecord({
      recordId,
      httpStatus: 200,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof CapabilityReviewNotFoundError) {
      return resourceNotFound(requestId, err.message);
    }
    if (err instanceof CapabilityReviewValidationError) {
      return schemaInvalidTable(requestId, err.message);
    }
    if (err instanceof CapabilityReviewStateError) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    throw err;
  }
}
