/**
 * GET /api/v1/catalog/options — Employee Catalog API（阶段 6 S06-C03）。
 *
 * 事实源：docs/architecture/capability-and-collaboration-api.md §2（Employee Catalog API）、
 *         §3.1（CatalogSearchItem）。
 *
 * 行为：
 * - 解析员工身份（employee audience）。
 * - 支持查询参数：resource_type（逗号分隔）、lifecycle_state（逗号分隔）、limit、cursor、q（搜索关键词）。
 * - If-None-Match 短路径：客户端 ETag 与当前 catalogRevision 匹配时返回 304 Not Modified
 *   （仅当无 q 搜索时生效；搜索结果可能因内容匹配变化，不参与短路径）。
 * - 200 响应附带 ETag 头（catalog-{tenantId}-employee-{revisionNo}）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - resource_type / lifecycle_state 非法 → 400 REQUEST_SCHEMA_INVALID
 * - cursor 非法 → 400 REQUEST_SCHEMA_INVALID
 * - If-None-Match 格式非法 → 400 CATALOG_REVISION_INVALID
 */
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import { API_ERROR_CODES } from "@/lib/error-codes";
import { REQUEST_ID_HEADER, apiSuccess, etagHeader, getRequestId } from "@/lib/http";
import type { CatalogResourceType } from "@/lib/persistence/schema/catalog";
import { buildCatalogRevisionEtag, parseCatalogRevisionEtag } from "@/lib/admin/route-helpers";
import {
  CatalogQueryError,
  type CatalogSearchItem,
  type ListCatalogOptionsResult,
  type SearchCatalogResult,
  listCatalogOptions,
  searchCatalog,
} from "@/lib/catalog/catalog-queries";
import { getCurrentCatalogRevision } from "@/lib/catalog/projector";

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

/** 请求体 schema 校验：解析 resource_type 查询参数（逗号分隔）。 */
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

/** 解析 lifecycle_state 查询参数（逗号分隔）。 */
function parseLifecycleStates(param: string | null): readonly string[] | undefined {
  if (!param) return undefined;
  const parts = param
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts;
}

/** 解析 If-None-Match 头，返回裸 ETag 值（去引号）；缺失返回 null。 */
function parseIfNoneMatch(request: Request): string | null {
  const raw = request.headers.get("if-none-match");
  if (!raw || !raw.trim()) return null;
  return raw.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

/** 构造 400 CATALOG_REVISION_INVALID 响应。 */
function catalogRevisionInvalid(requestId: string, message: string): Response {
  return Response.json(
    {
      error: {
        code: "CATALOG_REVISION_INVALID",
        message,
        request_id: requestId,
        retryable: false,
      },
    },
    {
      status: API_ERROR_CODES.CATALOG_REVISION_INVALID.http,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析员工身份
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析查询参数
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const resourceTypeParam = url.searchParams.get("resource_type");
  const lifecycleStateParam = url.searchParams.get("lifecycle_state");
  const searchQuery = url.searchParams.get("q");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
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

  // 3. 处理 If-None-Match 短路径（仅 listCatalogOptions 适用；searchQuery 不参与短路径）
  const currentRevision = await getCurrentCatalogRevision({
    tenantId: principal.tenantId,
    audience: "employee",
  });
  const currentEtag = buildCatalogRevisionEtag(principal.tenantId, "employee", currentRevision);

  if (!searchQuery) {
    const ifNoneMatch = parseIfNoneMatch(request);
    if (ifNoneMatch) {
      let parsedRevision: number;
      try {
        parsedRevision = parseCatalogRevisionEtag(ifNoneMatch);
      } catch {
        return catalogRevisionInvalid(requestId, `If-None-Match 格式非法: ${ifNoneMatch}`);
      }
      if (parsedRevision === currentRevision) {
        // 短路径：目录未变化，返回 304
        return new Response(null, {
          status: 304,
          headers: {
            [REQUEST_ID_HEADER]: requestId,
            ...etagHeader(currentEtag),
          },
        });
      }
    }
  }

  // 4. 执行查询
  let result: {
    items: CatalogSearchItem[];
    next_cursor: string | null;
    catalog_revision: number;
  };
  try {
    if (searchQuery) {
      const searchResult: SearchCatalogResult = await searchCatalog({
        tenantId: principal.tenantId,
        query: searchQuery,
        resourceTypes,
        lifecycleStates,
        limit,
        cursor: cursor ?? null,
      });
      result = searchResult;
    } else {
      const listResult: ListCatalogOptionsResult = await listCatalogOptions({
        tenantId: principal.tenantId,
        resourceTypes,
        lifecycleStates,
        limit,
        cursor: cursor ?? null,
      });
      result = listResult;
    }
  } catch (err) {
    if (err instanceof CatalogQueryError) {
      return schemaInvalidTable(requestId, err.message);
    }
    throw err;
  }

  // 5. 返回 200 + ETag
  return apiSuccess(
    {
      items: result.items,
      next_cursor: result.next_cursor,
      catalog_revision: result.catalog_revision,
    },
    {
      status: 200,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(currentEtag),
      },
    },
  );
}
