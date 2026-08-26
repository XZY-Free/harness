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

/** AgentRevision 列表与命令响应的稳定摘要。 */
export interface AgentRevisionSummaryDTO {
  id: string;
  agent_id: string;
  revision_no: number;
  revision_state: AgentRevisionState;
  agent_contract_snapshot_id: string | null;
  etag: string;
}

/** AgentRevision 详情。 */
export interface AgentRevisionDTO {
  id: string;
  agent_id: string;
  revision_no: number;
  revision_state: AgentRevisionState;
  /** 绑定的不可变 AgentContractSnapshot id（权威外部合同来源）。 */
  agent_contract_snapshot_id: string;
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
  /** 绑定的不可变 AgentContractSnapshot id（发布强约束；必填非空白）。 */
  agent_contract_snapshot_id: string;
  model_policy: Record<string, unknown>;
  permission_requirements: Record<string, unknown>;
  delegation_policy: Record<string, unknown>;
  agent_interface_requirements: Record<string, unknown>;
}

export interface PublishAgentRevisionRequest {
  release_notes: string;
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

// ─── AgentContractSnapshot ────────────────────────────────

export interface LocalizedTextDTO {
  "zh-CN": string | null;
  en: string | null;
}

export interface AgentContractCapabilityDTO {
  key: string;
  name: LocalizedTextDTO;
  description: LocalizedTextDTO;
  tags: string[];
  examples: string[];
  input_modes: string[];
  output_modes: string[];
}

export interface AgentContractContextDTO {
  key: string;
  name: LocalizedTextDTO;
  description: LocalizedTextDTO;
  necessity: "required" | "preferred" | "accepted";
  applies_to: string[] | null;
  trust_requirement: string | null;
  declaration_source: "provider_declared" | "operator_declared";
}

export interface AgentContractSnapshotDTO {
  snapshot_id: string;
  contract_version: string;
  public_agent_version: string;
  protocol_type: string;
  protocol_contract_revision: string;
  contract_digest: string;
  /** Capability Manifest canonical digest（07 §5 展示用）。 */
  capability_digest: string;
  /** Invocation Context Contract canonical digest（07 §5 展示用）。 */
  context_digest: string;
  interaction: {
    streaming_transport: boolean;
    incremental_content: boolean;
    input_required: boolean;
    resume: boolean;
    cancel: boolean;
    durable_task_recovery: boolean;
    supported_locales: string[];
  };
  capabilities: AgentContractCapabilityDTO[];
  invocation_context: AgentContractContextDTO[];
  result_contract: {
    fields: string[];
    error_codes: string[];
    notes: LocalizedTextDTO;
  };
  captured_at: string;
}

export interface AgentContractListResponse {
  items: AgentContractSnapshotDTO[];
  total: number;
}

// ─── Agent Contract 登记（07 §4，POST /admin/api/v1/agent-registrations） ────

/** 登记请求：顶层恰为 protocol + contract（禁止 URL/Git/源码路径/endpoint/凭证字段）。 */
export interface RegisterAgentContractRequest {
  protocol: {
    type: string;
    contract_revision: string;
  };
  contract: unknown;
}

/** 登记响应：Agent 摘要 + 结构化快照投影（无原始合同回显）。 */
export interface RegisterAgentContractResponse {
  agent: {
    id: string;
    agent_key: string;
    display_name: string;
    lifecycle_state: AgentLifecycleState;
  };
  contract: AgentContractSnapshotDTO;
}

// ─── External Runtime 登记（07 §7，POST /admin/api/v1/agents/{id}/runtime-registrations） ──

/** 能力驱动 Conformance probe 输入（02 §2；false 能力必须缺席，不发隐藏空字段）。 */
export interface RegisterAgentRuntimeConformance {
  basic: { input: string };
  input_required?: { input: string };
  resume?: { start_input: string; resume_input: string };
  cancel?: { input: string };
}

/** External Runtime 登记请求（冻结 wire：authentication 恰为 mode + credential_ref_id）。 */
export interface RegisterAgentRuntimeRequest {
  contract_snapshot_id: string;
  runtime_endpoint: string;
  authentication: {
    mode: "none" | "bearer";
    credential_ref_id: string | null;
  };
  conformance: RegisterAgentRuntimeConformance;
}

/** 结构化 measured 证据矩阵（02 §9）。 */
export interface RuntimeMeasuredEvidenceDTO {
  agent_card: {
    protocol_version: "pass";
    transport: "pass";
    streaming_consistency: "pass";
  };
  basic_invocation: { status: "pass" };
  features: {
    streaming_transport: "pass" | "not_applicable";
    incremental_content: "pass" | "not_applicable";
    input_required: "pass" | "not_applicable";
    resume: "pass" | "not_applicable";
    cancel: "pass" | "not_applicable";
    durable_task_recovery: "not_measured";
  };
}

/** External Runtime 登记响应（07 §9：只含 id/状态/digest/measured 矩阵）。 */
export interface RegisterAgentRuntimeResponse {
  agent_id: string;
  agent_contract_snapshot_id: string;
  runtime_id: string;
  runtime_revision_id: string;
  runtime_key: string;
  runtime_endpoint: string;
  protocol: { type: string; contract_revision: string };
  verification_state: string;
  verified_at: string;
  runtime_target_digest: string;
  evidence_digest: string;
  config_hash: string;
  measured: RuntimeMeasuredEvidenceDTO;
}

// ─── CredentialRef（07 §7：bearer 只能选择已有 CredentialRef） ───────────────

/** CredentialRef 摘要（无 vaultRef/secret 值）。 */
export interface CredentialRefSummaryDTO {
  id: string;
  provider: string;
  fingerprint: string;
  lifecycle_state: string;
  expires_at: string | null;
}

export interface CredentialRefListResponse {
  items: CredentialRefSummaryDTO[];
  total: number;
}
