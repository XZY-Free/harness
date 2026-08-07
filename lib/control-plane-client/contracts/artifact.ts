/**
 * Artifact Attestation 控制面合同 — 稳定 DTO。
 *
 * Attestation 是不可变证据，一旦写入不可修改。
 * 撤销通过 AttestationRevocationRecord 表达，不修改 Attestation 本身。
 */

/** Attestation 格式。 */
export type AttestationFormat = "in_toto_dsse";

/** Artifact 类型。 */
export type ArtifactKind = "agent" | "runtime";

/** Attestation 状态 — 由验证流程决定。 */
export type AttestationState = "verified" | "pending" | "failed" | "revoked";

/** Attestation 详情。 */
export interface ArtifactAttestationDTO {
  id: string;
  tenant_id: string;
  subject_ref: string;
  subject_digest: string;
  artifact_type: ArtifactKind;
  attestation_format: AttestationFormat;
  attestation_state: AttestationState;
  key_id: string;
  runner_identity: string;
  predicate_type: string;
  /** 签名验证结果 — verified 时保证完整信任链。 */
  signature_valid: boolean;
  /** Provenance Predicate 关键字段摘要。 */
  builder_identity: string | null;
  source_revision: string | null;
  sbom_ref: string | null;
  sbom_digest: string | null;
  provenance_ref: string | null;
  provenance_digest: string | null;
  /** 撤销信息。 */
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
}

/** Attestation 列表响应。 */
export interface ArtifactAttestationListResponse {
  items: ArtifactAttestationDTO[];
  total: number;
}

/** 验证 Attestation 请求。 */
export interface VerifyAttestationRequest {
  dsse_envelope_b64: string;
  subject_ref: string;
  subject_digest: string;
  artifact_type: ArtifactKind;
}

/** 验证 Attestation 结果。 */
export interface VerifyAttestationResultDTO {
  attestation_id: string;
  attestation_state: AttestationState;
  signature_valid: boolean;
  builder_identity: string;
  sbom_ref: string | null;
  provenance_ref: string | null;
}
