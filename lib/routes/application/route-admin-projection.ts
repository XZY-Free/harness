import type {
  DeploymentRouteDTO,
  DeploymentRouteSetDTO,
  RouteRevisionTargetDTO,
  RouteSetTargetDTO,
} from "@/lib/control-plane-client/contracts/route";
import type { RouteRevisionTarget } from "@/lib/routes/domain/route-revision";

export interface AdminRouteProjectionInput {
  route: {
    id: string;
    routeSetId: string;
    routeKey: string;
    routeState: "enabled" | "disabled";
    updatedAt: Date;
  };
  activation: {
    id: string;
    routeRevisionId: string;
    activationSequence: number;
    activationState: "active" | "disabled";
    activatedAt: Date;
  } | null;
  revision: {
    id: string;
    routeGroupId: string;
    /** 判别 target — 只含所选 target 自己的事实。 */
    target: RouteRevisionTarget;
    policyRevisionId: string | null;
    trafficWeight: number;
    priorityNo: number;
    effectiveFrom: Date | null;
    effectiveUntil: Date | null;
    contentDigest: string;
  } | null;
  projection: {
    eligibilityState: "eligible" | "ineligible" | "pending_rebuild";
    invalidReason: string | null;
    projectionVersionNo: number;
  } | null;
}

/** 从显式 DB trio（targetKind/targetIdentity/agentId）严格构造 RouteSet wire target，畸形抛错。 */
function routeSetTargetToWire(input: {
  targetKind: "runtime" | "agent";
  targetIdentity: string;
  agentId: string | null;
}): RouteSetTargetDTO {
  if (input.targetKind === "runtime") {
    if (input.targetIdentity !== "runtime" || input.agentId !== null) {
      throw new Error(
        `RouteSet runtime target 需 identity="runtime" 且 agentId=null，畸形（identity=${input.targetIdentity}）`,
      );
    }
    return { kind: "runtime" };
  }
  if (input.targetKind === "agent") {
    if (
      typeof input.agentId !== "string" ||
      input.agentId.trim() === "" ||
      input.agentId !== input.targetIdentity
    ) {
      throw new Error("RouteSet agent target 需 agentId 非空且 identity=agentId，畸形");
    }
    return { kind: "agent", agent_id: input.agentId.trim() };
  }
  throw new Error(`RouteSet targetKind 非法: ${String(input.targetKind)}`);
}

/** 把 domain RouteRevisionTarget 映射为 wire RouteRevisionTargetDTO。 */
function routeRevisionTargetToWire(target: RouteRevisionTarget): RouteRevisionTargetDTO {
  if (target.kind === "runtime") {
    return { kind: "runtime", runtime_revision_id: target.runtimeRevisionId };
  }
  return {
    kind: "agent",
    agent_revision_id: target.agentRevisionId,
    endpoint_ref: target.agentEndpointRef,
    identity_mode: target.agentIdentityMode,
    credential_ref_id: target.agentCredentialRefId,
    network_zone: target.agentNetworkZone,
  };
}

export function projectAdminRouteSet(routeSet: {
  id: string;
  tenantId: string;
  targetKind: "runtime" | "agent";
  targetIdentity: string;
  agentId: string | null;
  routeScopeKey: string;
  routeScopeJson: unknown;
  versionNo: number;
  createdAt: Date;
  updatedAt: Date;
}): DeploymentRouteSetDTO {
  return {
    id: routeSet.id,
    tenant_id: routeSet.tenantId,
    target: routeSetTargetToWire(routeSet),
    route_scope_key: routeSet.routeScopeKey,
    route_scope: routeSet.routeScopeJson,
    version_no: routeSet.versionNo,
    created_at: routeSet.createdAt.toISOString(),
    updated_at: routeSet.updatedAt.toISOString(),
  };
}

export function projectAdminRoute(input: AdminRouteProjectionInput): DeploymentRouteDTO {
  const { route, activation, revision, projection } = input;
  const authorityComplete = activation !== null && revision !== null;
  return {
    id: route.id,
    route_set_id: route.routeSetId,
    route_key: route.routeKey,
    route_group_id: revision?.routeGroupId ?? null,
    route_state: route.routeState,
    // 判别 target — 仅 Authority 完整时非 null，否则整体 null（禁止 flat 猜测）。
    target: authorityComplete && revision ? routeRevisionTargetToWire(revision.target) : null,
    policy_revision_id: revision?.policyRevisionId ?? null,
    traffic_weight: revision?.trafficWeight ?? null,
    priority_no: revision?.priorityNo ?? null,
    effective_from: revision?.effectiveFrom?.toISOString() ?? null,
    effective_until: revision?.effectiveUntil?.toISOString() ?? null,
    active_route_revision_id: authorityComplete ? revision.id : null,
    active_route_activation_id: authorityComplete ? activation.id : null,
    activation_state: authorityComplete ? activation.activationState : null,
    route_content_digest: revision?.contentDigest ?? null,
    eligibility_state: authorityComplete && projection ? projection.eligibilityState : "missing",
    ineligibility_reasons: projection?.invalidReason ? [projection.invalidReason] : [],
    projection_version_no: authorityComplete && projection ? projection.projectionVersionNo : null,
    updated_at: route.updatedAt.toISOString(),
  };
}
