/**
 * ExecutionBinding 控制面合同 — 稳定 DTO。
 *
 * Binding 是不可变执行授权。桌面端必须消费服务端返回的 Binding，
 * 禁止自行选择 Revision 或创建 Binding。
 */

/** ExecutionBinding 详情 — 冻结了 Resolver 使用的全部精确证据。 */
export interface ExecutionBindingDTO {
  invocation_id: string;
  tenant_id: string;
  /** null = 基础 Harness Route，无 Agent 资产约束（§8.3）。 */
  agent_revision_id: string | null;
  runtime_revision_id: string;
  deployment_route_id: string;
  model_provider: string;
  model_id: string;
  model_revision_ref: string | null;
  initial_environment_lease_id: string | null;
  workspace_binding_id: string | null;
  policy_revision_id: string | null;
  context_checkpoint_id: string | null;
  environment_definition_revision_id: string | null;
  /** 冻结的 Route 证据。 */
  route_revision_id: string;
  route_activation_id: string;
  route_content_digest: string;
  /** 冻结的 Agent 证据。null = 基础 Harness Route（Agent Evidence not_applicable，§18）。 */
  agent_artifact_id: string | null;
  agent_artifact_digest: string | null;
  agent_attestation_ids: string[] | null;
  agent_publication_record_id: string | null;
  /** 冻结的 Runtime 证据。 */
  runtime_artifact_id: string;
  runtime_artifact_digest: string;
  runtime_config_digest: string;
  runtime_attestation_ids: string[];
  runtime_publication_record_id: string;
  conformance_run_id: string;
  /** 冻结的 Policy / Capability 证据。 */
  capability_manifest_digest: string;
  resolution_input_digest: string;
  projection_version_no: number;
  config_hash: string;
  bound_at: string;
}
