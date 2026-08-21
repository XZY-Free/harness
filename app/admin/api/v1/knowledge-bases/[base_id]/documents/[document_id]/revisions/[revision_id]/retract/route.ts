import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  KnowledgeRevisionAlreadyPublishedError,
  KnowledgeValidationError,
  getKnowledgeBaseById,
  getKnowledgeDocumentById,
  getKnowledgeDocumentRevisionById,
  retractKnowledgeDocumentRevision,
} from "@/lib/context/knowledge-queries";
/**
 * POST /admin/api/v1/knowledge-bases/{base_id}/documents/{document_id}/revisions/{revision_id}/retract
 *   — 撤回 KnowledgeDocumentRevision（阶段 7 S07-C05）。
 *
 * 事实源：
 * - docs/architecture/context-memory-and-knowledge.md §13（Knowledge 加载；紧急下线场景）。
 * - docs/architecture/persistence.md §4.4（knowledge_document_revision 字段）。
 * - docs/architecture/context-memory-and-knowledge.md S07-W06。
 *
 * 行为：
 * - 校验 Idempotency-Key（必填）+ 请求体 reason_code（必填）。
 * - 校验 Base / Document / Revision 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 retractKnowledgeDocumentRevision：
 *   - published → retracted；不再参与检索。
 *   - document.current_revision_id 不自动清空（由调用方决定是否回滚）。
 * - completeRecord + 返回 200 + retracted 投影。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Base / Document / Revision 不存在或跨租户 → 404 RESOURCE_NOT_FOUND
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - KnowledgeRevisionAlreadyPublishedError（非 published 状态）→ 422 BUSINESS_CONSTRAINT_VIOLATION
 */
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

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

interface RetractBody {
  reason_code: string;
  detail?: string;
}

function validateBody(body: unknown): body is RetractBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.reason_code !== "string" || b.reason_code.length === 0) return false;
  if (b.detail !== undefined && typeof b.detail !== "string") return false;
  return true;
}

function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) {
    return callerFromPrincipal(principal);
  }
  return callerFromWorkloadPrincipal(principal);
}


export async function POST(request: Request, context: RouteContext): Promise<Response> {
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

  // 2. 解析路径
  const { base_id, document_id, revision_id } = await context.params;
  const baseId = typeof base_id === "string" ? base_id : null;
  const documentId = typeof document_id === "string" ? document_id : null;
  const revisionId = typeof revision_id === "string" ? revision_id : null;
  if (!baseId || !documentId || !revisionId) {
    return schemaInvalidTable(requestId, "路径缺少 base_id/document_id/revision_id");
  }

  // 3. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. 校验 Revision / Document / Base 存在 + 跨租户
  const revision = await getKnowledgeDocumentRevisionById(principal.tenantId, revisionId);
  if (!revision) {
    return resourceNotFound(requestId, `KnowledgeDocumentRevision 不存在或无权访问: ${revisionId}`);
  }
  if (revision.documentId !== documentId) {
    return resourceNotFound(requestId, `KnowledgeDocumentRevision 不存在或无权访问: ${revisionId}`);
  }

  const doc = await getKnowledgeDocumentById(principal.tenantId, documentId);
  if (!doc || doc.knowledgeBaseId !== baseId) {
    return resourceNotFound(requestId, `KnowledgeDocument 不存在或无权访问: ${documentId}`);
  }

  const base = await getKnowledgeBaseById(principal.tenantId, baseId);
  if (!base) {
    return resourceNotFound(requestId, `KnowledgeBase 不存在或无权访问: ${baseId}`);
  }

  // 5. 校验 action scope
  const scopeResult = await requireAdminActionScope(
    principal,
    "knowledge.document.retract",
    { type: "knowledge_document", id: documentId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 6. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(requestId, "请求体非法：缺少 reason_code 或字段类型错误");
  }

  // 7. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `knowledge.document.retract:${revisionId}`;

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

  // 8. 执行业务：撤回修订
  try {
    const updated = await retractKnowledgeDocumentRevision({
      tenantId: principal.tenantId,
      revisionId,
      reasonCode: body.reason_code,
    });

    const responseBody = {
      revision: {
        id: updated.id,
        revision_no: updated.revisionNo,
        revision_state: updated.revisionState,
        index_state: updated.indexState,
        published_at: updated.publishedAt?.toISOString() ?? null,
      },
      reason_code: body.reason_code,
      detail: body.detail ?? null,
    };

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

    if (err instanceof KnowledgeRevisionAlreadyPublishedError) {
      return apiError(
        "BUSINESS_CONSTRAINT_VIOLATION",
        `Revision 非 published 状态无法撤回（id=${err.revisionId}, currentState=${err.currentState}）`,
        { requestId },
      );
    }
    if (err instanceof KnowledgeValidationError) {
      return schemaInvalidTable(requestId, err.message);
    }
    throw err;
  }
}
