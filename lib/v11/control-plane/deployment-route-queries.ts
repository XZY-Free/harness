/**
 * DeploymentRoute 兼容查询与写入 Facade。
 *
 * 新写入全部委托稳定 routes 应用服务；V11DeploymentRoute 仅保留为旧调度器读取的当前投影。
 */
import { randomUUID } from "node:crypto";
import { mysqlRouteControlStore } from "@/lib/compatibility/routes/mysql-route-control-store";
import { db } from "@/lib/db/client";
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
import type { AuditActor } from "@/lib/v11/identity/audit";
import {
  type RouteState,
  type V11DeploymentRoute,
  type V11DeploymentRouteSet,
  v11DeploymentRoute,
  v11DeploymentRouteSet,
} from "@/lib/v11/schema/deployment-route";
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
}): Promise<V11DeploymentRouteSet> {
  const id = randomUUID();
  await db.insert(v11DeploymentRouteSet).values({ ...params, id, versionNo: 1 });
  const [row] = await db
    .select()
    .from(v11DeploymentRouteSet)
    .where(eq(v11DeploymentRouteSet.id, id))
    .limit(1);
  if (!row) throw new Error(`createRouteSet: 行未找到（id=${id}）`);
  return row;
}

export async function getRouteSetById(
  tenantId: string,
  routeSetId: string,
): Promise<V11DeploymentRouteSet | null> {
  const [row] = await db
    .select()
    .from(v11DeploymentRouteSet)
    .where(
      and(eq(v11DeploymentRouteSet.id, routeSetId), eq(v11DeploymentRouteSet.tenantId, tenantId)),
    )
    .limit(1);
  return row ?? null;
}

export async function getRouteSetByAgentScope(
  tenantId: string,
  agentId: string,
  routeScopeKey: string,
): Promise<V11DeploymentRouteSet | null> {
  const [row] = await db
    .select()
    .from(v11DeploymentRouteSet)
    .where(
      and(
        eq(v11DeploymentRouteSet.tenantId, tenantId),
        eq(v11DeploymentRouteSet.agentId, agentId),
        eq(v11DeploymentRouteSet.routeScopeKey, routeScopeKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getRouteById(
  tenantId: string,
  routeId: string,
): Promise<V11DeploymentRoute | null> {
  const [row] = await db
    .select({ route: v11DeploymentRoute })
    .from(v11DeploymentRoute)
    .innerJoin(v11DeploymentRouteSet, eq(v11DeploymentRoute.routeSetId, v11DeploymentRouteSet.id))
    .where(and(eq(v11DeploymentRoute.id, routeId), eq(v11DeploymentRouteSet.tenantId, tenantId)))
    .limit(1);
  return row?.route ?? null;
}

export async function listRoutesBySet(
  routeSetId: string,
  options?: { routeState?: RouteState },
): Promise<V11DeploymentRoute[]> {
  const conditions = [eq(v11DeploymentRoute.routeSetId, routeSetId)];
  if (options?.routeState) conditions.push(eq(v11DeploymentRoute.routeState, options.routeState));
  return db
    .select()
    .from(v11DeploymentRoute)
    .where(and(...conditions))
    .orderBy(desc(v11DeploymentRoute.createdAt));
}

export async function getEffectiveRoutes(
  tenantId: string,
  agentId: string,
  routeScopeKey: string,
): Promise<V11DeploymentRoute[]> {
  const routeSet = await getRouteSetByAgentScope(tenantId, agentId, routeScopeKey);
  if (!routeSet) return [];
  return listRoutesBySet(routeSet.id, { routeState: "enabled" });
}

export interface UpsertDeploymentRouteResult {
  route: V11DeploymentRoute;
  routeSet: V11DeploymentRouteSet;
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
    idempotencyKey: params.idempotencyKey ?? `compat-route-activate:${randomUUID()}`,
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
    idempotencyKey: params.idempotencyKey ?? `compat-route-disable:${randomUUID()}`,
  });
}

export interface RouteSetSnapshot {
  routeSetId: string;
  versionNo: number;
  enabledRoutes: V11DeploymentRoute[];
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
  V11DeploymentRoute,
  V11DeploymentRouteSet,
} from "@/lib/v11/schema/deployment-route";
