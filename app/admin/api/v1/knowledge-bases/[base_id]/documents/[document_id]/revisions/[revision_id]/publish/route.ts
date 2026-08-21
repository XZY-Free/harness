import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  etagMismatchTable,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  KnowledgeRevisionAlreadyPublishedError,
  KnowledgeRevisionIndexNotReadyError,
  KnowledgeValidationError,
  KnowledgeVersionConflictError,
  getKnowledgeBaseById,
  getKnowledgeDocumentById,
  getKnowledgeDocumentRevisionById,
  publishKnowledgeDocumentRevision,
} from "@/lib/context/knowledge-queries";
/**
 * POST /admin/api/v1/knowledge-bases/{base_id}/documents/{document_id}/revisions/{revision_id}/publish
 *   — 发布 KnowledgeDocumentRevision（阶段 7 S07-C05）。
 *
 * 事实源：
 * - docs/architecture/context-memory-and-knowledge.md §12（Knowledge Base）、§13（Knowledge 加载）。
 * - docs/architecture/persistence.md §4.4（knowledge_document_revision 字段）。
 * - docs/architecture/context-memory-and-knowledge.md S07-W06。
 *
 * 行为：
 * - 校验 Idempotency-Key（必填）+ If-Match（Document ETag，必填）。
 * - 校验 Base / Document / Revision 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 publishKnowledgeDocumentRevision：
 *   - draft → published；切换 document.current_revision_id（乐观锁）。
 *   - 旧 published → superseded；首次发布时推进 base.indexState = ready。
 *   - 索引未就绪不允许发布（KNOWLEDGE_REVISION_INDEX_NOT_READY）。
 * - completeRecord + 返回 200 + published 投影 + Document 新 ETag。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Base / Document / Revision 不存在或跨租户 → 404 RESOURCE_NOT_FOUND
 * - If-Match 缺失/格式非法 → 400 REQUEST_SCHEMA_INVALID
 * - If-Match 不匹配 → 412 ETAG_MISMATCH
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - KnowledgeRevisionAlreadyPublishedError → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - KnowledgeRevisionIndexNotReadyError → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - KnowledgeVersionConflictError → 412 ETAG_MISMATCH
 */
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

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

interface PublishBody {
  acl_snapshot_hash?: string;
  acl_snapshot_json?: Record<string, unknown>;
}

function validateBody(body: unknown): body is PublishBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.acl_snapshot_hash !== undefined && typeof b.acl_snapshot_hash !== "string") return false;
  if (b.acl_snapshot_json !== undefined && typeof b.acl_snapshot_json !== "object") return false;
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

  // 4. 解析 If-Match（必填，Document ETag：knowledge-document-{versionNo}）
  const ifMatch = parseIfMatch(request);
  if (!ifMatch) {
    return schemaInvalidTable(requestId, "缺少必填头 If-Match");
  }
  const docVersionNo = parseDocumentEtag(ifMatch);
  if (docVersionNo === null) {
    return schemaInvalidTable(
      requestId,
      `If-Match ETag 格式非法：${ifMatch}（期望 knowledge-document-{versionNo}）`,
    );
  }

  // 5. 校验 Revision / Document / Base 存在 + 跨租户
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

  // 6. 校验 If-Match ETag 与 Document 当前 versionNo 一致
  const currentEtag = `knowledge-document-${doc.versionNo}`;
  if (ifMatch !== currentEtag) {
    return etagMismatchTable(requestId, `If-Match ${ifMatch} 与当前 ETag ${currentEtag} 不匹配`);
  }

  // 7. 校验 action scope
  const scopeResult = await requireAdminActionScope(
    principal,
    "knowledge.document.publish",
    { type: "knowledge_document", id: documentId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 8. 解析请求体
  const body = await request.json().catch(() => ({}));
  if (!validateBody(body)) {
    return schemaInvalidTable(
      requestId,
      "请求体非法：acl_snapshot_hash/acl_snapshot_json 字段类型错误",
    );
  }

  // 9. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `knowledge.document.publish:${revisionId}`;

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

  // 10. 执行业务：发布修订
  try {
    const result = await publishKnowledgeDocumentRevision({
      tenantId: principal.tenantId,
      revisionId,
      expectedDocumentVersionNo: doc.versionNo,
      aclSnapshotHash: body.acl_snapshot_hash ?? null,
      aclSnapshotJson: body.acl_snapshot_json ?? null,
    });

    const responseBody = {
      revision: {
        id: result.revision.id,
        revision_no: result.revision.revisionNo,
        revision_state: result.revision.revisionState,
        index_state: result.revision.indexState,
        published_at: result.revision.publishedAt?.toISOString() ?? null,
        acl_snapshot_hash: result.revision.aclSnapshotHash,
      },
      document: {
        id: result.document.id,
        current_revision_id: result.document.currentRevisionId,
        version_no: result.document.versionNo,
        etag: `knowledge-document-${result.document.versionNo}`,
      },
      previous_revision: result.previousRevision
        ? {
            id: result.previousRevision.id,
            revision_no: result.previousRevision.revisionNo,
            revision_state: result.previousRevision.revisionState,
          }
        : null,
    };

    await completeRecord({
      recordId,
      httpStatus: 200,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 200,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`knowledge-document-${result.document.versionNo}`),
      },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof KnowledgeRevisionAlreadyPublishedError) {
      return apiError(
        "BUSINESS_CONSTRAINT_VIOLATION",
        `Revision 已发布/已撤回（id=${err.revisionId}, currentState=${err.currentState}）`,
        { requestId },
      );
    }
    if (err instanceof KnowledgeRevisionIndexNotReadyError) {
      return apiError(
        "BUSINESS_CONSTRAINT_VIOLATION",
        `Revision 索引未就绪（id=${err.revisionId}, indexState=${err.currentIndexState}；要求 ready）`,
        { requestId },
      );
    }
    if (err instanceof KnowledgeVersionConflictError) {
      return etagMismatchTable(
        requestId,
        `Document ${err.resourceId} versionNo 不匹配（期望 ${err.expectedVersionNo}），并发冲突`,
      );
    }
    if (err instanceof KnowledgeValidationError) {
      return schemaInvalidTable(requestId, err.message);
    }
    throw err;
  }
}

/** 解析 knowledge-document-{versionNo} ETag；非法返回 null。 */
function parseDocumentEtag(etag: string): string | null {
  if (!etag.startsWith("knowledge-document-")) return null;
  return etag.slice("knowledge-document-".length);
}
