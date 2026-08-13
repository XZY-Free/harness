/**
 * GET / POST /admin/api/v1/knowledge-bases/{base_id}/documents/{document_id}/revisions/{revision_id}/chunks
 *   — KnowledgeChunk 集合（阶段 7 S07-C05）。
 *
 * 事实源：
 * - docs/architecture/context-memory-and-knowledge.md §13（Knowledge 加载；Chunk 是检索单元）。
 * - docs/architecture/persistence.md §7.5（knowledge_chunk 索引表）。
 * - docs/architecture/context-memory-and-knowledge.md S07-W06。
 *
 * 行为：
 * - GET：列出 Revision 的全部 Chunk（按 chunkNo 升序）。
 * - POST：创建 Chunk（不可变；Idempotency-Key 必填；返回 201）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Base / Document / Revision 不存在或跨租户 → 404 RESOURCE_NOT_FOUND
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - KnowledgeValidationError → 400 REQUEST_SCHEMA_INVALID
 */
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
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
import {
  KnowledgeValidationError,
  createKnowledgeChunk,
  getKnowledgeBaseById,
  getKnowledgeDocumentById,
  getKnowledgeDocumentRevisionById,
  listKnowledgeChunksByRevision,
} from "@/lib/context/knowledge-queries";

export const dynamic = "force-dynamic";

interface CreateChunkBody {
  chunk_no: string;
  content_ref?: string;
  content_redacted?: string;
  content_hash: string;
  metadata_json?: Record<string, unknown>;
}

function validateBody(body: unknown): body is CreateChunkBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.chunk_no !== "string" || b.chunk_no.length === 0) return false;
  if (typeof b.content_hash !== "string" || b.content_hash.length === 0) return false;
  if (b.content_ref !== undefined && typeof b.content_ref !== "string") return false;
  if (b.content_redacted !== undefined && typeof b.content_redacted !== "string") return false;
  if (b.metadata_json !== undefined && typeof b.metadata_json !== "object") return false;
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

/** 投影 Chunk 为响应体（snake_case）。 */
function projectChunk(chunk: {
  id: string;
  documentRevisionId: string;
  chunkNo: string;
  contentRef: string | null;
  contentHash: string;
  metadataJson: Record<string, unknown> | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: chunk.id,
    document_revision_id: chunk.documentRevisionId,
    chunk_no: chunk.chunkNo,
    content_ref: chunk.contentRef,
    content_hash: chunk.contentHash,
    metadata_json: chunk.metadataJson,
    created_at: chunk.createdAt.toISOString(),
    etag: `knowledge-chunk-${chunk.id}`,
  };
}

interface PathIds {
  baseId: string | null;
  documentId: string | null;
  revisionId: string | null;
}

function extractPathIds(url: string): PathIds {
  // 路径形如 .../revisions/{revision_id}/chunks
  const match = url.match(
    /\/admin\/api\/v1\/knowledge-bases\/(.+?)\/documents\/(.+?)\/revisions\/(.+?)\/chunks(?:[/?#]|$)/,
  );
  const baseId = match?.[1];
  const documentId = match?.[2];
  const revisionId = match?.[3];
  return {
    baseId: baseId ? decodeURIComponent(baseId) : null,
    documentId: documentId ? decodeURIComponent(documentId) : null,
    revisionId: revisionId ? decodeURIComponent(revisionId) : null,
  };
}

// ─── GET /admin/api/v1/.../chunks ──

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

  const { baseId, documentId, revisionId } = extractPathIds(request.url);
  if (!baseId || !documentId || !revisionId) {
    return schemaInvalidTable(requestId, "路径缺少 base_id/document_id/revision_id");
  }

  // 校验 Revision / Document / Base 存在 + 跨租户
  const revision = await getKnowledgeDocumentRevisionById(principal.tenantId, revisionId);
  if (!revision || revision.documentId !== documentId) {
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

  const scopeResult = await requireAdminActionScope(
    principal,
    "knowledge.document.publish",
    { type: "knowledge_document", id: documentId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 500;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }

  const items = await listKnowledgeChunksByRevision(principal.tenantId, revisionId, { limit });

  return apiSuccess(
    { items: items.map(projectChunk) },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}

// ─── POST /admin/api/v1/.../chunks ──

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

  const { baseId, documentId, revisionId } = extractPathIds(request.url);
  if (!baseId || !documentId || !revisionId) {
    return schemaInvalidTable(requestId, "路径缺少 base_id/document_id/revision_id");
  }

  const revision = await getKnowledgeDocumentRevisionById(principal.tenantId, revisionId);
  if (!revision || revision.documentId !== documentId) {
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

  // 已 published 的 Revision 不允许新增 Chunk（不可变性）
  if (revision.revisionState !== "draft") {
    return schemaInvalidTable(
      requestId,
      `Revision 状态为 ${revision.revisionState}，不允许新增 Chunk（仅 draft 状态可写）`,
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
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(
      requestId,
      "请求体非法：缺少 chunk_no/content_hash 或字段类型错误，content_ref 与 content_redacted 至少一个非空",
    );
  }

  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `knowledge.chunk.create:${revisionId}`;

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
    const chunk = await createKnowledgeChunk({
      tenantId: principal.tenantId,
      documentRevisionId: revisionId,
      chunkNo: body.chunk_no,
      contentRef: body.content_ref ?? null,
      contentRedacted: body.content_redacted ?? null,
      contentHash: body.content_hash,
      metadataJson: body.metadata_json ?? null,
    });

    const responseBody = projectChunk(chunk);
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
    if (err instanceof KnowledgeValidationError) {
      return schemaInvalidTable(requestId, err.message);
    }
    throw err;
  }
}
