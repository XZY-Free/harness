/**
 * POST /gateway/v1/capabilities:search — Runtime 搜索可用能力（阶段 6 S06-C04）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §3（Gateway API）、§2.5（成功与错误格式）。
 * - ../v11-agentkit-platform/12-capability-and-collaboration-api.md §3.1（CatalogSearchItem）。
 *
 * 行为：
 * - 解析 Bearer Token（Workload Token，audience=gateway）。
 * - 校验请求体（query 必填非空；resource_types / lifecycle_states / limit / cursor 可选）。
 * - 复用 searchCatalog（按 tenantId 过滤，跨租户隔离由仓储层保证）。
 * - 返回 items + next_cursor + catalog_revision，附带 ETag 头供后续 If-None-Match 短路径。
 *
 * ETag 格式：`catalog-{tenantId}-gateway-{revisionNo}`（Gateway 专属受众后缀）。
 * Gateway Token 短 TTL，If-None-Match 短路径主要服务于同 Invocation 内的重复拉取。
 *
 * 错误映射：
 * - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 * - 请求体非法 / query 为空 → 400 REQUEST_SCHEMA_INVALID
 * - resource_type 非法 → 400 REQUEST_SCHEMA_INVALID
 * - cursor 非法 → 400 REQUEST_SCHEMA_INVALID
 */
import { REQUEST_ID_HEADER, apiSuccess, etagHeader, getRequestId } from "@/lib/http";
import { CATALOG_RESOURCE_TYPES, type CatalogResourceType } from "@/lib/persistence/schema/catalog";
import {
  CatalogQueryError,
  type SearchCatalogResult,
  searchCatalog,
} from "@/lib/catalog/catalog-queries";
import { getCurrentCatalogRevision } from "@/lib/catalog/projector";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  gatewayCatalogRevisionInvalidTable,
  gatewaySchemaInvalidTable,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";

export const dynamic = "force-dynamic";

/** 合法 resourceType 集合（运行时校验输入用）。 */
const VALID_RESOURCE_TYPES: readonly string[] = [...CATALOG_RESOURCE_TYPES];

/** 请求体 schema。 */
interface SearchCapabilitiesBody {
  query: string;
  resource_types?: string[];
  lifecycle_states?: string[];
  limit?: number;
  cursor?: string;
}

/** 校验请求体结构。 */
function validateBody(body: unknown): body is SearchCapabilitiesBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.query !== "string" || b.query.trim().length === 0) return false;
  if (b.resource_types !== undefined && b.resource_types !== null) {
    if (!Array.isArray(b.resource_types)) return false;
    for (const rt of b.resource_types) {
      if (typeof rt !== "string" || !VALID_RESOURCE_TYPES.includes(rt)) return false;
    }
  }
  if (b.lifecycle_states !== undefined && b.lifecycle_states !== null) {
    if (!Array.isArray(b.lifecycle_states)) return false;
    for (const ls of b.lifecycle_states) {
      if (typeof ls !== "string" || ls.length === 0) return false;
    }
  }
  if (b.limit !== undefined && b.limit !== null) {
    if (typeof b.limit !== "number" || !Number.isFinite(b.limit) || b.limit <= 0) return false;
  }
  if (b.cursor !== undefined && b.cursor !== null) {
    if (typeof b.cursor !== "string" || b.cursor.length === 0) return false;
  }
  return true;
}

/** 构造 Gateway 专属 Catalog ETag（catalog-{tenantId}-gateway-{revisionNo}）。 */
function buildGatewayCatalogEtag(tenantId: string, revisionNo: number): string {
  return `catalog-${tenantId}-gateway-${revisionNo}`;
}

/** 解析 If-None-Match 头，去掉弱验证前缀 `W/` 与引号，返回裸 ETag 值；缺失返回 null。 */
function parseIfNoneMatch(request: Request): string | null {
  const raw = request.headers.get("if-none-match");
  if (!raw || !raw.trim()) return null;
  return raw.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

/** 从 If-None-Match ETag 提取 revisionNo；非法返回 null。 */
function parseGatewayCatalogEtagRevision(etag: string): number | null {
  // 形如 catalog-{tenantId}-gateway-{revisionNo}
  const marker = "-gateway-";
  const idx = etag.indexOf(marker);
  if (idx < 0) return null;
  const revisionStr = etag.slice(idx + marker.length);
  const revisionNo = Number.parseInt(revisionStr, 10);
  if (!Number.isFinite(revisionNo) || revisionNo < 0) return null;
  return revisionNo;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析 Gateway 身份（audience=gateway）
  let claims: GatewayPrincipal;
  try {
    claims = await resolveGatewayPrincipal(request.headers);
  } catch (err) {
    const authResp = gatewayAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return gatewaySchemaInvalidTable(
      requestId,
      "请求体非法：query 必填非空；resource_types / lifecycle_states 必须为字符串数组；limit 必须为正整数",
    );
  }

  // 3. 规范化参数
  const limit = body.limit ?? 50;
  const resourceTypes: readonly CatalogResourceType[] | undefined =
    body.resource_types && body.resource_types.length > 0
      ? (body.resource_types as CatalogResourceType[])
      : undefined;
  const lifecycleStates: readonly string[] | undefined =
    body.lifecycle_states && body.lifecycle_states.length > 0 ? body.lifecycle_states : undefined;
  const cursor = body.cursor ?? null;

  // 4. 读取当前 catalogRevision（用于 ETag + If-None-Match 短路径）
  //    投影器 refreshCatalogEntry 当前仅推进 employee audience 的 CatalogRevision；
  //    runtime audience revision 始终为 0，故 Gateway 复用 employee revision 作为
  //    目录状态游标（catalog_entry 表本身跨 audience 共享，无 audience 列）。
  //    ETag 前缀仍用 `gateway` 标识 Gateway 专属视角，与 employee API 的 ETag 区分。
  const currentRevision = await getCurrentCatalogRevision({
    tenantId: claims.tenantId,
    audience: "employee",
  });
  const currentEtag = buildGatewayCatalogEtag(claims.tenantId, currentRevision);

  // 5. If-None-Match 短路径：客户端 ETag 与当前 revision 匹配 → 304 Not Modified
  const ifNoneMatch = parseIfNoneMatch(request);
  if (ifNoneMatch) {
    const parsedRevision = parseGatewayCatalogEtagRevision(ifNoneMatch);
    if (parsedRevision === null) {
      return gatewayCatalogRevisionInvalidTable(
        requestId,
        `If-None-Match 格式非法: ${ifNoneMatch}`,
      );
    }
    if (parsedRevision === currentRevision) {
      return new Response(null, {
        status: 304,
        headers: {
          [REQUEST_ID_HEADER]: requestId,
          ...etagHeader(currentEtag),
        },
      });
    }
  }

  // 6. 执行搜索
  let result: SearchCatalogResult;
  try {
    result = await searchCatalog({
      tenantId: claims.tenantId,
      query: body.query,
      resourceTypes,
      lifecycleStates,
      limit,
      cursor,
    });
  } catch (err) {
    if (err instanceof CatalogQueryError) {
      return gatewaySchemaInvalidTable(requestId, err.message);
    }
    throw err;
  }

  // 7. 返回 200 + ETag
  //    Gateway 不在此处记录 CapabilityUse：搜索只返回目录元数据，
  //    实际能力使用账本在 GET /tools/{id}/schema 与 GET /skills/{id}/content 时记录。
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
