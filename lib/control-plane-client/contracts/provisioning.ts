/**
 * Hosted Provisioning 控制面合同 — 稳定 DTO。
 *
 * Hosted 供应是异步步骤编排。客户端必须消费 Checkpoint 字段，
 * 禁止把"请求已创建"显示成"部署已完成"。
 */

/** Hosted 供应状态。 */
export type HostedProvisioningState =
  | "pending"
  | "running"
  | "retryable_failed"
  | "permanent_failed"
  | "ready"
  | "cancelled";

/** Hosted 供应步骤 — 正式步骤序列。 */
export type ProvisioningStep =
  | "validate_request"
  | "ensure_agent_publication"
  | "prepare_runtime_revision"
  | "verify_runtime_artifact"
  | "record_runtime_conformance"
  | "publish_runtime_revision"
  | "activate_route"
  | "await_projection"
  | "verify_route";

/** HostedProvisioningRequest 详情。 */
export interface HostedProvisioningRequestDTO {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_revision_id: string;
  route_scope_key: string;
  state: HostedProvisioningState;
  current_step: ProvisioningStep | null;
  last_completed_step: ProvisioningStep | null;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  /** Checkpoint 字段 — 步骤产出。 */
  agent_revision_id_checkpoint: string | null;
  agent_publication_record_id: string | null;
  agent_attestation_id: string | null;
  runtime_id: string | null;
  runtime_revision_id_checkpoint: string | null;
  runtime_artifact_id: string | null;
  runtime_attestation_ids: string[] | null;
  conformance_run_id: string | null;
  runtime_publication_record_id: string | null;
  route_set_id: string | null;
  route_set_version_no: number | null;
  route_id: string | null;
  route_revision_id: string | null;
  route_activation_id: string | null;
  projection_version_no: number | null;
  created_at: string;
  updated_at: string | null;
}

/** 请求 Hosted 供应。 */
export interface RequestHostedProvisioningRequest {
  agent_id: string;
  agent_revision_id: string;
  route_scope_key: string;
}
