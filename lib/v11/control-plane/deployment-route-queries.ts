/**
 * V11 DeploymentRoute 仓储与路由控制面（S03-C04）。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §4.3、§6.4、
 *         ../v11-agentkit-platform/11-api-and-event-boundaries.md §6.3、
 *         ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md S03-W03。
 *
 * 职责：
 * - RouteSet CRUD：createRouteSet / getRouteSetById / getRouteSetByAgentScope。
 * - Route 查询：getRouteById / listRoutesBySet / getEffectiveRoutes（调度侧入口）。
 * - upsertDeploymentRoute：聚合更新核心——ETag 乐观锁 + attestation 门禁 + 能力子集校验 + 权重校验 + 审计。
 * - disableDeploymentRoute：禁用路由（ETag 乐观锁 + 审计）。
 * - 回滚：通过 upsert/disable 组合实现，每次更新产生新 versionNo，不改写历史。
 *
 * 关键约束：
 * - 路由更新只影响新 Invocation，不改写已存在的 ExecutionBinding。
 * - versionNo 单调递增（含回滚），ETag 基于 versionNo。
 * - 引用的 AgentRevision / RuntimeRevision 必须为 published 状态。
 * - AgentRevision required interface requirements ⊆ RuntimeRevision capabilities。
 * - traffic_weight 为 0–10000 基点。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { getRevisionById } from "@/lib/v11/control-plane/agent-revision-queries";
import { getVerifiedAttestationForRevision } from "@/lib/v11/control-plane/artifact-attestation-queries";
import { isCapabilitySubset } from "@/lib/v11/control-plane/runtime-conformance";
import { getRuntimeRevisionById } from "@/lib/v11/control-plane/runtime-revision-queries";
import { type AuditActor, recordAuditEvent } from "@/lib/v11/identity/audit";
import type { V11AgentRevision } from "@/lib/v11/schema/agent";
import {
  type RouteState,
  type V11DeploymentRoute,
  type V11DeploymentRouteSet,
  v11DeploymentRoute,
  v11DeploymentRouteSet,
} from "@/lib/v11/schema/deployment-route";
import type { V11RuntimeRevision } from "@/lib/v11/schema/runtime";
import { and, desc, eq } from "drizzle-orm";

// ─── 常量 ──────────────────────────────────────────────────

/** traffic_weight 上限：10000 基点 = 100%。 */
export const MAX_TRAFFIC_WEIGHT = 10000;

// ─── 错误类 ────────────────────────────────────────────────

/** RouteSet 不存在（或跨租户不可见）。 */
export class RouteSetNotFoundError extends Error {
  constructor(public readonly routeSetId: string) {
    super(`RouteSet 不存在或跨租户不可见: ${routeSetId}`);
    this.name = "RouteSetNotFoundError";
  }
}

/** RouteSet versionNo（ETag）不匹配——并发更新冲突。 */
export class RouteSetVersionConflictError extends Error {
  constructor(
    public readonly routeSetId: string,
    public readonly expectedVersionNo: number,
    public readonly actualVersionNo: number,
  ) {
    super(`RouteSet 版本冲突（期望 ${expectedVersionNo}, 实际 ${actualVersionNo}）: ${routeSetId}`);
    this.name = "RouteSetVersionConflictError";
  }
}

/** Route 不存在（或跨租户不可见）。 */
export class RouteNotFoundError extends Error {
  constructor(public readonly routeId: string) {
    super(`DeploymentRoute 不存在或跨租户不可见: ${routeId}`);
    this.name = "RouteNotFoundError";
  }
}

/** 权重非法（超出 0–10000 或有效路由总和不合法）。 */
export class RouteWeightInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteWeightInvalidError";
  }
}

/** AgentRevision required capabilities 不是 RuntimeRevision capabilities 子集。 */
export class AgentCapabilityUnsupportedError extends Error {
  constructor(
    public readonly missingCapabilities: string[],
    public readonly agentRevisionId: string,
    public readonly runtimeRevisionId: string,
  ) {
    super(
      `AgentRevision ${agentRevisionId} required capabilities [${missingCapabilities.join(", ")}] 不在 RuntimeRevision ${runtimeRevisionId} capabilities 内`,
    );
    this.name = "AgentCapabilityUnsupportedError";
  }
}

/** 引用的 Revision 不是 published 状态。 */
export class RevisionNotPublishedError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly revisionType: "agent" | "runtime",
    public readonly actualState: string,
  ) {
    super(
      `${revisionType === "agent" ? "AgentRevision" : "RuntimeRevision"} ${revisionId} 状态为 ${actualState}，不是 published`,
    );
    this.name = "RevisionNotPublishedError";
  }
}

// ─── RouteSet 仓储 ─────────────────────────────────────────

/** 创建新 RouteSet（versionNo=1）。若同 tenant+agent+scope 已存在则抛唯一约束冲突。 */
export async function createRouteSet(params: {
  tenantId: string;
  agentId: string;
  routeScopeKey: string;
  routeScopeJson: Record<string, unknown>;
}): Promise<V11DeploymentRouteSet> {
  const id = randomUUID();
  await db.insert(v11DeploymentRouteSet).values({
    id,
    tenantId: params.tenantId,
    agentId: params.agentId,
    routeScopeKey: params.routeScopeKey,
    routeScopeJson: params.routeScopeJson,
    versionNo: 1,
  });
  const [row] = await db
    .select()
    .from(v11DeploymentRouteSet)
    .where(eq(v11DeploymentRouteSet.id, id))
    .limit(1);
  if (!row) throw new Error(`createRouteSet: 行未找到（id=${id}）`);
  return row;
}

/** 按 id 获取 RouteSet（跨租户隔离）。不存在返回 null。 */
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

/** 按 Agent + Scope 获取 RouteSet（跨租户隔离）。不存在返回 null。 */
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

// ─── Route 查询 ────────────────────────────────────────────

/** 按 id 获取 Route（跨租户隔离，通过 RouteSet.tenantId 过滤）。不存在返回 null。 */
export async function getRouteById(
  tenantId: string,
  routeId: string,
): Promise<V11DeploymentRoute | null> {
  const [row] = await db
    .select({
      route: v11DeploymentRoute,
    })
    .from(v11DeploymentRoute)
    .innerJoin(v11DeploymentRouteSet, eq(v11DeploymentRoute.routeSetId, v11DeploymentRouteSet.id))
    .where(and(eq(v11DeploymentRoute.id, routeId), eq(v11DeploymentRouteSet.tenantId, tenantId)))
    .limit(1);
  return row?.route ?? null;
}

/** 列出 RouteSet 下所有路由（可按 routeState 过滤；按 createdAt 降序）。 */
export async function listRoutesBySet(
  routeSetId: string,
  options?: { routeState?: RouteState },
): Promise<V11DeploymentRoute[]> {
  const conditions = [eq(v11DeploymentRoute.routeSetId, routeSetId)];
  if (options?.routeState) {
    conditions.push(eq(v11DeploymentRoute.routeState, options.routeState));
  }
  return db
    .select()
    .from(v11DeploymentRoute)
    .where(and(...conditions))
    .orderBy(desc(v11DeploymentRoute.createdAt));
}

/**
 * 获取当前有效（enabled）路由（调度侧入口）。
 *
 * 返回 enabled 路由列表，供调度器为新 Invocation 选择路由。
 * 跨租户隔离通过 RouteSet.tenantId 过滤。
 */
export async function getEffectiveRoutes(
  tenantId: string,
  agentId: string,
  routeScopeKey: string,
): Promise<V11DeploymentRoute[]> {
  const routeSet = await getRouteSetByAgentScope(tenantId, agentId, routeScopeKey);
  if (!routeSet) return [];
  return listRoutesBySet(routeSet.id, { routeState: "enabled" });
}

// ─── 聚合更新核心：upsertDeploymentRoute ──────────────────

/** upsertDeploymentRoute 结果。 */
export interface UpsertDeploymentRouteResult {
  route: V11DeploymentRoute;
  routeSet: V11DeploymentRouteSet;
  etag: string;
  auditEventId: string;
  affectsNewInvocationsOnly: true;
}

/**
 * 聚合更新核心：upsert 或更新一条 DeploymentRoute。
 *
 * 步骤：
 * 1. ETag 乐观锁：校验 RouteSet.versionNo = expectedVersionNo，失败抛 RouteSetVersionConflictError。
 * 2. 校验 AgentRevision 为 published 状态。
 * 3. 校验 RuntimeRevision 为 published 状态。
 * 4. attestation 门禁：AgentRevision 与 RuntimeRevision 都有 verified attestation（复用 getVerifiedAttestationForRevision）。
 * 5. 能力子集校验：AgentRevision required interface requirements ⊆ RuntimeRevision capabilities。
 * 6. 权重校验：trafficWeight 在 0–10000 基点范围内。
 * 7. upsert Route 行（若同 routeSetId+agentRevisionId+runtimeRevisionId 已存在则更新）。
 * 8. 递增 RouteSet.versionNo（CAS）。
 * 9. 写 AuditEvent（route.update）。
 *
 * @throws RouteSetNotFoundError RouteSet 不存在
 * @throws RouteSetVersionConflictError ETag 不匹配（并发冲突）
 * @throws RevisionNotPublishedError 引用的 Revision 非 published
 * @throws ArtifactNotVerifiedError attestation 未 verified
 * @throws AgentCapabilityUnsupportedError required capabilities 不是子集
 * @throws RouteWeightInvalidError 权重非法
 */
export async function upsertDeploymentRoute(params: {
  tenantId: string;
  routeSetId: string;
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
}): Promise<UpsertDeploymentRouteResult> {
  // 1. ETag 乐观锁
  const routeSet = await getRouteSetById(params.tenantId, params.routeSetId);
  if (!routeSet) throw new RouteSetNotFoundError(params.routeSetId);
  if (routeSet.versionNo !== params.routeSetExpectedVersionNo) {
    throw new RouteSetVersionConflictError(
      params.routeSetId,
      params.routeSetExpectedVersionNo,
      routeSet.versionNo,
    );
  }

  // 2. 校验 AgentRevision published
  const agentRevision = await getRevisionById(params.agentRevisionId);
  if (!agentRevision)
    throw new RevisionNotPublishedError(params.agentRevisionId, "agent", "not_found");
  if (agentRevision.revisionState !== "published") {
    throw new RevisionNotPublishedError(
      params.agentRevisionId,
      "agent",
      agentRevision.revisionState,
    );
  }

  // 3. 校验 RuntimeRevision published
  const runtimeRevision = await getRuntimeRevisionById(params.runtimeRevisionId);
  if (!runtimeRevision)
    throw new RevisionNotPublishedError(params.runtimeRevisionId, "runtime", "not_found");
  if (runtimeRevision.revisionState !== "published") {
    throw new RevisionNotPublishedError(
      params.runtimeRevisionId,
      "runtime",
      runtimeRevision.revisionState,
    );
  }

  // 4. attestation 门禁
  const agentAttestation = await getVerifiedAttestationForRevision(
    params.tenantId,
    "agent_revision",
    params.agentRevisionId,
  );
  if (!agentAttestation) {
    throw new ArtifactNotVerifiedForRouteError(params.agentRevisionId, "agent_revision");
  }
  const runtimeAttestation = await getVerifiedAttestationForRevision(
    params.tenantId,
    "runtime_revision",
    params.runtimeRevisionId,
  );
  if (!runtimeAttestation) {
    throw new ArtifactNotVerifiedForRouteError(params.runtimeRevisionId, "runtime_revision");
  }

  // 5. 能力子集校验
  const agentRequired = extractRequiredCapabilities(agentRevision);
  const runtimeCaps = extractRuntimeCapabilities(runtimeRevision);
  const subsetResult = isCapabilitySubset(agentRequired, runtimeCaps);
  if (!subsetResult.satisfied) {
    throw new AgentCapabilityUnsupportedError(
      subsetResult.missing,
      params.agentRevisionId,
      params.runtimeRevisionId,
    );
  }

  // 6. 权重校验
  if (params.trafficWeight < 0 || params.trafficWeight > MAX_TRAFFIC_WEIGHT) {
    throw new RouteWeightInvalidError(
      `trafficWeight ${params.trafficWeight} 超出 0–${MAX_TRAFFIC_WEIGHT} 范围`,
    );
  }

  // 7. upsert Route 行
  const now = new Date();
  const routeState = params.routeState ?? "enabled";
  const priorityNo = params.priorityNo ?? 0;

  // 查找是否已有同组合的路由行
  const [existing] = await db
    .select()
    .from(v11DeploymentRoute)
    .where(
      and(
        eq(v11DeploymentRoute.routeSetId, params.routeSetId),
        eq(v11DeploymentRoute.agentRevisionId, params.agentRevisionId),
        eq(v11DeploymentRoute.runtimeRevisionId, params.runtimeRevisionId),
      ),
    )
    .limit(1);

  let route: V11DeploymentRoute;
  if (existing) {
    await db
      .update(v11DeploymentRoute)
      .set({
        trafficWeight: params.trafficWeight,
        priorityNo,
        routeState,
        effectiveFrom: params.effectiveFrom ?? null,
        effectiveUntil: params.effectiveUntil ?? null,
        updatedAt: now,
      })
      .where(eq(v11DeploymentRoute.id, existing.id));
    const [updated] = await db
      .select()
      .from(v11DeploymentRoute)
      .where(eq(v11DeploymentRoute.id, existing.id))
      .limit(1);
    route = updated ?? existing;
  } else {
    const routeId = randomUUID();
    await db.insert(v11DeploymentRoute).values({
      id: routeId,
      routeSetId: params.routeSetId,
      agentRevisionId: params.agentRevisionId,
      runtimeRevisionId: params.runtimeRevisionId,
      trafficWeight: params.trafficWeight,
      priorityNo,
      routeState,
      effectiveFrom: params.effectiveFrom ?? null,
      effectiveUntil: params.effectiveUntil ?? null,
    });
    const [created] = await db
      .select()
      .from(v11DeploymentRoute)
      .where(eq(v11DeploymentRoute.id, routeId))
      .limit(1);
    if (!created) throw new Error(`upsertDeploymentRoute: 行未找到（id=${routeId}）`);
    route = created;
  }

  // 8. 递增 RouteSet.versionNo（CAS）
  const newVersionNo = routeSet.versionNo + 1;
  const updateResult = await db
    .update(v11DeploymentRouteSet)
    .set({
      versionNo: newVersionNo,
      updatedAt: now,
    })
    .where(
      and(
        eq(v11DeploymentRouteSet.id, params.routeSetId),
        eq(v11DeploymentRouteSet.versionNo, routeSet.versionNo),
      ),
    );

  if (updateResult[0].affectedRows === 0) {
    throw new RouteSetVersionConflictError(params.routeSetId, routeSet.versionNo, -1);
  }

  const [updatedRouteSet] = await db
    .select()
    .from(v11DeploymentRouteSet)
    .where(eq(v11DeploymentRouteSet.id, params.routeSetId))
    .limit(1);

  const finalRouteSet = updatedRouteSet ?? routeSet;

  // 9. 写 AuditEvent
  const auditEvent = await recordAuditEvent({
    actor: params.actor,
    actionType: "route.update",
    targetType: "deployment_route",
    targetId: route.id,
    after: {
      route_set_id: params.routeSetId,
      route_set_version_no: newVersionNo,
      agent_revision_id: params.agentRevisionId,
      runtime_revision_id: params.runtimeRevisionId,
      traffic_weight: params.trafficWeight,
      route_state: routeState,
      agent_attestation_id: agentAttestation.id,
      runtime_attestation_id: runtimeAttestation.id,
      affects_new_invocations_only: true,
    },
    reason: `DeploymentRoute 更新（${routeState}，权重 ${params.trafficWeight} 基点）`,
    requestId: params.requestId,
  });

  return {
    route,
    routeSet: finalRouteSet,
    etag: `route-set-${newVersionNo}`,
    auditEventId: auditEvent.id,
    affectsNewInvocationsOnly: true,
  };
}

// ─── 禁用路由 ──────────────────────────────────────────────

/** disableDeploymentRoute 结果。 */
export interface DisableDeploymentRouteResult {
  route: V11DeploymentRoute;
  routeSet: V11DeploymentRouteSet;
  etag: string;
  auditEventId: string;
  affectsNewInvocationsOnly: true;
}

/**
 * 禁用一条 DeploymentRoute（ETag 乐观锁 + 审计）。
 *
 * 禁用后路由不参与流量分配，但不物理删除（回滚依赖历史行）。
 *
 * @throws RouteSetNotFoundError RouteSet 不存在
 * @throws RouteSetVersionConflictError ETag 不匹配
 * @throws RouteNotFoundError Route 不存在
 */
export async function disableDeploymentRoute(params: {
  tenantId: string;
  routeSetId: string;
  routeSetExpectedVersionNo: number;
  routeId: string;
  actor: AuditActor;
  requestId?: string;
}): Promise<DisableDeploymentRouteResult> {
  // 1. ETag 乐观锁
  const routeSet = await getRouteSetById(params.tenantId, params.routeSetId);
  if (!routeSet) throw new RouteSetNotFoundError(params.routeSetId);
  if (routeSet.versionNo !== params.routeSetExpectedVersionNo) {
    throw new RouteSetVersionConflictError(
      params.routeSetId,
      params.routeSetExpectedVersionNo,
      routeSet.versionNo,
    );
  }

  // 2. 查找 Route
  const route = await getRouteById(params.tenantId, params.routeId);
  if (!route) throw new RouteNotFoundError(params.routeId);
  if (route.routeSetId !== params.routeSetId) {
    throw new RouteNotFoundError(params.routeId);
  }

  // 3. 禁用
  const now = new Date();
  await db
    .update(v11DeploymentRoute)
    .set({
      routeState: "disabled",
      updatedAt: now,
    })
    .where(eq(v11DeploymentRoute.id, route.id));

  // 4. 递增 RouteSet.versionNo（CAS）
  const newVersionNo = routeSet.versionNo + 1;
  const updateResult = await db
    .update(v11DeploymentRouteSet)
    .set({
      versionNo: newVersionNo,
      updatedAt: now,
    })
    .where(
      and(
        eq(v11DeploymentRouteSet.id, params.routeSetId),
        eq(v11DeploymentRouteSet.versionNo, routeSet.versionNo),
      ),
    );

  if (updateResult[0].affectedRows === 0) {
    throw new RouteSetVersionConflictError(params.routeSetId, routeSet.versionNo, -1);
  }

  const [updatedRouteSet] = await db
    .select()
    .from(v11DeploymentRouteSet)
    .where(eq(v11DeploymentRouteSet.id, params.routeSetId))
    .limit(1);

  const [updatedRoute] = await db
    .select()
    .from(v11DeploymentRoute)
    .where(eq(v11DeploymentRoute.id, route.id))
    .limit(1);

  // 5. 写 AuditEvent
  const auditEvent = await recordAuditEvent({
    actor: params.actor,
    actionType: "route.update",
    targetType: "deployment_route",
    targetId: route.id,
    after: {
      route_set_id: params.routeSetId,
      route_set_version_no: newVersionNo,
      route_state: "disabled",
      affects_new_invocations_only: true,
    },
    reason: "DeploymentRoute 禁用",
    requestId: params.requestId,
  });

  return {
    route: updatedRoute ?? route,
    routeSet: updatedRouteSet ?? routeSet,
    etag: `route-set-${newVersionNo}`,
    auditEventId: auditEvent.id,
    affectsNewInvocationsOnly: true,
  };
}

// ─── 辅助：获取 RouteSet 快照（用于回滚对比） ─────────────

/** RouteSet 快照：记录某时刻 enabled 路由的状态，用于回滚对比。 */
export interface RouteSetSnapshot {
  routeSetId: string;
  versionNo: number;
  enabledRoutes: V11DeploymentRoute[];
}

/**
 * 获取 RouteSet 当前快照（enabled 路由列表 + versionNo）。
 *
 * 用于回滚场景：先 snapshot → 修改路由 → 回滚时恢复 snapshot。
 */
export async function getRouteSetSnapshot(
  tenantId: string,
  routeSetId: string,
): Promise<RouteSetSnapshot> {
  const routeSet = await getRouteSetById(tenantId, routeSetId);
  if (!routeSet) throw new RouteSetNotFoundError(routeSetId);
  const enabledRoutes = await listRoutesBySet(routeSetId, { routeState: "enabled" });
  return {
    routeSetId,
    versionNo: routeSet.versionNo,
    enabledRoutes,
  };
}

// ─── 内部辅助 ──────────────────────────────────────────────

/** attestation 未验证错误（路由门禁专用）。 */
class ArtifactNotVerifiedForRouteError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly artifactType: string,
  ) {
    super(`Revision ${revisionId} 的 ${artifactType} attestation 未 verified`);
    this.name = "ArtifactNotVerifiedForRouteError";
  }
}

/** 从 AgentRevision.agentInterfaceRequirementsJson 提取 required capabilities。 */
function extractRequiredCapabilities(revision: V11AgentRevision): string[] {
  const json = revision.agentInterfaceRequirementsJson as {
    required?: string[];
    optional?: string[];
  };
  return json?.required ?? [];
}

/** 从 RuntimeRevision.runtimeCapabilitiesJson 提取 capabilities。 */
function extractRuntimeCapabilities(revision: V11RuntimeRevision): string[] {
  const json = revision.runtimeCapabilitiesJson as string[] | { capabilities?: string[] };
  if (Array.isArray(json)) return json;
  return json?.capabilities ?? [];
}

// ─── Re-exports ────────────────────────────────────────────

export type {
  RouteState,
  V11DeploymentRoute,
  V11DeploymentRouteSet,
} from "@/lib/v11/schema/deployment-route";
