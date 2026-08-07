/**
 * GET / POST /admin/api/v1/knowledge-bases/{base_id}/documents — KnowledgeDocument 集合（阶段 7 S07-C05）。
 *
 * 行为：
 * - GET：列出 KnowledgeBase 内的 Document（lifecycle 过滤）。
 * - POST：创建 Document（Idempotency-Key 必填；返回 201 + ETag）。
 */
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  etagHeader,
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
  type KnowledgeDocumentLifecycleState,
  type KnowledgeSourceType,
  KnowledgeValidationError,
  createKnowledgeDocument,
  getKnowledgeBaseById,
  listKnowledgeDocuments,
} from "@/lib/context/knowledge-queries";

export const dynamic = "force-dynamic";

const VALID_LIFECYCLE_STATES: readonly KnowledgeDocumentLifecycleState[] = [
  "active",
  "archived",
  "deleted",
];

const VALID_SOURCE_TYPES: readonly KnowledgeSourceType[] = [
  "upload",
  "external_url",
  "manual",
  "synced",
  "generated",
];

interface CreateDocumentBody {
  document_key: string;
  title: string;
  source_type: KnowledgeSourceType;
  source_ref?: string;
}

function validateBody(body: unknown): body is CreateDocumentBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.document_key !== "string" || b.document_key.length === 0) return false;
  if (typeof b.title !== "string" || b.title.length === 0) return false;
  if (typeof b.source_type !== "string") return false;
  if (!(VALID_SOURCE_TYPES as readonly string[]).includes(b.source_type)) return false;
  if (b.source_ref !== undefined && typeof b.source_ref !== "string") return false;
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

function projectDocument(doc: {
  id: string;
  knowledgeBaseId: string;
  documentKey: string;
  title: string;
  sourceType: string;
  sourceRef: string | null;
  currentRevisionId: string | null;
  lifecycleState: string;
  versionNo: string;
  createdAt: Date;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: doc.id,
    knowledge_base_id: doc.knowledgeBaseId,
    document_key: doc.documentKey,
    title: doc.title,
    source_type: doc.sourceType,
    source_ref: doc.sourceRef,
    current_revision_id: doc.currentRevisionId,
    lifecycle_state: doc.lifecycleState,
    version_no: doc.versionNo,
    created_at: doc.createdAt.toISOString(),
    updated_at: doc.updatedAt.toISOString(),
    etag: `knowledge-document-${doc.versionNo}`,
  };
}

function extractBaseId(url: string): string | null {
  const match = url.match(/\/admin\/api\/v1\/knowledge-bases\/(.+?)\/documents(?:[/?#]|$)/);
  const id = match?.[1];
  return id ? decodeURIComponent(id) : null;
}

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

  const baseId = extractBaseId(request.url);
  if (!baseId) {
    return schemaInvalidTable(requestId, "路径缺少 base_id");
  }

  // 校验 base 存在且属于该租户
  const base = await getKnowledgeBaseById(principal.tenantId, baseId);
  if (!base) {
    return resourceNotFound(requestId, "KnowledgeBase 不存在或无权访问");
  }

  const scopeResult = await requireAdminActionScope(
    principal,
    "knowledge.document.create",
    { type: "knowledge_base", id: baseId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const lifecycleParam = url.searchParams.get("lifecycle_state");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }

  const lifecycleStates: KnowledgeDocumentLifecycleState[] | undefined = lifecycleParam
    ? (lifecycleParam
        .split(",")
        .filter((s) =>
          (VALID_LIFECYCLE_STATES as readonly string[]).includes(s),
        ) as KnowledgeDocumentLifecycleState[])
    : undefined;

  const items = await listKnowledgeDocuments(principal.tenantId, baseId, {
    lifecycleStates,
    limit,
  });

  return apiSuccess(
    { items: items.map(projectDocument) },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}

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

  const baseId = extractBaseId(request.url);
  if (!baseId) {
    return schemaInvalidTable(requestId, "路径缺少 base_id");
  }

  const base = await getKnowledgeBaseById(principal.tenantId, baseId);
  if (!base) {
    return resourceNotFound(requestId, "KnowledgeBase 不存在或无权访问");
  }

  // KnowledgeBase 必须 active 才能创建 Document
  if (base.lifecycleState !== "active") {
    return apiError(
      "ACTION_SCOPE_DENIED",
      `KnowledgeBase lifecycle=${base.lifecycleState}，不允许创建 Document`,
      { requestId },
    );
  }

  const scopeResult = await requireAdminActionScope(
    principal,
    "knowledge.document.create",
    { type: "knowledge_base", id: baseId },
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
      "请求体非法：缺少 document_key/title/source_type 或字段类型错误",
    );
  }

  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `knowledge.document.create:${baseId}`;

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
    const doc = await createKnowledgeDocument({
      tenantId: principal.tenantId,
      knowledgeBaseId: baseId,
      documentKey: body.document_key,
      title: body.title,
      sourceType: body.source_type,
      sourceRef: body.source_ref ?? null,
      createdBy: createdByFromAdminPrincipal(principal),
    });

    const responseBody = projectDocument(doc);
    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 201,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`knowledge-document-${doc.versionNo}`),
      },
    });
  } catch (err) {
    await failRecord(recordId);
    if (err instanceof KnowledgeValidationError) {
      return schemaInvalidTable(requestId, err.message);
    }
    throw err;
  }
}
