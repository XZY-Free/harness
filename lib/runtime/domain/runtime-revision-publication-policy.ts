/**
 * RuntimeRevision 发布领域策略。
 *
 * Conformance 合同类型由 runtime-conformance-contract.ts 统一导出；
 * 本文件定义发布资格和错误类型。
 *
 * ⚠️ Attestation 证据策略已迁移至统一模型：
 * lib/artifacts/domain/artifact-evidence-policy.ts
 * 本文件保留 Runtime 发布专有错误类型，不再定义 ArtifactEvidencePolicy。
 * 参见：SnowHarness专题01全局统一与最终收敛方案
 */
import {
  ALL_CONFORMANCE_CASES,
  CONFORMANCE_SUITE_REVISION,
  type ConformanceCaseId,
  type ConformanceCaseResult,
  type ConformanceGateResult,
  MANDATORY_GATE_CASES,
  validateConformanceGate,
} from "@/lib/runtime/domain/runtime-conformance-contract";

// Re-export for backward compatibility
export {
  ALL_CONFORMANCE_CASES,
  CONFORMANCE_SUITE_REVISION,
  MANDATORY_GATE_CASES,
  type ConformanceCaseId,
  type ConformanceCaseResult,
  type ConformanceGateResult,
  validateConformanceGate,
};

// Re-export 统一 Artifact Evidence Policy（替代本文件原 Runtime 专属实现）
export {
  ArtifactEvidencePolicy,
  createArtifactEvidencePolicy,
  type ArtifactEvidencePolicyConfig,
} from "@/lib/artifacts/domain/artifact-evidence-policy";
export type {
  ArtifactEvidenceSnapshot,
  ArtifactEvidenceValidationResult,
  ArtifactEvidenceValidationError,
  ArtifactEvidenceErrorCode,
  ArtifactType as ArtifactEvidenceArtifactType,
  AttestationFormat as ArtifactEvidenceAttestationFormat,
} from "@/lib/artifacts/domain/artifact-evidence";

export type RuntimeRevisionPublicationState = "draft" | "published" | "withdrawn";

// ─── 发布资格错误 ────────────────────────────────────────

export class RuntimeConformanceCaseFailedError extends Error {
  constructor(public readonly failedCases: ConformanceCaseId[]) {
    super(`Conformance 门禁失败，缺失/失败的 mandatory case：${failedCases.join(", ")}`);
    this.name = "RuntimeConformanceCaseFailedError";
  }
}

export class RuntimeRevisionNotFoundError extends Error {
  constructor(public readonly revisionId: string) {
    super(`RuntimeRevision 不存在: ${revisionId}`);
    this.name = "RuntimeRevisionNotFoundError";
  }
}

export class RuntimeRevisionStateError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly fromState: RuntimeRevisionPublicationState,
    public readonly toState: RuntimeRevisionPublicationState,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeRevisionStateError";
  }
}

export class RuntimePublicationVersionConflictError extends Error {
  constructor(
    public readonly runtimeId: string,
    public readonly expectedVersionNo: number,
  ) {
    super(`Runtime ${runtimeId} versionNo 不匹配（期望 ${expectedVersionNo}），乐观锁冲突`);
    this.name = "RuntimePublicationVersionConflictError";
  }
}

export class RuntimePublicationIdempotencyCompletionError extends Error {
  constructor(public readonly recordId: string) {
    super(`RuntimeRevision 发布幂等记录无法完成: ${recordId}`);
    this.name = "RuntimePublicationIdempotencyCompletionError";
  }
}

// ─── 收紧发布合同错误类型 ──────────────────────────────

/** 发布命令缺少必填 attestationId。 */
export class RuntimeArtifactAttestationRequiredError extends Error {
  constructor(public readonly revisionId: string) {
    super(`RuntimeRevision ${revisionId} 发布必须提供 ArtifactAttestation`);
    this.name = "RuntimeArtifactAttestationRequiredError";
  }
}

/** Attestation 存在但不满足发布资格（绑定不一致、已撤销、验证失败等）。 */
export class RuntimeArtifactAttestationInvalidError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly attestationId: string,
    public readonly reason: string,
  ) {
    super(
      `RuntimeRevision ${revisionId} 的 Attestation ${attestationId} 不满足发布资格: ${reason}`,
    );
    this.name = "RuntimeArtifactAttestationInvalidError";
  }
}

/** 发布命令缺少必填 conformanceRunId。 */
export class RuntimeConformanceRunRequiredError extends Error {
  constructor(public readonly revisionId: string) {
    super(`RuntimeRevision ${revisionId} 发布必须提供 ConformanceRunId`);
    this.name = "RuntimeConformanceRunRequiredError";
  }
}

/** ConformanceRun 存在但与 Revision 绑定不一致。 */
export class RuntimeConformanceRunInvalidError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly conformanceRunId: string,
    public readonly reason: string,
  ) {
    super(
      `RuntimeRevision ${revisionId} 的 ConformanceRun ${conformanceRunId} 不满足发布资格: ${reason}`,
    );
    this.name = "RuntimeConformanceRunInvalidError";
  }
}
