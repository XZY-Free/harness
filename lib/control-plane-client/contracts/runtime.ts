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
export type RuntimeLifecycleState = "enabled" | "disabled" | "deleted";

/** Runtime 列表项。 */
export interface RuntimeDTO {
  id: string;
  runtime_key: string;
  display_name: string;
  description: string | null;
  kind: RuntimeKind;
  lifecycle_state: RuntimeLifecycleState;
  current_revision_id: string | null;
  updated_at: string | null;
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
  revision_state: RuntimeRevisionState;
  artifact_digest: string | null;
  artifact_ref: string | null;
  config_hash: string | null;
  runtime_capabilities: Record<string, unknown> | null;
  protocol_contract_revision: string | null;
  /** Attestation 列表 — 不为 null 时表示已验证。 */
  attestation_ids: string[] | null;
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
  updated_at: string | null;
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
  runtime_revision_id: string;
  overall_result: RuntimeConformanceOverallResult;
  runner_identity: string;
  suite_revision: string;
  started_at: string;
  completed_at: string;
  case_results: RuntimeConformanceCaseResultDTO[];
}

/** 发布 RuntimeRevision 请求 — 必须显式传入精确证据。 */
export interface PublishRuntimeRevisionRequest {
  attestation_ids: string[];
  conformance_run_id: string;
}

/** 记录 Conformance Run 请求。 */
export interface RecordConformanceRunRequest {
  conformance_report_json: string;
}
