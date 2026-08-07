import {
  REQUEST_ID_HEADER,
  apiSuccess,
  etagHeader,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
import type { CatalogEntry } from "@/lib/persistence/schema/catalog";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { getCatalogEntryById } from "@/lib/catalog/catalog-queries";
/**
 * GET /admin/api/v1/catalog/entries/{entry_id} — Admin Catalog 单条详情（S11-W03）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/12-capability-and-collaboration-api.md §2（Employee Catalog API）、§3.1（CatalogSearchItem）。
 * - ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md §2（统一目录）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 按 entry_id 查询单条 CatalogEntry（跨租户隔离：getCatalogEntryById 内部按 tenantId 过滤）。
 * - 不存在或跨租户 → 404 RESOURCE_NOT_FOUND（隐藏式 404，不暴露存在性）。
 * - 200 响应附 ETag 头（catalog-{catalogRevision}），与列表项 etag 字段一致。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 资源不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ entry_id: string }>;
}

/** 把 CatalogEntry 投影为 admin 响应体（snake_case）。 */
function projectEntry(entry: CatalogEntry): Record<string, unknown> {
  return {
    id: entry.id,
    resource_type: entry.resourceType,
    resource_id: entry.resourceId,
    display_name: entry.displayName,
    description: entry.description,
    owner_user_id: entry.ownerUserId,
    tags: entry.tagsJson as string[] | null,
    lifecycle_state: entry.lifecycleState,
    visibility_summary: entry.visibilitySummary,
    source_updated_at: entry.sourceUpdatedAt,
    projected_at: entry.projectedAt,
    catalog_revision: entry.catalogRevision,
    etag: `catalog-${entry.catalogRevision}`,
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析 admin 主体
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析路径参数
  const { entry_id: entryId } = await context.params;

  // 3. 查询单条目录条目（跨租户隔离）
  const entry = await getCatalogEntryById({
    tenantId: principal.tenantId,
    entryId,
  });

  // 4. 不存在或跨租户 → 隐藏式 404
  if (!entry) {
    return resourceNotFound(requestId);
  }

  // 5. 投影并返回 200 + ETag
  const etag = `catalog-${entry.catalogRevision}`;
  return apiSuccess(projectEntry(entry), {
    status: 200,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(etag),
    },
  });
}
