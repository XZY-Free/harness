import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { getKnowledgeBaseById } from "@/lib/context/knowledge-queries";
import {
  REQUEST_ID_HEADER,
  apiSuccess,
  etagHeader,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
/**
 * GET /admin/api/v1/knowledge-bases/{base_id} — KnowledgeBase 单资源详情（S11-W03）。
 *
 * 事实源：
 * - docs/architecture/context-memory-and-knowledge.md §12（Knowledge Base）。
 * - docs/architecture/persistence.md §4.4（knowledge_base 字段）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 KnowledgeBase 存在且属于当前租户（跨租户隐藏为 404）。
 * - 投影为 snake_case 并附带 ETag（knowledge-base-{versionNo}）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - KnowledgeBase 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

/** 路径参数上下文（Next.js App Router 动态段为 Promise）。 */
interface RouteContext {
  params: Promise<{ base_id: string }>;
}

/** 投影 KnowledgeBase 为响应体（snake_case + etag）。 */
function projectBase(base: {
  id: string;
  knowledgeKey: string;
  displayName: string;
  description: string | null;
  ownerUserId: string | null;
  visibilityPolicyId: string | null;
  indexState: string;
  lifecycleState: string;
  versionNo: string;
  createdAt: Date;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: base.id,
    knowledge_key: base.knowledgeKey,
    display_name: base.displayName,
    description: base.description,
    owner_user_id: base.ownerUserId,
    visibility_policy_id: base.visibilityPolicyId,
    index_state: base.indexState,
    lifecycle_state: base.lifecycleState,
    version_no: base.versionNo,
    created_at: base.createdAt.toISOString(),
    updated_at: base.updatedAt.toISOString(),
    etag: `knowledge-base-${base.versionNo}`,
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { base_id: baseId } = await context.params;

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
    return resourceNotFound(requestId, `KnowledgeBase 不存在或无权访问: ${baseId}`);
  }

  // 3. 投影并返回 200 + ETag
  const responseBody = projectBase(base);
  return apiSuccess(responseBody, {
    status: 200,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`knowledge-base-${base.versionNo}`),
    },
  });
}
