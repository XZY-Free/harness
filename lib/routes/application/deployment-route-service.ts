/**
 * DeploymentRoute 查询与写入应用服务。
 *
 * 单 Route 写入（upsertDeploymentRoute / disableDeploymentRoute）
 * 作为薄适配器委托 RouteSet 整体激活服务（ActivateRouteSet），
 * 确保聚合不变量始终校验。当单条修改会产生非法中间状态时，
 * 抛 RouteSetRequiresAtomicUpdateError（409），
 * 提示调用方使用 RouteSet 批量激活接口。
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
} from "@/lib/persistence/schema/routes";
import {
 type ActivateRouteSetResult,
 RouteSetRequiresAtomicUpdateError,
 createActivateRouteSet,
} from "@/lib/routes/application/activate-route-set";
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
import { mysqlRouteSetActivationStore } from "@/lib/routes/persistence/mysql-route-set-activation-store";
import type { DesiredRoute } from "@/lib/routes/persistence/route-set-activation-store";
import { and, desc, eq } from "drizzle-orm";

export const MAX_TRAFFIC_WEIGHT = MAX_ROUTE_TRAFFIC_WEIGHT;
export {
 AgentCapabilityUnsupportedError,
 ArtifactNotVerifiedForRouteError,
 RevisionNotPublishedError,
 RouteNotFoundError,
 RouteSetNotFoundError,
 RouteSetRequiresAtomicUpdateError,
 RouteSetVersionConflictError,
 RouteWeightInvalidError,
};

const activateRouteSet = createActivateRouteSet({ store: mysqlRouteSetActivationStore });

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

/**
 * @deprecated : 使用 listEnabledRouteProjections 替代。
 * 旧名仅作为兼容别名保留，将在下个 major 版本删除。
 * 执行链禁止调用此函数。
 */

// ─── 结果类型 ──────────────────────────────────────────────

export interface UpsertDeploymentRouteResult {
 route: DeploymentRouteRow;
 routeSet: DeploymentRouteSetRow;
 routeRevisionId: string;
 routeActivationId: string;
 routeGroupId: string;
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

// ─── 薄适配器：读取当前状态 → 应用单 Route 变更 → 委托 ActivateRouteSet ───

/**
 * 将现有 DeploymentRouteRow 转换为 DesiredRoute 格式。
 * 投影行不含 routeGroupId / eligibilityConditions，使用默认值。
 */
function existingRouteToDesired(route: DeploymentRouteRow): DesiredRoute {
 return {
 routeId: route.id,
 routeKey: route.routeKey ?? "primary",
 routeGroupId: "primary",
 agentRevisionId: route.agentRevisionId,
 runtimeRevisionId: route.runtimeRevisionId,
 policyRevisionId: null,
 trafficWeight: route.trafficWeight,
 priorityNo: route.priorityNo,
 effectiveFrom: route.effectiveFrom,
 effectiveUntil: route.effectiveUntil,
 eligibilityConditions: {},
 activationState: route.routeState === "disabled" ? "disabled" : "active",
 };
}

/**
 * 从 ActivateRouteSet 结果中找到目标 Route 的激活记录，并重新读取投影行。
 */
async function buildUpsertResult(
 result: ActivateRouteSetResult,
 targetRouteId: string,
): Promise<UpsertDeploymentRouteResult> {
 const activation = result.activations.find((a) => a.routeId === targetRouteId);
 if (!activation)
 throw new Error(`upsertDeploymentRoute: 目标 Route ${targetRouteId} 未在激活结果中`);

 const [routeRow] = await db
 .select()
 .from(deploymentRouteTable)
 .where(eq(deploymentRouteTable.id, targetRouteId))
 .limit(1);
 if (!routeRow) throw new Error(`upsertDeploymentRoute: Route 行未找到（id=${targetRouteId}）`);

 const [routeSetRow] = await db
 .select()
 .from(deploymentRouteSetTable)
 .where(eq(deploymentRouteSetTable.id, result.routeSetId))
 .limit(1);
 if (!routeSetRow) throw new Error(`upsertDeploymentRoute: RouteSet 行未找到`);

 return {
 route: routeRow,
 routeSet: routeSetRow,
 routeRevisionId: activation.routeRevisionId,
 routeActivationId: activation.routeActivationId,
 routeGroupId: activation.routeGroupId,
 etag: `route-set-${result.routeSetVersionNo}`,
 auditEventId: result.auditEventId,
 affectsNewInvocationsOnly: true,
 };
}

/**
 * §11: @deprecated 单 Route 兼容写入口 — 已委托给 RouteSet 原子激活。
 * 新代码必须直接使用 activateRouteSet。此函数将在 Task 17 全仓删除中移除。
 */
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
 // 1. 读取当前 RouteSet 的全部 Route
 const currentRoutes = await listRoutesBySet(params.routeSetId);

 // : Upsert 接口只允许简单 RouteSet（单 Route、10000 权重）
 // 如果已有多条 Route 且目标不是替换其中之一，则拒绝
 const otherRoutes = currentRoutes.filter((r) => r.id !== params.routeId);
 if (otherRoutes.length > 0) {
 throw new RouteSetRequiresAtomicUpdateError(
 params.routeSetId,
 "Upsert 接口仅支持单 Route 简单 RouteSet，复杂 RouteSet 请使用 PUT activation",
 );
 }

 // 2. 构造完整目标状态：保留其余 Route，替换/新增目标 Route
 const desiredRoutes = currentRoutes
 .filter((r) => r.id !== params.routeId)
 .map(existingRouteToDesired);

 // 添加目标 Route 的期望状态
 const targetActivationState: "active" | "disabled" =
 params.routeState === "disabled" ? "disabled" : "active";
 desiredRoutes.push({
 routeId: params.routeId,
 routeKey: "primary",
 routeGroupId: "primary",
 agentRevisionId: params.agentRevisionId,
 runtimeRevisionId: params.runtimeRevisionId,
 policyRevisionId: null,
 trafficWeight: params.trafficWeight,
 priorityNo: params.priorityNo ?? 0,
 effectiveFrom: params.effectiveFrom ?? null,
 effectiveUntil: params.effectiveUntil ?? null,
 eligibilityConditions: {},
 activationState: targetActivationState,
 });

 // 3. 委托 ActivateRouteSet（聚合不变量由 Policy 在事务内校验）
 const result = await activateRouteSet({
 tenantId: params.tenantId,
 routeSetId: params.routeSetId,
 expectedVersionNo: params.routeSetExpectedVersionNo,
 desiredRoutes,
 actor: params.actor,
 reason:
 targetActivationState === "disabled"
 ? "DeploymentRoute 禁用"
 : `DeploymentRoute 更新（${params.routeState ?? "enabled"}，权重 ${params.trafficWeight} 基点）`,
 requestId: params.requestId ?? randomUUID(),
 idempotencyKey: params.idempotencyKey ?? `route-activate:${randomUUID()}`,
 idempotencyCompletion: params.idempotency
 ? {
 recordId: params.idempotency.recordId,
 httpStatus: params.idempotency.httpStatus,
 responseRef: params.idempotency.responseRef,
 serializeResponse: (r) =>
 params.idempotency?.serializeResponse(r as unknown as UpsertDeploymentRouteResult) ??
 "{}",
 }
 : undefined,
 });

 // 4. 构造结果（重新读取投影行）
 const targetRouteId = params.routeId ?? result.activations[0]?.routeId;
 if (!targetRouteId) throw new Error("upsertDeploymentRoute: 无法确定目标 Route ID");

 return buildUpsertResult(result, targetRouteId);
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
 // 1. 读取当前 RouteSet 的全部 Route
 const currentRoutes = await listRoutesBySet(params.routeSetId);
 const targetRoute = currentRoutes.find((r) => r.id === params.routeId);
 if (!targetRoute || targetRoute.routeSetId !== params.routeSetId)
 throw new RouteNotFoundError(params.routeId);

 // 2. 构造完整目标状态：保留其余 Route，目标 Route 设为 disabled
 const desiredRoutes = currentRoutes
 .filter((r) => r.id !== params.routeId)
 .map(existingRouteToDesired);
 desiredRoutes.push({
 ...existingRouteToDesired(targetRoute),
 activationState: "disabled" as const,
 });

 // 3. 委托 ActivateRouteSet
 const result = await activateRouteSet({
 tenantId: params.tenantId,
 routeSetId: params.routeSetId,
 expectedVersionNo: params.routeSetExpectedVersionNo,
 desiredRoutes,
 actor: params.actor,
 reason: "DeploymentRoute 禁用",
 requestId: params.requestId ?? randomUUID(),
 idempotencyKey: params.idempotencyKey ?? `route-disable:${randomUUID()}`,
 idempotencyCompletion: params.idempotency
 ? {
 recordId: params.idempotency.recordId,
 httpStatus: params.idempotency.httpStatus,
 responseRef: params.idempotency.responseRef,
 serializeResponse: (r) =>
 params.idempotency?.serializeResponse(r as unknown as DisableDeploymentRouteResult) ??
 "{}",
 }
 : undefined,
 });

 // 4. 构造结果
 return buildUpsertResult(result, params.routeId);
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
