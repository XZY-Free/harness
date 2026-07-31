/**
 * GET / POST /admin/api/v1/knowledge-bases/{base_id}/documents/{document_id}/revisions
 *   — KnowledgeDocumentRevision 集合（阶段 7 S07-C05）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/03-context-memory-and-knowledge.md §12（Knowledge Base）。
 * - ../v11-agentkit-platform/10-core-data-model.md §4.4（knowledge_document_revision 字段）。
 * - ../v11-agentkit-platform-development-plan/07-context-memory-and-knowledge.md S07-W06。
 *
 * 行为：
 * - GET：列出 Document 的全部 Revision（按 revisionNo 降序）。
 * - POST：创建 Revision（draft 状态；Idempotency-Key 必填；返回 201 + ETag）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Base / Document 不存在或跨租户 → 404 RESOURCE_NOT_FOUND
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - KnowledgeValidationError → 400 REQUEST_SCHEMA_INVALID
 */
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  etagHeader,
  getRequestId,
  v11NotFound,
  v11Ok,
} from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import {
  KnowledgeValidationError,
  createKnowledgeDocumentRevision,
  getKnowledgeBaseById,
  getKnowledgeDocumentById,
  listKnowledgeDocumentRevisions,
} from "@/lib/v11/context/knowledge-queries";
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

interface CreateRevisionBody {
  revision_no: string;
  content_ref?: string;
  content_redacted?: string;
  content_hash: string;
  acl_snapshot_hash?: string;
  acl_snapshot_json?: Record<string, unknown>;
}

function validateBody(body: unknown): body is CreateRevisionBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.revision_no !== "string" || b.revision_no.length === 0) return false;
  if (typeof b.content_hash !== "string" || b.content_hash.length === 0) return false;
  if (b.content_ref !== undefined && typeof b.content_ref !== "string") return false;
  if (b.content_redacted !== undefined && typeof b.content_redacted !== "string") return false;
  if (b.acl_snapshot_hash !== undefined && typeof b.acl_snapshot_hash !== "string") return false;
  if (b.acl_snapshot_json !== undefined && typeof b.acl_snapshot_json !== "object") return false;
  // content_ref 与 content_redacted 至少一个非空
  if (!b.content_ref && !b.content_redacted) return false;
  return true;
}

function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) {
    return callerFromPrincipal(principal);
  }
  return callerFromWorkloadPrincipal(principal);
}

function createdByFromAdminPrincipal(principal: AdminPrincipal): string {
  if ("userIdentityId" in principal) {
    return principal.userIdentityId;
  }
  return principal.serviceId ?? principal.claims.tenantId;
}

/** 投影 Revision 为响应体（snake_case）。 */
function projectRevision(rev: {
  id: string;
  documentId: string;
  revisionNo: string;
  contentRef: string | null;
  contentHash: string;
  aclSnapshotHash: string | null;
  indexState: string;
  revisionState: string;
  createdBy: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}): Record<string, unknown> {
  return {
    id: rev.id,
    document_id: rev.documentId,
    revision_no: rev.revisionNo,
    content_ref: rev.contentRef,
    content_hash: rev.contentHash,
    acl_snapshot_hash: rev.aclSnapshotHash,
    index_state: rev.indexState,
    revision_state: rev.revisionState,
    created_by: rev.createdBy,
    created_at: rev.createdAt.toISOString(),
    published_at: rev.publishedAt?.toISOString() ?? null,
    etag: `knowledge-revision-${rev.revisionNo}`,
  };
}

function extractPathIds(url: string): { baseId: string | null; documentId: string | null } {
  const match = url.match(
    /\/admin\/api\/v1\/knowledge-bases\/(.+?)\/documents\/(.+?)\/revisions(?:[/?#]|$)/,
  );
  const baseId = match?.[1];
  const documentId = match?.[2];
  return {
    baseId: baseId ? decodeURIComponent(baseId) : null,
    documentId: documentId ? decodeURIComponent(documentId) : null,
  };
}

// ─── GET /admin/api/v1/knowledge-bases/{base_id}/documents/{document_id}/revisions ──

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

  const { baseId, documentId } = extractPathIds(request.url);
  if (!baseId || !documentId) {
    return v11SchemaInvalid(requestId, "路径缺少 base_id 或 document_id");
  }

  // 校验 base 存在 + 跨租户隔离
  const base = await getKnowledgeBaseById(principal.tenantId, baseId);
  if (!base) {
    return v11NotFound(requestId, "KnowledgeBase 不存在或无权访问");
  }

  // 校验 document 存在 + 归属该 base
  const doc = await getKnowledgeDocumentById(principal.tenantId, documentId);
  if (!doc || doc.knowledgeBaseId !== baseId) {
    return v11NotFound(requestId, "KnowledgeDocument 不存在或无权访问");
  }

  // action scope：使用 knowledge.document.publish（管理 Revision 需要 write 权限）
  // GET 列表同样使用 publish scope，因为 Revision 包含 ACL 快照等敏感信息
  const scopeResult = await requireAdminActionScope(
    principal,
    "knowledge.document.publish",
    { type: "knowledge_document", id: documentId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  const items = await listKnowledgeDocumentRevisions(principal.tenantId, documentId, { limit });

  return v11Ok(
    { items: items.map(projectRevision) },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}

// ─── POST /admin/api/v1/knowledge-bases/{base_id}/documents/{document_id}/revisions ──

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const { baseId, documentId } = extractPathIds(request.url);
  if (!baseId || !documentId) {
    return v11SchemaInvalid(requestId, "路径缺少 base_id 或 document_id");
  }

  const base = await getKnowledgeBaseById(principal.tenantId, baseId);
  if (!base) {
    return v11NotFound(requestId, "KnowledgeBase 不存在或无权访问");
  }

  const doc = await getKnowledgeDocumentById(principal.tenantId, documentId);
  if (!doc || doc.knowledgeBaseId !== baseId) {
    return v11NotFound(requestId, "KnowledgeDocument 不存在或无权访问");
  }

  // KnowledgeBase 与 Document 必须 active 才能创建 Revision
  if (base.lifecycleState !== "active") {
    return v11SchemaInvalid(
      requestId,
      `KnowledgeBase lifecycle=${base.lifecycleState}，不允许创建 Revision`,
    );
  }
  if (doc.lifecycleState !== "active") {
    return v11SchemaInvalid(
      requestId,
      `KnowledgeDocument lifecycle=${doc.lifecycleState}，不允许创建 Revision`,
    );
  }

  const scopeResult = await requireAdminActionScope(
    principal,
    "knowledge.document.publish",
    { type: "knowledge_document", id: documentId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return v11SchemaInvalid(
      requestId,
      "请求体非法：缺少 revision_no/content_hash 或字段类型错误，content_ref 与 content_redacted 至少一个非空",
    );
  }

  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `knowledge.document.revision.create:${documentId}`;

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

  try {
    const rev = await createKnowledgeDocumentRevision({
      tenantId: principal.tenantId,
      documentId,
      revisionNo: body.revision_no,
      contentRef: body.content_ref ?? null,
      contentRedacted: body.content_redacted ?? null,
      contentHash: body.content_hash,
      aclSnapshotHash: body.acl_snapshot_hash ?? null,
      aclSnapshotJson: body.acl_snapshot_json ?? null,
      createdBy: createdByFromAdminPrincipal(principal),
    });

    const responseBody = projectRevision(rev);
    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return v11Ok(responseBody, {
      status: 201,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`knowledge-revision-${rev.revisionNo}`),
      },
    });
  } catch (err) {
    await failRecord(recordId);
    if (err instanceof KnowledgeValidationError) {
      return v11SchemaInvalid(requestId, err.message);
    }
    throw err;
  }
}
