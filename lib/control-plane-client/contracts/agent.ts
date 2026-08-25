/**
 * Agent 控制面合同 — 稳定 DTO。
 *
 * Web 端和桌面端共用此合同消费服务端 API。
 * 合同字段与 /admin/api/v1 wire format (snake_case) 对齐。
 *
 * 禁止：
 * - 页面直接引用数据库 Record；
 * - 通过 currentRevisionId 推断执行资格；
 * - 通过 revisionState 推断 Publication 状态。
 */

// ─── Agent ────────────────────────────────────────────────

/** Agent 生命周期状态 — 服务端权威枚举。 */
export type AgentLifecycleState = "draft" | "enabled" | "disabled" | "retired";

/** Agent 列表项（不含 Revision 详情）。 */
export interface AgentDTO {
  id: string;
  agent_key: string;
  display_name: string;
  description: string | null;
  lifecycle_state: AgentLifecycleState;
  current_revision_id: string | null;
  owner_user_id: string;
  visibility_policy_id: string | null;
  version_no: number;
  updated_at: string | null;
}

/** Agent 列表响应。 */
export interface AgentListResponse {
  items: AgentDTO[];
  total: number;
}

// ─── AgentRevision ────────────────────────────────────────

/** AgentRevision 状态 — 服务端权威枚举。 */
export type AgentRevisionState = "draft" | "published" | "withdrawn";

/** AgentRevision 来源。 */
export type AgentRevisionSourceType = "code" | "agent_yaml" | "veadk";

/** AgentRevision 列表与命令响应的稳定摘要。 */
export interface AgentRevisionSummaryDTO {
  id: string;
  agent_id: string;
  revision_no: number;
  revision_state: AgentRevisionState;
  source_revision: string;
  agent_descriptor_snapshot_id: string | null;
  etag: string;
}

/** AgentRevision 详情。 */
export interface AgentRevisionDTO {
  id: string;
  agent_id: string;
  revision_no: number;
  revision_state: AgentRevisionState;
  source_type: AgentRevisionSourceType;
  source_revision: string;
  artifact_id: string | null;
  artifact_digest: string | null;
  artifact_ref: string;
  /** 绑定的不可变 AgentDescriptorSnapshot id（Batch 2 权威外部合同来源）。 */
  agent_descriptor_snapshot_id: string | null;
  /** 当前 Attestation 列表 — 不为 null 时表示已验证。 */
  attestation_ids: string[];
  /** 当前 Publication Record — 不为 null 时表示已发布。 */
  publication_record_id: string | null;
  /** 当前 Withdrawal Record — 不为 null 时表示已撤回。 */
  withdrawal_record_id: string | null;
  /** 执行资格 — 由服务端 Eligibility Policy 计算，客户端禁止推断。 */
  execution_eligible: boolean;
  /** 资格不足原因 — eligible 为 false 时非空。 */
  ineligibility_reasons: string[];
  created_at: string;
  published_at: string | null;
}

/** AgentRevision 列表响应。 */
export interface AgentRevisionListResponse {
  items: AgentRevisionSummaryDTO[];
  total: number;
}

/** 创建 Draft AgentRevision 请求。 */
export interface CreateAgentRevisionRequest {
  source: {
    source_type: AgentRevisionSourceType;
    source_revision: string;
  };
  artifact_ref: string;
  instruction_hash: string;
  /** 绑定的不可变 AgentDescriptorSnapshot id（Batch 2 正式发布强约束；可空以兼容旧 Revision）。 */
  agent_descriptor_snapshot_id?: string;
  model_policy: Record<string, unknown>;
  permission_requirements: Record<string, unknown>;
  delegation_policy: Record<string, unknown>;
  agent_interface_requirements: Record<string, unknown>;
}

export interface PublishAgentRevisionRequest {
  release_notes: string;
  /** 可选 source Attestation id — Batch 2 不再强制；发布权威是 AgentDescriptorSnapshot 证据。 */
  artifact_attestation_id?: string | null;
}

export interface PublishAgentRevisionResponse {
  id: string;
  revision_state: "published";
  published_at: string;
  audit_event_id: string;
}

export interface WithdrawAgentRevisionRequest {
  reason_code: string;
  reason: string;
}

export interface WithdrawAgentRevisionResponse {
  id: string;
  revision_state: "withdrawn";
  withdrawal_record_id: string;
  current_revision_id: string | null;
  audit_event_id: string;
}

// ─── AgentDescriptorSnapshot ──────────────────────────────

/** context 必要性 — 服务端权威枚举。 */
export type ContextNecessity = "required" | "preferred" | "accepted";

/** 合同声明来源 — 服务端权威枚举。 */
export type ProvenanceSource = "provider_declared" | "operator_declared";

/** Provider 公开 Agent Card 中的单项业务能力（task-oriented，禁止函数签名）。 */
export interface ProviderCapabilityDTO {
  capability_key: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  input_modes?: string[];
  output_modes?: string[];
}

/** Provider 公开 Agent Card 中的调用上下文声明。 */
export interface ProviderInvocationContextDeclarationDTO {
  context_kind: string;
  necessity: ContextNecessity;
  purpose?: string;
}

/** Provider 正式公开的 Agent Card（wire 输入）。 */
export interface ProviderAgentCardDTO {
  protocol: {
    type: string;
    contract_revision: string;
  };
  identity?: {
    name?: string;
    description?: string;
    provider_revision_ref?: string;
  };
  capabilities: ProviderCapabilityDTO[];
  invocation_context?: ProviderInvocationContextDeclarationDTO[];
}

/** 管理员基于第三方正式接入合同登记的 supplemental context（operator_declared）。 */
export interface OperatorContextSupplementDTO {
  contexts: Array<{
    context_kind: string;
    necessity: ContextNecessity;
    purpose?: string;
  }>;
}

/** 登记 Agent Descriptor 请求。 */
export interface CreateAgentDescriptorSnapshotRequest {
  descriptor_kind: string;
  card: ProviderAgentCardDTO;
  operator_context_supplement?: OperatorContextSupplementDTO;
  provider_declared_revision_ref?: string;
}

/** AgentDescriptorSnapshot 登记响应。 */
export interface CreateAgentDescriptorSnapshotResponse {
  snapshot_id: string;
  provider_descriptor_digest: string;
  capability_manifest_digest: string;
  invocation_context_contract_digest: string;
  descriptor_kind: string;
  protocol_type: string;
  protocol_contract_revision: string;
  captured_at: string;
}

/** AgentDescriptorSnapshot 列表项。 */
export interface AgentDescriptorSnapshotDTO {
  id: string;
  agent_id: string;
  descriptor_kind: string;
  protocol_type: string;
  protocol_contract_revision: string;
  provider_descriptor_digest: string;
  capability_manifest_digest: string;
  invocation_context_contract_digest: string;
  provider_declared_revision_ref: string | null;
  captured_at: string;
  created_by: string;
}

/** AgentDescriptorSnapshot 列表响应。 */
export interface AgentDescriptorSnapshotListResponse {
  items: AgentDescriptorSnapshotDTO[];
  total: number;
}

// ─── AgentDescriptorSnapshot（09 External Contract 展示） ───

/** Capability Manifest 项（任务能力描述，非函数列表）。 */
export interface AgentCapabilityDTO {
  capability_key: string;
  display_name?: string | null;
  description?: string | null;
  tags?: string[] | null;
  examples?: string[] | null;
}

/** Invocation Context Contract 项（context kind + purpose + 来源）。 */
export interface AgentContextContractItemDTO {
  context_kind: string;
  purpose?: string | null;
  declaration_source?: string | null;
}

/** AgentDescriptorSnapshot 摘要 + 合同投影（09 §1 External Contract）。 */
export interface AgentDescriptorSnapshotDTO {
  id: string;
  agent_id: string;
  descriptor_kind: string;
  protocol_type: string;
  protocol_contract_revision: string;
  provider_descriptor_digest: string;
  capability_manifest_digest: string;
  invocation_context_contract_digest: string;
  normalized_capability_manifest: { capabilities?: AgentCapabilityDTO[] } & Record<string, unknown>;
  invocation_context_contract: {
    required?: AgentContextContractItemDTO[];
    preferred?: AgentContextContractItemDTO[];
    accepted?: AgentContextContractItemDTO[];
  } & Record<string, unknown>;
  contract_section_provenance: Record<string, string>;
  provider_declared_revision_ref: string | null;
  captured_at: string;
  created_by: string;
}

/** Agent Descriptor Snapshot 列表响应。 */
export interface AgentDescriptorListResponse {
  items: AgentDescriptorSnapshotDTO[];
  total: number;
}
