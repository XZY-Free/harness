/**
 * POST /admin/api/v1/knowledge-bases/{base_id}/documents/{document_id}/revisions/{revision_id}:mark-index-ready
 *   — 推进 KnowledgeDocumentRevision.indexState 到 ready（阶段 7 S07-C05）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/03-context-memory-and-knowledge.md §12（Knowledge Base；索引完成后才能发布）。
 * - ../v11-agentkit-platform/10-core-data-model.md §7.5（knowledge_index 索引表）。
 * - ../v11-agentkit-platform-development-plan/07-context-memory-and-knowledge.md S07-W06。
 *
 * 行为：
 * - 校验 Idempotency-Key（必填）。
 * - 校验 Base / Document / Revision 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 markKnowledgeRevisionIndexState：
 *   - 推进 indexState → ready。
 *   - 调用方应在所有 Chunk 索引写入完成后调用本接口。
 * - completeRecord + 返回 200 + updated 投影。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Base / Document / Revision 不存在或跨租户 → 404 RESOURCE_NOT_FOUND
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - KnowledgeValidationError（非法 indexState）→ 400 REQUEST_SCHEMA_INVALID
 */
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
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
  getKnowledgeBaseById,
  getKnowledgeDocumentById,
  getKnowledgeDocumentRevisionById,
  markKnowledgeRevisionIndexState,
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

interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) {
    return callerFromPrincipal(principal);
  }
  return callerFromWorkloadPrincipal(principal);
}

interface PathIds {
  baseId: string | null;
  documentId: string | null;
  revisionId: string | null;
}

function extractPathIds(url: string): PathIds {
  const match = url.match(
    /\/admin\/api\/v1\/knowledge-bases\/(.+?)\/documents\/(.+?)\/revisions\/(.+?):mark-index-ready(?:[/?#]|$)/,
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

export async function POST(request: Request, _context: RouteContext): Promise<Response> {
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
  const { baseId, documentId, revisionId } = extractPathIds(request.url);
  if (!baseId || !documentId || !revisionId) {
    return v11SchemaInvalid(requestId, "路径缺少 base_id/document_id/revision_id");
  }

  // 3. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. 校验 Revision / Document / Base 存在 + 跨租户
  const revision = await getKnowledgeDocumentRevisionById(principal.tenantId, revisionId);
  if (!revision) {
    return v11NotFound(requestId, `KnowledgeDocumentRevision 不存在或无权访问: ${revisionId}`);
  }
  if (revision.documentId !== documentId) {
    return v11NotFound(requestId, `KnowledgeDocumentRevision 不存在或无权访问: ${revisionId}`);
  }

  const doc = await getKnowledgeDocumentById(principal.tenantId, documentId);
  if (!doc || doc.knowledgeBaseId !== baseId) {
    return v11NotFound(requestId, `KnowledgeDocument 不存在或无权访问: ${documentId}`);
  }

  const base = await getKnowledgeBaseById(principal.tenantId, baseId);
  if (!base) {
    return v11NotFound(requestId, `KnowledgeBase 不存在或无权访问: ${baseId}`);
  }

  // 5. 校验 action scope（mark-index-ready 与 publish 同等敏感，使用 publish scope）
  const scopeResult = await requireAdminActionScope(
    principal,
    "knowledge.document.publish",
    { type: "knowledge_document", id: documentId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 6. 计算请求 hash + 幂等守卫（无请求体，使用空对象）
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, {});
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `knowledge.document.mark-index-ready:${revisionId}`;

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

  // 7. 执行业务：推进 indexState → ready
  try {
    const updated = await markKnowledgeRevisionIndexState({
      tenantId: principal.tenantId,
      revisionId,
      indexState: "ready",
    });

    if (!updated) {
      await failRecord(recordId);
      return v11NotFound(requestId, `KnowledgeDocumentRevision 不存在或无权访问: ${revisionId}`);
    }

    const responseBody = {
      revision: {
        id: updated.id,
        revision_no: updated.revisionNo,
        revision_state: updated.revisionState,
        index_state: updated.indexState,
      },
    };

    await completeRecord({
      recordId,
      httpStatus: 200,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return v11Ok(responseBody, {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);
    if (err instanceof KnowledgeValidationError) {
      return v11SchemaInvalid(requestId, err.message);
    }
    throw err;
  }
}
