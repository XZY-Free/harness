/**
 * Artifact Attestation 控制面合同 — 稳定 DTO。
 *
 * Attestation 是不可变证据，一旦写入不可修改。
 * 撤销通过 AttestationRevocationRecord 表达，不修改 Attestation 本身。
 */

/** Attestation 格式。 */
export type AttestationFormat = "in_toto_dsse";

/** Artifact 类型。 */
export type ArtifactKind =
  | "agent_revision"
  | "runtime_revision"
  | "skill_package"
  | "tool_provider"
  | "policy_bundle";

/** Attestation 状态 — 由验证流程决定。 */
export type AttestationState = "verified" | "failed";

/** Attestation 详情。 */
export interface ArtifactAttestationDTO {
  id: string;
  tenant_id: string;
  artifact_id: string | null;
  artifact_type: ArtifactKind;
  artifact_revision_id: string;
  artifact_digest: string;
  dsse_envelope_ref: string | null;
  sbom_ref: string | null;
  provenance_ref: string | null;
  builder_identity: string | null;
  verification_state: AttestationState;
  policy_revision_id: string | null;
  source_revision: string | null;
  build_pipeline: string | null;
  dependency_lock_file_hash: string | null;
  build_time: string | null;
  scan_summary: unknown;
  failure_code: string | null;
  verified_at: string | null;
  attestation_format: AttestationFormat;
  statement_type: string | null;
  predicate_type: string | null;
  bundle_digest: string | null;
  subject_name: string | null;
  subject_digest: string | null;
  verification_engine: string | null;
  verification_engine_version: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revocation_reason: string | null;
  created_at: string;
}

/** Attestation 列表响应。 */
export interface ArtifactAttestationListResponse {
  items: ArtifactAttestationDTO[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
}

/** 验证 Attestation 请求。 */
export interface VerifyAttestationRequest {
  artifact_type: ArtifactKind;
  artifact_revision_id: string;
  artifact_digest: string;
  dsse_envelope_ref: string;
  builder_identity: string;
  policy_revision_id?: string;
}

/** 验证 Attestation 结果。 */
export interface VerifyAttestationResultDTO {
  attestation_id: string;
  artifact_revision_id: string;
  artifact_digest: string;
  verification_state: AttestationState;
  builder_identity: string | null;
  policy_revision_id: string | null;
  verified_at: string | null;
}

export interface ArtifactAttestationListParams {
  artifact_type?: ArtifactKind;
  artifact_revision_id?: string;
  artifact_digest?: string;
  verification_state?: AttestationState;
  revoked?: boolean;
  limit?: number;
  cursor?: string;
}
