/**
 * Artifact Evidence 统一快照 — 所有制品证据资格判断的唯一事实源。
 *
 * 供 Agent 发布、Runtime 发布、RouteSet 激活、Projection 构建、
 * ExecutionBinding 最终检查共同使用。
 *
 * 任何模块不得自行定义第二套证据快照。
 * 参见：SnowHarness专题01全局统一与最终收敛方案 §1.1
 */

/** Attestation 格式枚举。 */
export const ATTESTATION_FORMATS = ["legacy_custom", "in_toto_dsse", "sigstore_bundle"] as const;
export type AttestationFormat = (typeof ATTESTATION_FORMATS)[number];

/** 制品类型枚举 — AgentRevision 和 RuntimeRevision 的制品证据共享同一模型。 */
export const ARTIFACT_TYPES = ["agent_revision", "runtime_revision"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/**
 * Artifact Evidence 快照 — Store FOR UPDATE 读取的完整证据。
 *
 * 应用服务通过此快照调用 ArtifactEvidencePolicy，
 * 不在应用层复制 Attestation 判断逻辑。
 */
export interface ArtifactEvidenceSnapshot {
  /** 租户 ID。 */
  tenantId: string;
  /** 制品类型（agent_revision / runtime_revision）。 */
  artifactType: ArtifactType;
  /** 制品 Revision ID。 */
  artifactRevisionId: string;
  /** 权威 Artifact ID。 */
  artifactId: string;
  /** Artifact Digest。 */
  artifactDigest: string;
  /** Attestation 记录 ID。 */
  attestationId: string;
  /** 验证状态。 */
  verificationState: "verified" | "failed" | "pending";
  /** Attestation 格式。 */
  attestationFormat: AttestationFormat;
  /** 验证通过时间。 */
  verifiedAt: Date | null;
  /** 撤销时间。 */
  revokedAt: Date | null;
  /** 撤销记录 ID。 */
  revocationRecordId: string | null;
  /** 验证策略 Revision ID。 */
  verificationPolicyRevisionId: string | null;
  /** Bundle Digest（in-toto / sigstore 模式）。 */
  bundleDigest: string | null;
}

/**
 * Artifact Evidence 资格校验结果。
 */
export interface ArtifactEvidenceValidationResult {
  valid: boolean;
  errors: ArtifactEvidenceValidationError[];
}

/** 单条证据校验错误。 */
export interface ArtifactEvidenceValidationError {
  code: ArtifactEvidenceErrorCode;
  message: string;
}

/** 证据校验错误码 — 统一，禁止各模块自定义。 */
export type ArtifactEvidenceErrorCode =
  | "evidence_tenant_mismatch"
  | "evidence_artifact_type_mismatch"
  | "evidence_revision_binding_mismatch"
  | "evidence_not_verified"
  | "evidence_revoked"
  | "evidence_digest_mismatch"
  | "evidence_format_not_allowed"
  | "evidence_missing_artifact_id"
  | "evidence_missing_for_route_activation"
  | "evidence_missing_for_execution";
