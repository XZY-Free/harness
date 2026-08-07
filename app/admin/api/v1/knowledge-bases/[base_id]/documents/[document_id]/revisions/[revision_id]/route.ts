import {
  REQUEST_ID_HEADER,
  apiSuccess,
  etagHeader,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import {
  getKnowledgeBaseById,
  getKnowledgeDocumentById,
  getKnowledgeDocumentRevisionById,
} from "@/lib/context/knowledge-queries";
/**
 * GET /admin/api/v1/knowledge-bases/{base_id}/documents/{document_id}/revisions/{revision_id}
 *   — KnowledgeDocumentRevision 单资源详情（S11-W03）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/03-context-memory-and-knowledge.md §12（Knowledge Base）。
 * - ../v11-agentkit-platform/10-core-data-model.md §4.4（knowledge_document_revision 字段）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 KnowledgeBase / Document / Revision 存在且属于当前租户（跨租户隐藏为 404）。
 * - Revision 必须归属于路径中的 document（隐藏式 404 防越权）。
 * - 投影为 snake_case 并附带 ETag（knowledge-revision-{revisionNo}）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Base / Document / Revision 不存在或跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

/** 路径参数上下文（Next.js App Router 动态段为 Promise）。 */
interface RouteContext {
  params: Promise<{ base_id: string; document_id: string; revision_id: string }>;
}

/** 投影 KnowledgeDocumentRevision 为响应体（snake_case + etag）。 */
function projectRevision(rev: {
  id: string;
  documentId: string;
  revisionNo: string;
  contentRef: string | null;
  contentHash: string;
  aclSnapshotHash: string | null;
  aclSnapshotJson: Record<string, unknown> | null;
  indexState: string;
  revisionState: string;
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
}): Record<string, unknown> {
  return {
    id: rev.id,
    knowledge_document_id: rev.documentId,
    revision_no: rev.revisionNo,
    revision_state: rev.revisionState,
    content_ref: rev.contentRef,
    content_hash: rev.contentHash,
    acl_snapshot_hash: rev.aclSnapshotHash,
    acl_snapshot_json: rev.aclSnapshotJson,
    index_state: rev.indexState,
    created_by: rev.createdBy,
    published_at: rev.publishedAt?.toISOString() ?? null,
    created_at: rev.createdAt.toISOString(),
    etag: `knowledge-revision-${rev.revisionNo}`,
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const {
    base_id: baseId,
    document_id: documentId,
    revision_id: revisionId,
  } = await context.params;

  // 1. 解析 admin 主体
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 KnowledgeBase 存在且属于当前租户
  const base = await getKnowledgeBaseById(principal.tenantId, baseId);
  if (!base) {
    return resourceNotFound(requestId, "KnowledgeBase 不存在或无权访问");
  }

  // 3. 校验 KnowledgeDocument 存在、归属该 base
  const doc = await getKnowledgeDocumentById(principal.tenantId, documentId);
  if (!doc || doc.knowledgeBaseId !== baseId) {
    return resourceNotFound(requestId, "KnowledgeDocument 不存在或无权访问");
  }

  // 4. 校验 Revision 存在、归属于该 document
  const revision = await getKnowledgeDocumentRevisionById(principal.tenantId, revisionId);
  if (!revision || revision.documentId !== documentId) {
    return resourceNotFound(requestId, "KnowledgeDocumentRevision 不存在或无权访问");
  }

  // 5. 投影并返回 200 + ETag
  const responseBody = projectRevision(revision);
  return apiSuccess(responseBody, {
    status: 200,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`knowledge-revision-${revision.revisionNo}`),
    },
  });
}
