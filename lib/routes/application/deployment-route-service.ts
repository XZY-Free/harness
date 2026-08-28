/**
 * DeploymentRoute 查询与写入应用服务。
 *
 * 只提供 RouteSet / Route 查询与 RouteSet 身份创建。
 * 写入统一由 ActivateRouteSet 和 DisableRoute 两个正式命令负责。
 */
import { randomUUID } from "node:crypto";
import { rfc8785Canonicalize } from "@/lib/crypto/rfc-8785-canonicalize";
import { db } from "@/lib/db/client";
import { isMysqlDuplicateEntryError } from "@/lib/db/mysql-error";
import {
  type DeploymentRouteRow,
  type DeploymentRouteSetRow,
  type RouteState,
  deploymentRouteSetTable,
  deploymentRouteTable,
} from "@/lib/persistence/schema/routes";
import {
  ArtifactNotVerifiedForRouteError,
  MAX_ROUTE_TRAFFIC_WEIGHT,
  RevisionNotPublishedError,
  RouteNotFoundError,
  RouteSetNotFoundError,
  RouteSetVersionConflictError,
  RouteWeightInvalidError,
} from "@/lib/routes/domain/route-revision";
import { and, desc, eq } from "drizzle-orm";

export const MAX_TRAFFIC_WEIGHT = MAX_ROUTE_TRAFFIC_WEIGHT;
export {
  ArtifactNotVerifiedForRouteError,
  RevisionNotPublishedError,
  RouteNotFoundError,
  RouteSetNotFoundError,
  RouteSetVersionConflictError,
  RouteWeightInvalidError,
};

export async function createRouteSet(params: {
  tenantId: string;
  /** null = 基础 Harness RouteSet（无 Agent 资产约束）。 */
  agentId: string | null;
  routeScopeKey: string;
  routeScopeJson: Record<string, unknown>;
}): Promise<DeploymentRouteSetRow> {
  const id = randomUUID();
  await db
    .insert(deploymentRouteSetTable)
    .values({ ...params, targetKind: params.agentId ? "agent" : "runtime", id, versionNo: 1 });
  const [row] = await db
    .select()
    .from(deploymentRouteSetTable)
    .where(eq(deploymentRouteSetTable.id, id))
    .limit(1);
  if (!row) throw new Error(`createRouteSet: 行未找到（id=${id}）`);
  return row;
}

/** 同自然键 (tenantId, agentId, routeScopeKey) 下 route_scope 语义不一致。 */
export class RouteSetScopeMismatchError extends Error {
  constructor(routeSetId: string) {
    super(`RouteSet 已存在且 route_scope 与请求不一致（routeSetId=${routeSetId}）`);
    this.name = "RouteSetScopeMismatchError";
  }
}

export interface EnsureRouteSetResult {
  routeSet: DeploymentRouteSetRow;
  /** true = 本次请求创建了新行；false = 复用既有自然键行。 */
  created: boolean;
}

/**
 * create-or-reuse：按自然键 (tenantId, agentId, routeScopeKey) 创建或复用 RouteSet。
 *
 * - 首次创建固定 route_scope（RFC 8785 语义比较，key 顺序无关）；此后不可变。
 * - 并发不同调用竞争同一自然键：依赖 MySQL UNIQUE 约束，duplicate-entry 判定
 *   仅认 isMysqlDuplicateEntryError，其余 DB 错误原样上抛；败者回读复用。
 */
export async function ensureRouteSetByAgentScope(params: {
  tenantId: string;
  agentId: string;
  routeScopeKey: string;
  routeScopeJson: Record<string, unknown>;
}): Promise<EnsureRouteSetResult> {
  const existing = await getRouteSetByAgentScope(
    params.tenantId,
    params.agentId,
    params.routeScopeKey,
  );
  if (existing)
    return { routeSet: assertScopeMatch(existing, params.routeScopeJson), created: false };

  const id = randomUUID();
  try {
    await db
      .insert(deploymentRouteSetTable)
      .values({ ...params, targetKind: params.agentId ? "agent" : "runtime", id, versionNo: 1 });
  } catch (error) {
    if (!isMysqlDuplicateEntryError(error)) throw error;
    const [row] = await db
      .select()
      .from(deploymentRouteSetTable)
      .where(
        and(
          eq(deploymentRouteSetTable.tenantId, params.tenantId),
          eq(deploymentRouteSetTable.agentId, params.agentId),
          eq(deploymentRouteSetTable.routeScopeKey, params.routeScopeKey),
        ),
      )
      .limit(1);
    if (!row) throw error;
    return { routeSet: assertScopeMatch(row, params.routeScopeJson), created: false };
  }
  const [row] = await db
    .select()
    .from(deploymentRouteSetTable)
    .where(eq(deploymentRouteSetTable.id, id))
    .limit(1);
  if (!row) throw new Error(`ensureRouteSetByAgentScope: 行未找到（id=${id}）`);
  return { routeSet: row, created: true };
}

/** route_scope 首次创建后不可变：语义不一致时 fail-closed。 */
function assertScopeMatch(
  row: DeploymentRouteSetRow,
  routeScopeJson: Record<string, unknown>,
): DeploymentRouteSetRow {
  if (rfc8785Canonicalize(row.routeScopeJson) !== rfc8785Canonicalize(routeScopeJson)) {
    throw new RouteSetScopeMismatchError(row.id);
  }
  return row;
}

export async function getRouteSetById(
  tenantId: string,
  routeSetId: string,
): Promise<DeploymentRouteSetRow | null> {
  const [row] = await db
    .select()
    .from(deploymentRouteSetTable)
    .where(
      and(
        eq(deploymentRouteSetTable.id, routeSetId),
        eq(deploymentRouteSetTable.tenantId, tenantId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getRouteSetByAgentScope(
  tenantId: string,
  agentId: string,
  routeScopeKey: string,
): Promise<DeploymentRouteSetRow | null> {
  const [row] = await db
    .select()
    .from(deploymentRouteSetTable)
    .where(
      and(
        eq(deploymentRouteSetTable.tenantId, tenantId),
        eq(deploymentRouteSetTable.agentId, agentId),
        eq(deploymentRouteSetTable.routeScopeKey, routeScopeKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getRouteById(
  tenantId: string,
  routeId: string,
): Promise<DeploymentRouteRow | null> {
  const [row] = await db
    .select({ route: deploymentRouteTable })
    .from(deploymentRouteTable)
    .innerJoin(
      deploymentRouteSetTable,
      eq(deploymentRouteTable.routeSetId, deploymentRouteSetTable.id),
    )
    .where(
      and(eq(deploymentRouteTable.id, routeId), eq(deploymentRouteSetTable.tenantId, tenantId)),
    )
    .limit(1);
  return row?.route ?? null;
}

export async function listRoutesBySet(
  routeSetId: string,
  options?: { routeState?: RouteState },
): Promise<DeploymentRouteRow[]> {
  const conditions = [eq(deploymentRouteTable.routeSetId, routeSetId)];
  if (options?.routeState) conditions.push(eq(deploymentRouteTable.routeState, options.routeState));
  return db
    .select()
    .from(deploymentRouteTable)
    .where(and(...conditions))
    .orderBy(desc(deploymentRouteTable.createdAt));
}

/**
 * : 列出指定 Agent+Scope 下的所有 enabled 路由投影。
 *
 * **注意：此函数仅供控制面查询使用，禁止执行链调用。**
 * 执行链必须通过 RouteEligibilityResolutionStore.loadCandidates() 走投影匹配路径。
 */
export async function listEnabledRouteProjections(
  tenantId: string,
  agentId: string,
  routeScopeKey: string,
): Promise<DeploymentRouteRow[]> {
  const routeSet = await getRouteSetByAgentScope(tenantId, agentId, routeScopeKey);
  if (!routeSet) return [];
  return listRoutesBySet(routeSet.id, { routeState: "enabled" });
}

export interface RouteSetSnapshot {
  routeSetId: string;
  versionNo: number;
  enabledRoutes: DeploymentRouteRow[];
}

export async function getRouteSetSnapshot(
  tenantId: string,
  routeSetId: string,
): Promise<RouteSetSnapshot> {
  const routeSet = await getRouteSetById(tenantId, routeSetId);
  if (!routeSet) throw new RouteSetNotFoundError(routeSetId);
  return {
    routeSetId,
    versionNo: routeSet.versionNo,
    enabledRoutes: await listRoutesBySet(routeSetId, { routeState: "enabled" }),
  };
}

export type {
  RouteState,
  DeploymentRouteRow,
  DeploymentRouteSetRow,
} from "@/lib/persistence/schema/routes";
