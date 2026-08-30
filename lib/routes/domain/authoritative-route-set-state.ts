/**
 * RouteSet 权威状态模型 — 从事实源读取，禁止从 DeploymentRoute 投影反向重建。
 *
 * 权威事实源：
 * - RouteRevision：每条 Route 当前有效的 Revision（含判别 target）
 * - RouteActivation：每条 Route 最新的 Activation
 *
 * 不得从 DeploymentRoute 投影反向推导：
 * - Eligibility 条件
 * - Group ID
 * - Policy Revision
 * - Toolset Revision
 * - Model Policy Revision
 *
 * 参见：正式架构
 */

import type { RouteRevisionTarget } from "@/lib/routes/domain/route-revision";

/** RouteSet 目标判别联合 — 禁止 nullable agentId 隐式猜测。 */
export type RouteSetTarget = { kind: "runtime" } | { kind: "agent"; agentId: string };

/**
 * 单条 Route 的权威状态。
 */
export interface AuthoritativeRouteState {
  /** Route ID。 */
  routeId: string;
  /** Route 稳定身份键。 */
  routeKey: string;
  /** 最新 RouteRevision ID。 */
  activeRouteRevisionId: string | null;
  /** 最新 RouteRevision 的内容摘要（含判别 target）。 */
  activeRevision: {
    /** 判别 target — 只含所选 target 自己的事实。 */
    target: RouteRevisionTarget;
    policyRevisionId: string | null;
    modelPolicyRevisionId: string | null;
    toolsetRevisionId: string | null;
    trafficWeight: number;
    priorityNo: number;
    effectiveFrom: Date | null;
    effectiveUntil: Date | null;
    eligibilityConditions: Record<string, unknown>;
    routeGroupId: string;
  } | null;
  /** 最新 Activation 状态。 */
  activationState: "active" | "disabled" | "never_activated";
  /** 最新 RouteActivation ID。 */
  latestActivationId: string | null;
  /** 前一个 RouteRevision ID（来自 Activation 历史）。 */
  previousRouteRevisionId: string | null;
}

/**
 * RouteSet 权威状态快照。
 */
export interface AuthoritativeRouteSetState {
  /** RouteSet ID。 */
  routeSetId: string;
  /** 租户 ID。 */
  tenantId: string;
  /** RouteSet 目标判别联合 — runtime 或 agent。 */
  target: RouteSetTarget;
  /** Route Scope Key。 */
  routeScopeKey: string;
  /** RouteSet 版本号（ETag）。 */
  versionNo: number;
  /** 各条 Route 的权威状态。 */
  routes: AuthoritativeRouteState[];
}

/** 比较两个判别 target 是否一致（按所选 target 自己的事实）。 */
export function routeTargetsEqual(a: RouteRevisionTarget, b: RouteRevisionTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "runtime") {
    return b.kind === "runtime" && a.runtimeRevisionId === b.runtimeRevisionId;
  }
  return (
    b.kind === "agent" &&
    a.agentRevisionId === b.agentRevisionId &&
    a.agentEndpointRef === b.agentEndpointRef &&
    a.agentIdentityMode === b.agentIdentityMode &&
    a.agentCredentialRefId === b.agentCredentialRefId &&
    a.agentNetworkZone === b.agentNetworkZone
  );
}

/** target 稳定标识（用于 drift 报告，不含二义 flat 形状）。 */
function routeTargetKey(target: RouteRevisionTarget): string {
  return JSON.stringify(target);
}

/**
 * 检查 RouteSet 权威状态是否与 DeploymentRoute 投影一致。
 *
 * 此函数用于检测投影漂移（projection drift），
 * 但不得用于反向推导 RouteSet 的目标状态。
 */
export function detectProjectionDrift(
  authoritative: AuthoritativeRouteSetState,
  projectionRoutes: Array<{
    routeId: string;
    routeKey: string;
    /** 判别 target — 只含所选 target 自己的事实。 */
    target: RouteRevisionTarget;
    activeRouteRevisionId: string | null;
    routeState: string;
  }>,
): ProjectionDriftResult {
  const drifts: ProjectionDrift[] = [];

  const projectionMap = new Map(projectionRoutes.map((r) => [r.routeId, r]));

  for (const route of authoritative.routes) {
    const proj = projectionMap.get(route.routeId);
    if (!proj) {
      drifts.push({ routeId: route.routeId, kind: "missing_in_projection" });
      continue;
    }
    if (route.activeRouteRevisionId && proj.activeRouteRevisionId !== route.activeRouteRevisionId) {
      drifts.push({
        routeId: route.routeId,
        kind: "revision_mismatch",
        authoritative: route.activeRouteRevisionId,
        projection: proj.activeRouteRevisionId,
      });
      continue;
    }
    // 同一 Revision 下 target 不一致 → 投影 target 漂移。
    const authTarget = route.activeRevision?.target ?? null;
    if (authTarget && !routeTargetsEqual(authTarget, proj.target)) {
      drifts.push({
        routeId: route.routeId,
        kind: "target_mismatch",
        authoritative: routeTargetKey(authTarget),
        projection: routeTargetKey(proj.target),
      });
    }
    const expectedState = route.activationState === "active" ? "enabled" : "disabled";
    if (proj.routeState !== expectedState && route.activationState !== "never_activated") {
      drifts.push({
        routeId: route.routeId,
        kind: "state_mismatch",
        authoritative: expectedState,
        projection: proj.routeState,
      });
    }
  }

  return { hasDrift: drifts.length > 0, drifts };
}

export interface ProjectionDriftResult {
  hasDrift: boolean;
  drifts: ProjectionDrift[];
}

export type ProjectionDrift =
  | { routeId: string; kind: "missing_in_projection" }
  | {
      routeId: string;
      kind: "revision_mismatch";
      authoritative: string | null;
      projection: string | null;
    }
  | {
      routeId: string;
      kind: "target_mismatch";
      authoritative: string;
      projection: string;
    }
  | { routeId: string; kind: "state_mismatch"; authoritative: string; projection: string };
