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
} from "@/lib/context/knowledge-queries";
/**
 * GET /admin/api/v1/knowledge-bases/{base_id}/documents/{document_id}
 *   — KnowledgeDocument 单资源详情（S11-W03）。
 *
 * 事实源：
 * - docs/architecture/context-memory-and-knowledge.md §12（Knowledge Base）。
 * - docs/architecture/persistence.md §4.4（knowledge_document 字段）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 KnowledgeBase 存在且属于当前租户（跨租户隐藏为 404）。
 * - 校验 KnowledgeDocument 存在、属于当前租户且归属于该 base（跨租户隐藏为 404）。
 * - 投影为 snake_case 并附带 ETag（knowledge-document-{versionNo}）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Base / Document 不存在或跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

/** 路径参数上下文（Next.js App Router 动态段为 Promise）。 */
interface RouteContext {
  params: Promise<{ base_id: string; document_id: string }>;
}

/** 投影 KnowledgeDocument 为响应体（snake_case + etag）。 */
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

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { base_id: baseId, document_id: documentId } = await context.params;

  // 1. 解析 admin 主体
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 KnowledgeBase 存在且属于当前租户（跨租户隐藏为 404）
  const base = await getKnowledgeBaseById(principal.tenantId, baseId);
  if (!base) {
    return resourceNotFound(requestId, "KnowledgeBase 不存在或无权访问");
  }

  // 3. 校验 KnowledgeDocument 存在、跨租户隔离、归属于该 base
  const doc = await getKnowledgeDocumentById(principal.tenantId, documentId);
  if (!doc || doc.knowledgeBaseId !== baseId) {
    return resourceNotFound(requestId, "KnowledgeDocument 不存在或无权访问");
  }

  // 4. 投影并返回 200 + ETag
  const responseBody = projectDocument(doc);
  return apiSuccess(responseBody, {
    status: 200,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`knowledge-document-${doc.versionNo}`),
    },
  });
}
