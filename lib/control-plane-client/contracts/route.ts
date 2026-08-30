/**
 * Route 控制面合同 — 稳定 DTO。
 *
 * RouteSet 是原子激活单位。单 Route 写入口已删除（§T11）。
 * 禁用操作必须调用正式 DisableRoute，禁止自行重建 Route 内容。
 */

/** Route 状态。 */
export type RouteState = "enabled" | "disabled";

/** RouteSet 目标判别 wire 形状 — 禁止 flat/nullable 双轨。 */
export type RouteSetTargetDTO = { kind: "runtime" } | { kind: "agent"; agent_id: string };

/**
 * RouteRevision/Route target 判别 wire 形状。
 * Agent target 绝不携带 runtime 字段；Runtime target 绝不携带 Agent 字段。
 */
export type RouteRevisionTargetDTO =
  | { kind: "runtime"; runtime_revision_id: string }
  | {
      kind: "agent";
      agent_revision_id: string;
      endpoint_ref: string;
      identity_mode: "none" | "bearer";
      credential_ref_id: string | null;
      network_zone: string;
    };

/** Route Activation 状态。 */
export type RouteActivationState = "active" | "disabled";

/** Route Eligibility 状态。 */
export type RouteEligibilityState = "eligible" | "ineligible" | "pending_rebuild" | "missing";

/** DeploymentRouteSet 详情。 */
export interface DeploymentRouteSetDTO {
  id: string;
  tenant_id: string;
  /** 判别 target — runtime 或 agent。 */
  target: RouteSetTargetDTO;
  route_scope_key: string;
  route_scope: unknown;
  version_no: number;
  created_at: string;
  updated_at: string;
}

/** DeploymentRoute 详情。 */
export interface DeploymentRouteDTO {
  id: string;
  route_set_id: string;
  route_key: string;
  route_group_id: string | null;
  route_state: RouteState;
  /** 判别 target — 仅 Authority 完整（有最新 Revision）时非 null，否则整体 null。 */
  target: RouteRevisionTargetDTO | null;
  policy_revision_id: string | null;
  traffic_weight: number | null;
  priority_no: number | null;
  effective_from: string | null;
  effective_until: string | null;
  active_route_revision_id: string | null;
  active_route_activation_id: string | null;
  activation_state: RouteActivationState | null;
  route_content_digest: string | null;
  /** Eligibility — 由服务端 Projection 计算。 */
  eligibility_state: RouteEligibilityState;
  ineligibility_reasons: string[];
  projection_version_no: number | null;
  updated_at: string;
}

/** RouteRevision 详情。 */
export interface RouteRevisionDTO {
  id: string;
  route_id: string;
  tenant_id: string;
  /** 判别 target — RouteRevision 永远有 Authority，故非 null。 */
  target: RouteRevisionTargetDTO;
  policy_revision_id: string | null;
  content_digest: string;
  activation_state: RouteActivationState;
  created_at: string;
}

/** RouteActivation 详情。 */
export interface RouteActivationDTO {
  id: string;
  route_id: string;
  route_revision_id: string;
  activation_state: RouteActivationState;
  activation_sequence: number;
  /** 前一个被取代的 Activation — 形成历史链。 */
  previous_route_activation_id: string | null;
  activated_at: string;
}

/** RouteSet create-or-reuse（ensure）请求 — 严格三 key，target 为判别联合。 */
export interface EnsureRouteSetRequest {
  target: RouteSetTargetDTO;
  route_scope_key: string;
  route_scope: Record<string, unknown>;
}

/** RouteSet ensure 响应 — 与详情 DTO 不同，不含 tenant_id。 */
export interface EnsureRouteSetResponse {
  id: string;
  /** 判别 target。 */
  target: RouteSetTargetDTO;
  route_scope_key: string;
  route_scope: unknown;
  version_no: number;
  created_at: string;
  updated_at: string;
  created: boolean;
}

/** RouteSet 激活请求。 */
export interface ActivateRouteSetRequest {
  expected_version_no: number;
  reason: string;
  routes: Array<{
    route_id?: string;
    route_group_id: string;
    /** 判别 target — 只含所选 target 自己的事实。 */
    target: RouteRevisionTargetDTO;
    policy_revision_id?: string;
    model_policy_revision_id?: string;
    toolset_revision_id?: string;
    traffic_weight: number;
    priority_no: number;
    effective_from?: string;
    effective_until?: string;
    eligibility_conditions?: Record<string, unknown>;
    activation_state?: "active" | "disabled";
  }>;
}

/** RouteSet 激活响应。 */
export interface ActivateRouteSetResponse {
  route_set_id: string;
  route_set_version_no: number;
  activations: Array<{
    route_id: string;
    route_revision_id: string;
    route_activation_id: string;
    activation_state: RouteActivationState;
    route_group_id: string;
    previous_route_revision_id: string | null;
    previous_route_activation_id: string | null;
  }>;
  affected_new_invocations_only: boolean;
}

/** 禁用 Route 请求。 */
export interface DisableRouteRequest {
  reason: string;
}

/** 禁用 Route 响应。禁用只追加 Activation，不创建新 Revision。 */
export interface DisableRouteResponse {
  route_id: string;
  route_set_id: string;
  route_set_version_no: number;
  route_revision_id: string;
  route_activation_id: string;
  previous_route_activation_id: string;
  activation_state: "disabled";
  affects_new_invocations_only: true;
}
