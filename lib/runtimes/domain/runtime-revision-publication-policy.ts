/**
 * RuntimeRevision 发布领域策略。
 *
 * Conformance 合同类型由 runtime-conformance-contract.ts 统一导出；
 * 本文件定义发布资格、错误类型和 Attestation 证据策略。
 */
import {
  ALL_CONFORMANCE_CASES,
  CONFORMANCE_SUITE_REVISION,
  MANDATORY_GATE_CASES,
  type ConformanceCaseId,
  type ConformanceCaseResult,
  type ConformanceGateResult,
  validateConformanceGate,
} from "@/lib/runtimes/domain/runtime-conformance-contract";

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

export type RuntimeRevisionPublicationState = "draft" | "published" | "withdrawn";

// ─── 发布资格错误 ────────────────────────────────────────

export class RuntimeConformanceCaseFailedError extends Error {
  constructor(public readonly failedCases: ConformanceCaseId[]) {
    super(`Conformance 门禁失败，缺失/失败的 mandatory case：${failedCases.join(", ")}`);
    this.name = "RuntimeConformanceCaseFailedError";
  }
}

/** @deprecated 使用 RuntimeConformanceCaseFailedError */
export const ConformanceGateError = RuntimeConformanceCaseFailedError;

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

// ─── 新增：收紧发布合同错误类型 ──────────────────────────────

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
    super(`RuntimeRevision ${revisionId} 的 Attestation ${attestationId} 不满足发布资格: ${reason}`);
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

/** 保留旧名称作为向后兼容别名。 */
export class RuntimePublicationPrerequisiteError extends RuntimeArtifactAttestationInvalidError {}

// ─── Attestation 证据快照与统一策略 ──────────────────────────

/**
 * Attestation 证据快照 — Store FOR UPDATE 读取的完整证据。
 *
 * 应用服务通过此快照调用 ArtifactEvidencePolicy，
 * 不在应用层复制 Attestation 判断逻辑。
 */
export interface RuntimePublicationEvidenceSnapshot {
  id: string;
  tenantId: string;
  artifactType: string;
  artifactRevisionId: string;
  artifactId: string;
  artifactDigest: string;
  verificationState: string;
  revokedAt: Date | null;
  revocationRecordId: string | null;
}

/**
 * Attestation 证据发布资格统一策略。
 *
 * 所有 Attestation 发布资格判断集中于此，
 * Store、Publication、Resolver 不得分别增加新的判断实现。
 */
export const ArtifactEvidencePolicy = {
  validateForRuntimePublication(
    snapshot: RuntimePublicationEvidenceSnapshot,
    revision: { id: string; tenantId: string; artifactDigest: string | null },
  ): void {
    if (snapshot.tenantId !== revision.tenantId) {
      throw new RuntimeArtifactAttestationInvalidError(
        revision.id,
        snapshot.id,
        `租户不一致（Attestation: ${snapshot.tenantId}, Revision: ${revision.tenantId}）`,
      );
    }
    if (snapshot.artifactType !== "runtime_revision") {
      throw new RuntimeArtifactAttestationInvalidError(
        revision.id,
        snapshot.id,
        `制品类型不是 runtime_revision（实际: ${snapshot.artifactType}）`,
      );
    }
    if (snapshot.artifactRevisionId !== revision.id) {
      throw new RuntimeArtifactAttestationInvalidError(
        revision.id,
        snapshot.id,
        `Attestation 绑定其他 Revision（${snapshot.artifactRevisionId}）`,
      );
    }
    if (snapshot.verificationState !== "verified") {
      throw new RuntimeArtifactAttestationInvalidError(
        revision.id,
        snapshot.id,
        `验证状态不是 verified（实际: ${snapshot.verificationState}）`,
      );
    }
    if (snapshot.revokedAt !== null) {
      throw new RuntimeArtifactAttestationInvalidError(
        revision.id,
        snapshot.id,
        "Attestation 已撤销",
      );
    }
    if (revision.artifactDigest !== null && snapshot.artifactDigest !== revision.artifactDigest) {
      throw new RuntimeArtifactAttestationInvalidError(
        revision.id,
        snapshot.id,
        `Artifact Digest 不一致（Attestation: ${snapshot.artifactDigest}, Revision: ${revision.artifactDigest}）`,
      );
    }
  },
} as const;
