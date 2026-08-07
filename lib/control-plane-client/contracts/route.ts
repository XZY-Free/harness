/**
 * Route 控制面合同 — 稳定 DTO。
 *
 * RouteSet 是原子激活单位。单 Route 写入口已删除（§T11）。
 * 禁用操作必须调用正式 DisableRoute，禁止自行重建 Route 内容。
 */

/** Route 状态。 */
export type RouteState = "enabled" | "disabled";

/** Route Activation 状态。 */
export type RouteActivationState = "active" | "superseded" | "disabled";

/** Route Eligibility 状态。 */
export type RouteEligibilityState = "eligible" | "ineligible" | "unknown";

/** DeploymentRouteSet 详情。 */
export interface DeploymentRouteSetDTO {
  id: string;
  tenant_id: string;
  agent_id: string;
  version_no: number;
  updated_at: string | null;
}

/** DeploymentRoute 详情。 */
export interface DeploymentRouteDTO {
  id: string;
  route_set_id: string;
  route_key: string;
  route_group_id: string;
  route_state: RouteState;
  agent_revision_id: string | null;
  runtime_revision_id: string | null;
  policy_revision_id: string | null;
  traffic_weight: number;
  priority_no: number;
  effective_from: string | null;
  effective_until: string | null;
  active_route_revision_id: string | null;
  active_route_activation_id: string | null;
  /** Eligibility — 由服务端 Projection 计算。 */
  eligibility_state: RouteEligibilityState;
  ineligibility_reasons: string[];
  updated_at: string | null;
}

/** RouteRevision 详情。 */
export interface RouteRevisionDTO {
  id: string;
  route_id: string;
  tenant_id: string;
  agent_revision_id: string;
  runtime_revision_id: string;
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

/** RouteSet 激活请求。 */
export interface ActivateRouteSetRequest {
  expected_version_no: number;
  reason: string;
  routes: Array<{
    route_id?: string;
    route_group_id: string;
    agent_revision_id: string;
    runtime_revision_id: string;
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
