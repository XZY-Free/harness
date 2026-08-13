import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import type { CatalogResourceType } from "@/lib/persistence/schema/catalog";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  CatalogQueryError,
  type CatalogSearchItem,
  searchCatalog,
} from "@/lib/catalog/catalog-queries";
/**
 * GET /admin/api/v1/catalog/search — Admin Catalog 搜索（S11-W03）。
 *
 * 事实源：
 * - docs/architecture/capability-and-collaboration-api.md §2（Employee Catalog API）、§3.1（CatalogSearchItem）。
 * - docs/architecture/capabilities-and-security.md §2（统一目录）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 必填查询参数 `q`（关键词，匹配 displayName / description 模糊）。
 * - 可选查询参数 resource_types（逗号分隔）、lifecycle_states（逗号分隔）、limit（默认 20）、cursor。
 * - 调用 searchCatalog 返回 CatalogSearchItem 列表 + next_cursor + catalog_revision。
 * - 每条 item 附带 catalog_revision（顶层），便于客户端增量同步。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 q 或 q 为空 → 400 REQUEST_SCHEMA_INVALID
 * - resource_types / lifecycle_states 非法 → 400 REQUEST_SCHEMA_INVALID
 * - cursor 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

/** 合法 resourceType 集合（校验输入用）。 */
const VALID_RESOURCE_TYPES: readonly string[] = [
  "agent",
  "skill",
  "tool",
  "knowledge",
  "runtime",
  "model",
  "connection",
];

/** 解析 resource_types 查询参数（逗号分隔）。 */
function parseResourceTypes(param: string | null): readonly CatalogResourceType[] | undefined {
  if (!param) return undefined;
  const parts = param
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const p of parts) {
    if (!VALID_RESOURCE_TYPES.includes(p)) {
      throw new CatalogQueryError("invalid_resource_type", `resourceType 非法: ${p}`);
    }
  }
  return parts as CatalogResourceType[];
}

/** 解析 lifecycle_states 查询参数（逗号分隔）。 */
function parseLifecycleStates(param: string | null): readonly string[] | undefined {
  if (!param) return undefined;
  return param
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 把 CatalogSearchItem 投影为 admin 响应体（snake_case，附加 catalog_revision）。 */
function projectItem(item: CatalogSearchItem, catalogRevision: number): Record<string, unknown> {
  return {
    resource_type: item.resource_type,
    resource_id: item.resource_id,
    display_name: item.display_name,
    description: item.description,
    tags: item.tags,
    visibility_summary: item.visibility_summary,
    lifecycle_state: item.lifecycle_state,
    owner_user_id: item.owner_user_id,
    catalog_revision: catalogRevision,
    etag: item.etag,
  };
}

export async function GET(request: Request): Promise<Response> {
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

  // 2. 解析查询参数
  const url = new URL(request.url);
  const queryParam = url.searchParams.get("q");
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const resourceTypeParam = url.searchParams.get("resource_types");
  const lifecycleStateParam = url.searchParams.get("lifecycle_states");

  // q 必填：缺失或空白均视为非法
  if (!queryParam || queryParam.trim().length === 0) {
    return schemaInvalidTable(requestId, "q 不能为空");
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 20;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }

  let resourceTypes: readonly CatalogResourceType[] | undefined;
  let lifecycleStates: readonly string[] | undefined;
  try {
    resourceTypes = parseResourceTypes(resourceTypeParam);
    lifecycleStates = parseLifecycleStates(lifecycleStateParam);
  } catch (err) {
    if (err instanceof CatalogQueryError) {
      return schemaInvalidTable(requestId, err.message);
    }
    throw err;
  }

  // 3. 执行搜索
  let result: { items: CatalogSearchItem[]; next_cursor: string | null; catalog_revision: number };
  try {
    result = await searchCatalog({
      tenantId: principal.tenantId,
      query: queryParam,
      resourceTypes,
      lifecycleStates,
      limit,
      cursor: cursor ?? null,
    });
  } catch (err) {
    if (err instanceof CatalogQueryError) {
      return schemaInvalidTable(requestId, err.message);
    }
    throw err;
  }

  // 4. 投影并返回 200
  return apiSuccess(
    {
      items: result.items.map((item) => projectItem(item, result.catalog_revision)),
      next_cursor: result.next_cursor,
      catalog_revision: result.catalog_revision,
    },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}
