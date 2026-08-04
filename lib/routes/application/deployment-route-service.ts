/**
 * DeploymentRoute 查询与写入应用服务。
 *
 * 新写入全部委托 RouteRevision 激活事务；DeploymentRouteRow 作为调度器读取的当前投影。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import type { AuditActor } from "@/lib/identity/audit";
import {
  type DeploymentRouteRow,
  type DeploymentRouteSetRow,
  type RouteState,
  deploymentRouteSetTable,
  deploymentRouteTable,
} from "@/lib/persistence/schema/control-plane";
import { createActivateRouteRevision } from "@/lib/routes/application/activate-route-revision";
import type { ActivateRouteRevisionResult } from "@/lib/routes/application/activate-route-revision";
import {
  AgentCapabilityUnsupportedError,
  ArtifactNotVerifiedForRouteError,
  MAX_ROUTE_TRAFFIC_WEIGHT,
  RevisionNotPublishedError,
  RouteNotFoundError,
  RouteSetNotFoundError,
  RouteSetVersionConflictError,
  RouteWeightInvalidError,
} from "@/lib/routes/domain/route-revision";
import { mysqlRouteControlStore } from "@/lib/routes/persistence/mysql-route-control-store";
import { and, desc, eq } from "drizzle-orm";

export const MAX_TRAFFIC_WEIGHT = MAX_ROUTE_TRAFFIC_WEIGHT;
export {
  AgentCapabilityUnsupportedError,
  ArtifactNotVerifiedForRouteError,
  RevisionNotPublishedError,
  RouteNotFoundError,
  RouteSetNotFoundError,
  RouteSetVersionConflictError,
  RouteWeightInvalidError,
};

const activateRouteRevision = createActivateRouteRevision({ store: mysqlRouteControlStore });

export async function createRouteSet(params: {
  tenantId: string;
  agentId: string;
  routeScopeKey: string;
  routeScopeJson: Record<string, unknown>;
}): Promise<DeploymentRouteSetRow> {
  const id = randomUUID();
  await db.insert(deploymentRouteSetTable).values({ ...params, id, versionNo: 1 });
  const [row] = await db
    .select()
    .from(deploymentRouteSetTable)
    .where(eq(deploymentRouteSetTable.id, id))
    .limit(1);
  if (!row) throw new Error(`createRouteSet: 行未找到（id=${id}）`);
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

export async function getEffectiveRoutes(
  tenantId: string,
  agentId: string,
  routeScopeKey: string,
): Promise<DeploymentRouteRow[]> {
  const routeSet = await getRouteSetByAgentScope(tenantId, agentId, routeScopeKey);
  if (!routeSet) return [];
  return listRoutesBySet(routeSet.id, { routeState: "enabled" });
}

export interface UpsertDeploymentRouteResult {
  route: DeploymentRouteRow;
  routeSet: DeploymentRouteSetRow;
  routeRevision: ActivateRouteRevisionResult["routeRevision"];
  routeActivation: ActivateRouteRevisionResult["routeActivation"];
  etag: string;
  auditEventId: string;
  affectsNewInvocationsOnly: true;
}

export interface RouteIdempotencyCompletion {
  recordId: string;
  httpStatus: number;
  responseRef?: string | null;
  serializeResponse: (result: UpsertDeploymentRouteResult) => string;
}

export async function upsertDeploymentRoute(params: {
  tenantId: string;
  routeSetId: string;
  routeId?: string;
  routeSetExpectedVersionNo: number;
  agentRevisionId: string;
  runtimeRevisionId: string;
  trafficWeight: number;
  priorityNo?: number;
  routeState?: RouteState;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  actor: AuditActor;
  requestId?: string;
  idempotencyKey?: string;
  idempotency?: RouteIdempotencyCompletion;
}): Promise<UpsertDeploymentRouteResult> {
  const result = await activateRouteRevision({
    tenantId: params.tenantId,
    routeSetId: params.routeSetId,
    routeId: params.routeId,
    routeSetExpectedVersionNo: params.routeSetExpectedVersionNo,
    content: {
      agentRevisionId: params.agentRevisionId,
      runtimeRevisionId: params.runtimeRevisionId,
      policyRevisionId: null,
      modelPolicyRevisionId: null,
      toolsetRevisionId: null,
      trafficWeight: params.trafficWeight,
      priorityNo: params.priorityNo ?? 0,
      effectiveFrom: params.effectiveFrom ?? null,
      effectiveUntil: params.effectiveUntil ?? null,
      eligibilityConditions: {},
    },
    activationState: params.routeState === "disabled" ? "disabled" : "active",
    actor: params.actor,
    reason:
      params.routeState === "disabled"
        ? "DeploymentRoute 禁用"
        : `DeploymentRoute 更新（${params.routeState ?? "enabled"}，权重 ${params.trafficWeight} 基点）`,
    requestId: params.requestId ?? randomUUID(),
    idempotencyKey: params.idempotencyKey ?? `route-activate:${randomUUID()}`,
    idempotency: params.idempotency
      ? {
          ...params.idempotency,
          serializeResponse: (value) =>
            params.idempotency?.serializeResponse(value as UpsertDeploymentRouteResult) ?? "{}",
        }
      : undefined,
  });
  return result as UpsertDeploymentRouteResult;
}

export type DisableDeploymentRouteResult = UpsertDeploymentRouteResult;

export async function disableDeploymentRoute(params: {
  tenantId: string;
  routeSetId: string;
  routeSetExpectedVersionNo: number;
  routeId: string;
  actor: AuditActor;
  requestId?: string;
  idempotencyKey?: string;
  idempotency?: RouteIdempotencyCompletion;
}): Promise<DisableDeploymentRouteResult> {
  const route = await getRouteById(params.tenantId, params.routeId);
  if (!route || route.routeSetId !== params.routeSetId)
    throw new RouteNotFoundError(params.routeId);
  return upsertDeploymentRoute({
    ...params,
    agentRevisionId: route.agentRevisionId,
    runtimeRevisionId: route.runtimeRevisionId,
    trafficWeight: route.trafficWeight,
    priorityNo: route.priorityNo,
    routeState: "disabled",
    effectiveFrom: route.effectiveFrom,
    effectiveUntil: route.effectiveUntil,
    idempotencyKey: params.idempotencyKey ?? `route-disable:${randomUUID()}`,
  });
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
} from "@/lib/persistence/schema/control-plane";
