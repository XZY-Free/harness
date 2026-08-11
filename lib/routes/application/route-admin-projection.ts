import type {
  DeploymentRouteDTO,
  DeploymentRouteSetDTO,
} from "@/lib/control-plane-client/contracts/route";

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
    agentRevisionId: string;
    runtimeRevisionId: string;
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

export function projectAdminRouteSet(routeSet: {
  id: string;
  tenantId: string;
  agentId: string;
  routeScopeKey: string;
  routeScopeJson: unknown;
  versionNo: number;
  createdAt: Date;
  updatedAt: Date;
}): DeploymentRouteSetDTO {
  return {
    id: routeSet.id,
    tenant_id: routeSet.tenantId,
    agent_id: routeSet.agentId,
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
    agent_revision_id: revision?.agentRevisionId ?? null,
    runtime_revision_id: revision?.runtimeRevisionId ?? null,
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
