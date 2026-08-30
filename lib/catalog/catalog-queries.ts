/**
 * Catalog 查询层（阶段 6 S06-C03）。
 *
 * 事实源：
 * - lib/persistence/schema/catalog.ts
 * - docs/architecture/capability-and-collaboration-api.md §2（Employee Catalog API）、（CatalogSearchItem）
 * - docs/architecture/capabilities-and-security.md §2（统一目录）
 *
 * 职责：
 * - listCatalogOptions：列出目录条目（按 resourceType / lifecycleState 过滤 + 分页）。
 * - searchCatalog：按关键词搜索目录（匹配 displayName / description / tags）。
 * - getCatalogEntryById：按 id 查询单条目录条目（跨租户隔离）。
 * - getCatalogEntryByResource：按 resourceType + resourceId 查询单条目录条目。
 *
 * 关键约束：
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - 资源本身无权访问时不返回（隐藏式，不暴露存在）。
 * - 资源存在但当前 Agent 不支持时返回 selectable=false + disabled_reason_code=AGENT_CAPABILITY_UNSUPPORTED
 * （由 route 层根据当前 Agent 能力判断；本查询层只返回原始数据，route 层做后处理）。
 * - cursor 编码：base64url(JSON({catalogRevision, id}))；按 catalogRevision 降序 + id 升序游标。
 */
import { db } from "@/lib/db/client";
import type { ActionScopeCoverage } from "@/lib/identity/authorization";
import { agentTable } from "@/lib/persistence/schema/agents";
import {
  type CatalogEntry,
  type CatalogResourceType,
  catalogEntryTable,
} from "@/lib/persistence/schema/catalog";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { and, asc, desc, eq, gt, inArray, like, or, sql } from "drizzle-orm";

// ─── 常量 ──────────────────────────────────────────────────

/** 合法 resourceType 集合（校验输入用）。 */
const VALID_RESOURCE_TYPES: readonly CatalogResourceType[] = [
  "agent",
  "skill",
  "tool",
  "knowledge",
  "runtime",
  "model",
  "connection",
];

// ─── 错误类 ────────────────────────────────────────────────

/** Catalog 查询错误（参数非法）。 */
export class CatalogQueryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CatalogQueryError";
  }
}

// ─── CatalogSearchItem 投影 ───────────────────────────────

/**
 * Catalog 搜索结果项（与 CatalogSearchItem 对齐）。
 * snake_case 输出，与 API 响应体字段名一致。
 */
export interface CatalogSearchItem {
  resource_type: string;
  resource_id: string;
  display_name: string;
  description: string | null;
  lifecycle_state: string;
  visibility_summary: string;
  owner_user_id: string | null;
  tags: string[] | null;
  /** 资源级 ETag（catalog-{revision}）；用于客户端缓存。 */
  etag: string;
}

// ─── 员工可执行 Agent 门禁 ─────────────────────────────────

/**
 * 员工端 Agent 可执行性门禁（correlated EXISTS）。
 *
 * 仅当调用方显式传入 routeScopeKey（如员工 Catalog API 的 "default"）时启用：
 * - 非 Agent 资源不受影响（门禁只作用于 resourceType='agent'）。
 * - Agent 条目必须同时满足：
 *   a. 同 tenant 权威 Agent 未软删、lifecycle=enabled、currentRevisionId 非空；
 *   b. 存在同 tenant/agent、routeScopeKey 匹配、eligibilityState=eligible 的
 *      RouteEligibilityProjection。
 * - EXISTS 语义天然去重：同一 Agent 多条 eligible route 只命中一次。
 * - 未传 routeScopeKey（Admin Catalog 等）不启用门禁，行为不变。
 */
function employeeExecutableAgentGate(routeScopeKey: string) {
  return sql`(
    ${catalogEntryTable.resourceType} <> 'agent' OR (
      EXISTS (
        SELECT 1 FROM ${agentTable}
        WHERE ${agentTable.id} = ${catalogEntryTable.resourceId}
          AND ${agentTable.tenantId} = ${catalogEntryTable.tenantId}
          AND ${agentTable.deletedAt} IS NULL
          AND ${agentTable.lifecycleState} = 'enabled'
          AND ${agentTable.currentRevisionId} IS NOT NULL
      )
      AND EXISTS (
        SELECT 1 FROM ${routeEligibilityProjection}
        WHERE ${routeEligibilityProjection.tenantId} = ${catalogEntryTable.tenantId}
          AND ${routeEligibilityProjection.agentId} = ${catalogEntryTable.resourceId}
          AND ${routeEligibilityProjection.routeScopeKey} = ${routeScopeKey}
          AND ${routeEligibilityProjection.eligibilityState} = 'eligible'
      )
    )
  )`;
}

/** Employee Agent 授权门禁：非 Agent 不受影响；Agent 只接受 agent.invoke 覆盖。 */
function employeeAgentAuthorizationGate(coverage: ActionScopeCoverage | undefined) {
  if (!coverage || coverage.actionCode !== "agent.invoke" || coverage.resourceType !== "agent") {
    return sql`${catalogEntryTable.resourceType} <> 'agent'`;
  }
  if (coverage.wildcard) return sql`1 = 1`;
  if (coverage.resourceIds.length === 0) {
    return sql`${catalogEntryTable.resourceType} <> 'agent'`;
  }
  return sql`(
    ${catalogEntryTable.resourceType} <> 'agent'
    OR ${catalogEntryTable.resourceId} IN (${sql.join(
      coverage.resourceIds.map((id) => sql`${id}`),
      sql`, `,
    )})
  )`;
}

// ─── listCatalogOptions ───────────────────────────────────

/** listCatalogOptions 入参。 */
export interface ListCatalogOptionsParams {
  tenantId: string;
  /** 资源类型过滤；不传则返回全部类型。 */
  resourceTypes?: readonly CatalogResourceType[];
  /** lifecycle 状态过滤；不传则返回全部状态。 */
  lifecycleStates?: readonly string[];
  /** 分页大小；默认 50，最大 200。 */
  limit?: number;
  /** 不透明 cursor；不传则从最新条目开始。 */
  cursor?: string | null;
  /**
   * 员工可执行 Agent 门禁：显式传入 routeScopeKey（如 "default"）时，
   * agent 条目必须存在该 scope 下 eligible 的 RouteEligibilityProjection 才返回。
   * 不传则不启用门禁（Admin Catalog 查询不受影响）。
   */
  agentExecutableRouteScopeKey?: string;
  /** 当前主体的 agent.invoke 覆盖；由 Employee API 从 RoleActionBinding 解析。 */
  agentInvokeAuthorization?: ActionScopeCoverage;
}

/** listCatalogOptions 返回。 */
export interface ListCatalogOptionsResult {
  items: CatalogSearchItem[];
  next_cursor: string | null;
  /** 当前租户+employee audience 的最新 catalogRevision（用于 ETag）。 */
  catalog_revision: number;
}

/**
 * 列出目录条目（按 resourceType / lifecycleState 过滤 + cursor 分页）。
 *
 * 排序：catalogRevision 降序（最新在前）+ id 升序（tie-breaker）。
 *
 * cursor 编码：base64url(JSON({catalogRevision, id}))。
 * 游标条件：(catalogRevision < cursor.catalogRevision) OR
 * (catalogRevision = cursor.catalogRevision AND id > cursor.id)
 */
export async function listCatalogOptions(
  params: ListCatalogOptionsParams,
): Promise<ListCatalogOptionsResult> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const conditions = [eq(catalogEntryTable.tenantId, params.tenantId)];

  if (params.resourceTypes && params.resourceTypes.length > 0) {
    for (const rt of params.resourceTypes) {
      if (!isValidResourceType(rt)) {
        throw new CatalogQueryError("invalid_resource_type", `resourceType 非法: ${rt}`);
      }
    }
    conditions.push(inArray(catalogEntryTable.resourceType, [...params.resourceTypes]));
  }
  if (params.lifecycleStates && params.lifecycleStates.length > 0) {
    conditions.push(inArray(catalogEntryTable.lifecycleState, [...params.lifecycleStates]));
  }

  if (params.agentExecutableRouteScopeKey) {
    conditions.push(employeeExecutableAgentGate(params.agentExecutableRouteScopeKey));
  }
  if (params.agentExecutableRouteScopeKey || params.agentInvokeAuthorization) {
    conditions.push(employeeAgentAuthorizationGate(params.agentInvokeAuthorization));
  }

  if (params.cursor) {
    const decoded = decodeListCursor(params.cursor);
    if (decoded) {
      // 按 catalogRevision 降序取下一页：当前条目的 revision < cursor.revision
      // 或 revision 相等且 id > cursor.id（tie-breaker）
      const cursorCondition = or(
        sql`${catalogEntryTable.catalogRevision} < ${decoded.catalogRevision}`,
        and(
          eq(catalogEntryTable.catalogRevision, decoded.catalogRevision),
          gt(catalogEntryTable.id, decoded.id),
        ),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }
  }

  const rows = await db
    .select()
    .from(catalogEntryTable)
    .where(and(...conditions))
    .orderBy(desc(catalogEntryTable.catalogRevision), asc(catalogEntryTable.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastItem = items[items.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? encodeListCursor({
          catalogRevision: lastItem.catalogRevision,
          id: lastItem.id,
        })
      : null;

  // catalog_revision：返回当前最大 revision（便于 route 层构造 ETag）
  const firstItem = items[0];
  const catalogRevision = firstItem ? firstItem.catalogRevision : 0;

  return {
    items: items.map(projectToSearchItem),
    next_cursor: nextCursor,
    catalog_revision: catalogRevision,
  };
}

// ─── searchCatalog ────────────────────────────────────────

/** searchCatalog 入参。 */
export interface SearchCatalogParams {
  tenantId: string;
  /** 搜索关键词（匹配 displayName / description，前后 % 模糊匹配）。 */
  query: string;
  /** 资源类型过滤；不传则搜索全部类型。 */
  resourceTypes?: readonly CatalogResourceType[];
  /** lifecycle 状态过滤；不传则搜索全部状态。 */
  lifecycleStates?: readonly string[];
  /** 分页大小；默认 50，最大 200。 */
  limit?: number;
  /** 不透明 cursor；不传则从最新条目开始。 */
  cursor?: string | null;
  /**
   * 员工可执行 Agent 门禁：显式传入 routeScopeKey（如 "default"）时，
   * agent 条目必须存在该 scope 下 eligible 的 RouteEligibilityProjection 才返回。
   * 不传则不启用门禁（Admin Catalog 查询不受影响）。
   */
  agentExecutableRouteScopeKey?: string;
  /** 当前主体的 agent.invoke 覆盖；由 Employee API 从 RoleActionBinding 解析。 */
  agentInvokeAuthorization?: ActionScopeCoverage;
}

/** searchCatalog 返回。 */
export interface SearchCatalogResult {
  items: CatalogSearchItem[];
  next_cursor: string | null;
  /** 当前租户+employee audience 的最新 catalogRevision。 */
  catalog_revision: number;
}

/**
 * 按关键词搜索目录（匹配 displayName / description，模糊匹配）。
 *
 * 排序与 cursor 同 listCatalogOptions。
 */
export async function searchCatalog(params: SearchCatalogParams): Promise<SearchCatalogResult> {
  if (!params.query || params.query.trim().length === 0) {
    throw new CatalogQueryError("empty_query", "query 不能为空");
  }
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const queryPattern = `%${params.query.trim()}%`;

  const conditions = [
    eq(catalogEntryTable.tenantId, params.tenantId),
    or(
      like(catalogEntryTable.displayName, queryPattern),
      like(catalogEntryTable.description, queryPattern),
    ),
  ];

  if (params.resourceTypes && params.resourceTypes.length > 0) {
    for (const rt of params.resourceTypes) {
      if (!isValidResourceType(rt)) {
        throw new CatalogQueryError("invalid_resource_type", `resourceType 非法: ${rt}`);
      }
    }
    conditions.push(inArray(catalogEntryTable.resourceType, [...params.resourceTypes]));
  }
  if (params.lifecycleStates && params.lifecycleStates.length > 0) {
    conditions.push(inArray(catalogEntryTable.lifecycleState, [...params.lifecycleStates]));
  }

  if (params.agentExecutableRouteScopeKey) {
    conditions.push(employeeExecutableAgentGate(params.agentExecutableRouteScopeKey));
  }
  if (params.agentExecutableRouteScopeKey || params.agentInvokeAuthorization) {
    conditions.push(employeeAgentAuthorizationGate(params.agentInvokeAuthorization));
  }

  if (params.cursor) {
    const decoded = decodeListCursor(params.cursor);
    if (decoded) {
      const cursorCondition = or(
        sql`${catalogEntryTable.catalogRevision} < ${decoded.catalogRevision}`,
        and(
          eq(catalogEntryTable.catalogRevision, decoded.catalogRevision),
          gt(catalogEntryTable.id, decoded.id),
        ),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }
  }

  const rows = await db
    .select()
    .from(catalogEntryTable)
    .where(and(...conditions))
    .orderBy(desc(catalogEntryTable.catalogRevision), asc(catalogEntryTable.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastItem = items[items.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? encodeListCursor({
          catalogRevision: lastItem.catalogRevision,
          id: lastItem.id,
        })
      : null;

  const firstItem = items[0];
  const catalogRevision = firstItem ? firstItem.catalogRevision : 0;

  return {
    items: items.map(projectToSearchItem),
    next_cursor: nextCursor,
    catalog_revision: catalogRevision,
  };
}

// ─── 单条查询 ──────────────────────────────────────────────

/** 按 id 查询单条目录条目（跨租户隔离）。不存在返回 null。 */
export async function getCatalogEntryById(params: {
  tenantId: string;
  entryId: string;
}): Promise<CatalogEntry | null> {
  const [row] = await db
    .select()
    .from(catalogEntryTable)
    .where(
      and(
        eq(catalogEntryTable.tenantId, params.tenantId),
        eq(catalogEntryTable.id, params.entryId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 按 resourceType + resourceId 查询单条目录条目（跨租户隔离）。不存在返回 null。 */
export async function getCatalogEntryByResource(params: {
  tenantId: string;
  resourceType: CatalogResourceType;
  resourceId: string;
}): Promise<CatalogEntry | null> {
  if (!isValidResourceType(params.resourceType)) {
    throw new CatalogQueryError(
      "invalid_resource_type",
      `resourceType 非法: ${params.resourceType}`,
    );
  }
  const [row] = await db
    .select()
    .from(catalogEntryTable)
    .where(
      and(
        eq(catalogEntryTable.tenantId, params.tenantId),
        eq(catalogEntryTable.resourceType, params.resourceType),
        eq(catalogEntryTable.resourceId, params.resourceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ─── 内部工具 ──────────────────────────────────────────────

/** 校验 resourceType 是否在已知枚举内。 */
function isValidResourceType(type: string): type is CatalogResourceType {
  return (VALID_RESOURCE_TYPES as readonly string[]).includes(type);
}

/** 把 CatalogEntry 行投影为 CatalogSearchItem（snake_case 输出）。 */
function projectToSearchItem(row: CatalogEntry): CatalogSearchItem {
  return {
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    display_name: row.displayName,
    description: row.description,
    lifecycle_state: row.lifecycleState,
    visibility_summary: row.visibilitySummary,
    owner_user_id: row.ownerUserId,
    tags: row.tagsJson as string[] | null,
    etag: `catalog-${row.catalogRevision}`,
  };
}

/** 编码不透明 cursor（base64url(JSON)）。 */
function encodeListCursor(payload: { catalogRevision: number; id: string }): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

/** 解码不透明 cursor。非法返回 null。 */
function decodeListCursor(cursor: string): {
  catalogRevision: number;
  id: string;
} | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf-8");
    const parsed = JSON.parse(json) as { catalogRevision?: number; id?: string };
    if (typeof parsed.catalogRevision !== "number" || typeof parsed.id !== "string") {
      return null;
    }
    return { catalogRevision: parsed.catalogRevision, id: parsed.id };
  } catch {
    return null;
  }
}

// ─── Re-exports ────────────────────────────────────────────

export type {
  CatalogResourceType,
  CatalogEntry,
} from "@/lib/persistence/schema/catalog";
