/**
 * RouteSet 权威状态 Reader — 从事实源（RouteRevision + RouteActivation）读取。
 *
 * 禁止从 DeploymentRoute 投影反向重建。
 * 所有需要 RouteSet 当前状态的模块必须通过此 Reader 读取。
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案
 */

import { db } from "@/lib/db/client";
import { deploymentRouteSetTable } from "@/lib/persistence/schema/deployment-route";
import type {
  AuthoritativeRouteSetState,
  AuthoritativeRouteState,
  RouteSetTarget,
} from "@/lib/routes/domain/authoritative-route-set-state";
import {
  routeActivation,
  routeRevision,
  routeRevisionTargetFromRecord,
} from "@/lib/routes/persistence/route-revision-record";
import { desc, eq } from "drizzle-orm";

/** 从显式 DB trio（targetKind/targetIdentity/agentId）严格构造 RouteSet target；畸形返回 null。 */
function routeSetTargetFromTrio(input: {
  targetKind: string;
  targetIdentity: string;
  agentId: string | null;
}): RouteSetTarget | null {
  if (input.targetKind === "runtime") {
    if (input.targetIdentity !== "runtime" || input.agentId !== null) return null;
    return { kind: "runtime" };
  }
  if (input.targetKind === "agent") {
    if (
      typeof input.agentId !== "string" ||
      input.agentId.trim() === "" ||
      input.agentId !== input.targetIdentity
    ) {
      return null;
    }
    return { kind: "agent", agentId: input.agentId };
  }
  return null;
}

/**
 * 加载 RouteSet 的权威状态。
 *
 * 数据源：
 * - DeploymentRouteSet：基本信息（含判别 target）
 * - RouteRevision：每条 Route 最新 Revision（含判别 target）
 * - RouteActivation：每条 Route 最新 Activation
 *
 * RouteSet 或某条 RouteRevision 的 target 畸形时 fail-closed：整体返回 null /
 * 该 Route 视为无权威 Revision，绝不制造默认 target。
 */
export async function loadAuthoritativeRouteSetState(
  routeSetId: string,
): Promise<AuthoritativeRouteSetState | null> {
  // 1. 读取 RouteSet 基本信息
  const [routeSet] = await db
    .select()
    .from(deploymentRouteSetTable)
    .where(eq(deploymentRouteSetTable.id, routeSetId))
    .limit(1);

  if (!routeSet) return null;

  // 1b. 严格构造 RouteSet 判别 target；畸形 → fail-closed。
  const routeSetTarget = routeSetTargetFromTrio(routeSet);
  if (!routeSetTarget) return null;

  // 2. 读取 RouteSet 下所有 Route（从 RouteRevision 的最新版本获取 Route 列表）
  const revisions = await db
    .select()
    .from(routeRevision)
    .where(eq(routeRevision.routeSetId, routeSetId))
    .orderBy(desc(routeRevision.routeId), desc(routeRevision.revisionNo));

  // 按 routeId 分组，取最新
  const latestRevisions = new Map<string, (typeof revisions)[0]>();
  for (const rev of revisions) {
    if (!latestRevisions.has(rev.routeId)) {
      latestRevisions.set(rev.routeId, rev);
    }
  }

  // 3. 读取每个 Route 的最新 Activation（同一 RouteSet 下）
  const activations = await db
    .select()
    .from(routeActivation)
    .where(eq(routeActivation.routeSetId, routeSetId))
    .orderBy(desc(routeActivation.routeId), desc(routeActivation.activationSequence));

  // 按 routeId 分组，取最新
  const latestActivations = new Map<string, (typeof activations)[0]>();
  for (const act of activations) {
    if (!latestActivations.has(act.routeId)) {
      latestActivations.set(act.routeId, act);
    }
  }

  // 4. 组装结果
  const routes: AuthoritativeRouteState[] = [];
  for (const [routeId, revision] of latestRevisions) {
    const activation = latestActivations.get(routeId);
    // 严格构造 Revision 判别 target；畸形（混合/占位/缺字段）→ 该 Route 无权威 Revision。
    const target = routeRevisionTargetFromRecord(revision);
    if (!target) continue;
    routes.push({
      routeId,
      routeKey: revision.routeKey,
      activeRouteRevisionId: revision.id,
      activeRevision: {
        target,
        policyRevisionId: revision.policyRevisionId,
        modelPolicyRevisionId: revision.modelPolicyRevisionId,
        toolsetRevisionId: revision.toolsetRevisionId,
        trafficWeight: revision.trafficWeight,
        priorityNo: revision.priorityNo,
        effectiveFrom: revision.effectiveFrom,
        effectiveUntil: revision.effectiveUntil,
        eligibilityConditions: revision.eligibilityConditionsJson as Record<string, unknown>,
        routeGroupId: revision.routeGroupId,
      },
      activationState: activation?.activationState ?? "never_activated",
      latestActivationId: activation?.id ?? null,
      previousRouteRevisionId: activation?.previousRouteRevisionId ?? null,
    });
  }

  return {
    routeSetId: routeSet.id,
    tenantId: routeSet.tenantId,
    target: routeSetTarget,
    routeScopeKey: routeSet.routeScopeKey,
    versionNo: Number(routeSet.versionNo),
    routes,
  };
}
