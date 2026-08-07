/**
 * POST /admin/api/v1/deletion-requests — 管理员删除请求（S12-W07）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-data-lifecycle.md §7
 *         （管理员可发起 thread/memory_entry/artifact/user/retention_scope 删除；
 *           删除请求先解析对象关系与 Legal Hold，再进入各存储 Adapter）。
 *
 * 行为：
 * - 校验身份 + action scope deletion.request（resource: tenant）。
 * - Idempotency-Key 必填；enforceIdempotency 守卫。
 * - 创建请求（planning）+ 写审计 deletion.request。
 * - 规划：planDeletion 解析对象图 + Legal Hold 阻止判断。
 *   - 命中 Hold → setBlockedReasonCodes + planning → blocked_by_hold（不执行）。
 *   - 未命中 → insertDeletionSteps + executeDeletionRequest（同步执行 → completed/partial/deleting）。
 * - 返回 201 + 请求投影（id / request_state / subject_type / subject_id / policy_revision_id / audit_event_id / accepted_at）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - 重复受理（同 subject 已有非终态请求）→ 409 BUSINESS_CONSTRAINT_VIOLATION
 */
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
} from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/identity/audit";
import { DeletionExecutorError, executeDeletionRequest } from "@/lib/identity/deletion-executor";
import { planDeletion } from "@/lib/identity/deletion-planner";
import {
  DeletionRequestError,
  createDeletionRequest,
  insertDeletionSteps,
  setBlockedReasonCodes,
  updateDeletionRequestState,
} from "@/lib/identity/deletion-request-queries";
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
  DELETION_DELETE_MODES,
  DELETION_REASON_CODES,
  DELETION_SUBJECT_TYPES,
  type DeletionDeleteMode,
  type DeletionRequestPrincipalKind,
  type DeletionSubjectType,
} from "@/lib/persistence/schema/deletion-request";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";

export const dynamic = "force-dynamic";

const VALID_SUBJECT_TYPES = new Set<string>(DELETION_SUBJECT_TYPES);
const VALID_DELETE_MODES = new Set<string>(DELETION_DELETE_MODES);
const VALID_REASON_CODES = new Set<string>(DELETION_REASON_CODES);

/** 管理端允许的 subject 类型（不含 user_data_export_scope，该类型走员工端）。 */
const ADMIN_SUBJECT_TYPES: ReadonlySet<DeletionSubjectType> = new Set([
  "thread",
  "memory_entry",
  "artifact",
  "user",
  "retention_scope",
]);

/** 管理端允许的 reason_code 与 delete_mode 组合。 */
const ADMIN_REASON_CODES: ReadonlySet<string> = new Set([
  "RETENTION_EXPIRED",
  "ADMIN_POLICY",
  "PRIVACY_REQUEST_VERIFIED",
]);

interface CreateBody {
  subject_type: DeletionSubjectType;
  subject_id: string;
  delete_mode: DeletionDeleteMode;
  reason_code: string;
  policy_revision_id: string;
}

function validateBody(body: unknown): body is CreateBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.subject_type !== "string" || !VALID_SUBJECT_TYPES.has(b.subject_type)) return false;
  if (!ADMIN_SUBJECT_TYPES.has(b.subject_type as DeletionSubjectType)) return false;
  if (typeof b.subject_id !== "string" || b.subject_id.trim().length === 0) return false;
  if (typeof b.delete_mode !== "string" || !VALID_DELETE_MODES.has(b.delete_mode)) return false;
  if (typeof b.reason_code !== "string" || !VALID_REASON_CODES.has(b.reason_code)) return false;
  if (!ADMIN_REASON_CODES.has(b.reason_code)) return false;
  if (typeof b.policy_revision_id !== "string" || b.policy_revision_id.trim().length === 0)
    return false;
  return true;
}

function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) {
    return callerFromPrincipal(principal);
  }
  return callerFromWorkloadPrincipal(principal);
}

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

function requestedByFromAdminPrincipal(principal: AdminPrincipal): string {
  if ("userIdentityId" in principal) {
    return principal.userIdentityId;
  }
  return principal.serviceId ?? principal.claims.tenantId;
}

function principalKindFromAdminPrincipal(principal: AdminPrincipal): DeletionRequestPrincipalKind {
  if ("userIdentityId" in principal) {
    return "user";
  }
  return "service";
}

/** 构造 POST 响应投影（与 OpenAPI 契约对齐）。 */
function projectRequest(r: {
  id: string;
  subjectType: string;
  subjectId: string;
  requestState: string;
  policyRevisionId: string | null;
  auditEventId: string | null;
  acceptedAt: Date;
}): Record<string, unknown> {
  return {
    id: r.id,
    request_state: r.requestState,
    subject_type: r.subjectType,
    subject_id: r.subjectId,
    policy_revision_id: r.policyRevisionId,
    audit_event_id: r.auditEventId,
    accepted_at: r.acceptedAt.toISOString(),
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 身份解析
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. action scope 校验：deletion.request + resource { type: tenant, id: tenantId }
  const scopeResult = await requireAdminActionScope(
    principal,
    "deletion.request",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 3. Idempotency-Key 必填
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. 请求体校验
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(
      requestId,
      "请求体非法：缺少 subject_type/subject_id/delete_mode/reason_code/policy_revision_id 或字段值非法",
    );
  }

  // 5. 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = "admin.deletion_request.create";

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

  const actor = actorFromAdminPrincipal(principal);
  const requestedBy = requestedByFromAdminPrincipal(principal);
  const principalKind = principalKindFromAdminPrincipal(principal);

  try {
    // 6. 创建删除请求（planning）+ 写审计 deletion.request
    const created = await createDeletionRequest({
      tenantId: principal.tenantId,
      subjectType: body.subject_type,
      subjectId: body.subject_id,
      deleteMode: body.delete_mode,
      reasonCode: body.reason_code,
      policyRevisionId: body.policy_revision_id,
      requestedBy,
      requestPrincipalKind: principalKind,
      actor,
      requestId,
    });

    // 7. 规划：解析对象图 + Legal Hold 阻止判断
    const plan = await planDeletion({
      tenantId: principal.tenantId,
      subjectType: body.subject_type,
      subjectId: body.subject_id,
      deleteMode: body.delete_mode,
    });

    let finalRequest = created;

    if (plan.blockedReasonCodes.length > 0) {
      // 7a. 命中 Legal Hold → setBlockedReasonCodes + planning → blocked_by_hold（不执行）
      await setBlockedReasonCodes({
        tenantId: principal.tenantId,
        id: created.id,
        reasonCodes: plan.blockedReasonCodes,
      });
      finalRequest = await updateDeletionRequestState({
        tenantId: principal.tenantId,
        id: created.id,
        nextState: "blocked_by_hold",
        actor,
        reason: `Legal Hold 阻止：${plan.blockedReasonCodes.join(", ")}`,
        requestId,
      });
    } else {
      // 7b. 未命中 → insertDeletionSteps + executeDeletionRequest（同步执行 → completed/partial/deleting）
      await insertDeletionSteps({
        tenantId: principal.tenantId,
        requestId: created.id,
        steps: plan.steps,
      });
      const result = await executeDeletionRequest({
        tenantId: principal.tenantId,
        deletionRequestId: created.id,
        actor,
        requestId,
      });
      finalRequest = result.request;
    }

    // 8. 构造响应投影
    const responseBody = projectRequest({
      id: finalRequest.id,
      subjectType: finalRequest.subjectType,
      subjectId: finalRequest.subjectId,
      requestState: finalRequest.requestState,
      policyRevisionId: finalRequest.policyRevisionId,
      auditEventId: finalRequest.auditEventId,
      acceptedAt: finalRequest.acceptedAt,
    });

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

    // 重复受理（同 subject 已有非终态请求）→ 409 BUSINESS_CONSTRAINT_VIOLATION
    if (err instanceof DeletionRequestError && err.code === "duplicate_active_request") {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    // 执行器状态非法（不应发生，防御性）→ 409 BUSINESS_CONSTRAINT_VIOLATION
    if (err instanceof DeletionExecutorError && err.code === "illegal_state_for_execution") {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    throw err;
  }
}
