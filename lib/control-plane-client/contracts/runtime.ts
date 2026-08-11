/**
 * Runtime 控制面合同 — 稳定 DTO。
 *
 * Runtime 发布操作必须显式选择 Attestation ID 和 Conformance Run ID，
 * 禁止服务端自动找当前任意证据。
 */

// ─── Runtime ──────────────────────────────────────────────

/** Runtime 类型。 */
export type RuntimeKind = "hosted" | "external";

/** Runtime 生命周期状态。 */
export type RuntimeLifecycleState = "draft" | "enabled" | "disabled" | "retired";

/** Runtime 列表项。 */
export interface RuntimeDTO {
  id: string;
  tenant_id: string;
  runtime_key: string;
  display_name: string;
  kind: RuntimeKind;
  lifecycle_state: RuntimeLifecycleState;
  owner_user_id: string;
  current_revision_id: string | null;
  version_no: number;
  created_at: string;
  updated_at: string;
}

/** Runtime 列表响应。 */
export interface RuntimeListResponse {
  items: RuntimeDTO[];
  total: number;
}

// ─── RuntimeRevision ──────────────────────────────────────

/** RuntimeRevision 状态。 */
export type RuntimeRevisionState = "draft" | "published" | "withdrawn";

/** RuntimeRevision 详情。 */
export interface RuntimeRevisionDTO {
  id: string;
  runtime_id: string;
  revision_no: number;
  revision_state: RuntimeRevisionState;
  protocol_type: string;
  protocol_contract_revision: string;
  endpoint_ref: string;
  artifact_id: string | null;
  artifact_digest: string | null;
  artifact_ref: string;
  config_hash: string;
  runtime_capabilities: unknown;
  identity_mode: string;
  network_zone: string;
  /** 当前验证通过且未撤销的 Attestation。 */
  attestation_ids: string[];
  /** Publication Record。 */
  publication_record_id: string | null;
  /** Withdrawal Record。 */
  withdrawal_record_id: string | null;
  /** Conformance Run — 不为 null 时表示已通过 Conformance。 */
  conformance_run_id: string | null;
  conformance_overall_result: RuntimeConformanceOverallResult | null;
  /** 执行资格 — 由服务端计算。 */
  execution_eligible: boolean;
  ineligibility_reasons: string[];
  created_at: string;
  published_at: string | null;
}

// ─── RuntimeConformanceRun ────────────────────────────────

/** Conformance 总体结果。 */
export type RuntimeConformanceOverallResult = "passed" | "failed" | "error" | "cancelled";

/** Conformance Case 结果。 */
export interface RuntimeConformanceCaseResultDTO {
  case_id: string;
  passed: boolean;
  reason: string | null;
  evidence_digest: string;
}

/** RuntimeConformanceRun 详情。 */
export interface RuntimeConformanceRunDTO {
  id: string;
  tenant_id: string;
  runtime_revision_id: string;
  runtime_artifact_digest: string;
  runtime_config_digest: string;
  protocol_contract_revision: string;
  overall_result: RuntimeConformanceOverallResult;
  runner_identity: string;
  suite_revision: string;
  runner_artifact_digest: string;
  test_environment_revision: string;
  conformance_format: "standard_dsse";
  evidence_manifest_digest: string;
  envelope_digest: string;
  payload_digest: string;
  signing_key_id: string;
  verification_engine: string;
  verification_engine_version: string;
  predicate_type: string;
  verified_at: string;
  started_at: string;
  completed_at: string;
  recorded_at: string;
  case_results: RuntimeConformanceCaseResultDTO[];
}

/** 发布 RuntimeRevision 请求 — 必须显式传入精确证据。 */
export interface PublishRuntimeRevisionRequest {
  expected_version_no: number;
  attestation_id: string;
  conformance_run_id: string;
}

export interface PublishRuntimeRevisionResponse {
  id: string;
  revision_state: "published";
  published_at: string;
  publication_record_id: string;
  conformance_run_id: string;
  audit_event_id: string;
}

/** 记录 Conformance Run 请求。 */
export interface RecordConformanceRunRequest {
  dsse_envelope: string;
}

export interface RuntimeConformanceSubmissionDTO {
  runtime_revision_id: string;
  revision_state: RuntimeRevisionState;
  published: boolean;
  published_at: string | null;
  etag: string | null;
  conformance_run_id: string;
  results: Array<{
    case_id: string;
    passed: boolean;
    reason: string | null;
    adapter_digest: string | null;
    test_environment: string | null;
    evidence_ref: string | null;
    tested_at: string;
  }>;
}

export interface WithdrawRuntimeRevisionRequest {
  reason_code: string;
  reason: string;
}

export interface WithdrawRuntimeRevisionResponse {
  id: string;
  revision_state: "withdrawn";
  withdrawal_record_id: string;
  current_revision_id: string | null;
  audit_event_id: string;
}
