import type { ArtifactEvidenceSnapshot } from "@/lib/artifacts/domain/artifact-evidence";
import type { PublicationConformanceCaseResult } from "@/lib/runtime/domain/runtime-conformance-contract";
import type { RuntimeRevisionPublicationState } from "@/lib/runtime/domain/runtime-revision-publication-policy";

export type RuntimePublicationActorType = "user" | "service" | "workload" | "system";

export interface RuntimePublicationRevision {
  id: string;
  tenantId: string;
  runtimeId: string;
  revisionNo: number;
  revisionState: RuntimeRevisionPublicationState;
  /** 证据种类（ 语义字段，不允许 nullable 组合猜测）。 */
  runtimeEvidenceKind: "hosted_artifact" | "external_endpoint";
  /** 被测对象统一 digest。 */
  runtimeTargetDigest: string;
  runtimeArtifactRef: string | null;
  artifactId: string | null;
  artifactDigest: string | null;
  configHash: string;
  protocolContractRevision: string;
  publishedAt: Date | null;
}

export interface RuntimePublicationRuntime {
  id: string;
  tenantId: string;
  versionNo: number;
}

/**
 * Attestation 证据快照 — Store 读取后交给 ArtifactEvidencePolicy 统一验证。
 *
 * 替代旧 RuntimePublicationAttestation（仅含 id + artifactDigest），
 * 使应用服务无需复制 Attestation 判断逻辑。
 */
export type RuntimePublicationAttestation = ArtifactEvidenceSnapshot;

export interface StoredRuntimeConformanceResult {
  caseId: PublicationConformanceCaseResult["caseId"];
  passed: boolean;
  reason: string | null;
  adapterDigest: string | null;
  testEnvironment: string | null;
  evidenceRef: string | null;
  testedAt: Date;
}

/**
 * ConformanceRun 完整结果 — 包含绑定校验所需字段。
 */
export interface RuntimePublicationConformanceRun {
  id: string;
  runtimeTargetDigest: string;
  runtimeConfigDigest: string;
  protocolContractRevision: string;
  evidenceManifestDigest: string;
  results: StoredRuntimeConformanceResult[];
}

export interface RuntimePublicationSession {
  findRevision(tenantId: string, revisionId: string): Promise<RuntimePublicationRevision | null>;
  findRuntime(tenantId: string, runtimeId: string): Promise<RuntimePublicationRuntime | null>;
  /**
   * FOR UPDATE 读取 Attestation 证据快照。
   *
   * 返回完整 ArtifactEvidenceSnapshot（含 artifactType、artifactRevisionId、
   * verificationState、revokedAt、revocationRecordId），由 ArtifactEvidencePolicy 统一验证。
   */
  findVerifiedAttestation(params: {
    tenantId: string;
    revisionId: string;
    attestationId: string;
  }): Promise<ArtifactEvidenceSnapshot | null>;
  /**
   * FOR UPDATE 读取 Passed ConformanceRun 完整结果。
   *
   * 返回包含绑定校验字段（runtimeTargetDigest、configDigest、protocolContractRevision）
   * 的完整 Run 数据，由应用服务校验与 Revision 绑定一致。
   */
  findPassedConformanceRun(params: {
    tenantId: string;
    revisionId: string;
    conformanceRunId: string;
  }): Promise<RuntimePublicationConformanceRun | null>;
  appendPublication(params: {
    id: string;
    tenantId: string;
    revisionId: string;
    evidenceSetDigest: string;
    attestationIds: string[];
    publishedByType: RuntimePublicationActorType;
    publishedBy: string;
    publishedAt: Date;
    idempotencyKey: string;
    idempotencyRecordId: string | null;
    conformanceRunId: string;
  }): Promise<void>;
  markRevisionPublished(revisionId: string, publishedAt: Date): Promise<boolean>;
  setRuntimeCurrentRevision(params: {
    tenantId: string;
    runtimeId: string;
    revisionId: string;
    expectedVersionNo: number;
    updatedAt: Date;
    /** 发布原子启用：draft Runtime 首次发布时 draft→enabled（7f0d696 同一模式）。 */
    enableIfDraft?: boolean;
  }): Promise<boolean>;
  appendAudit(params: {
    id: string;
    tenantId: string;
    actorType: RuntimePublicationActorType;
    actorId: string;
    revisionId: string;
    after: unknown;
    reason: string;
    requestId: string;
    occurredAt: Date;
  }): Promise<void>;
  appendOutbox(params: {
    id: string;
    tenantId: string;
    eventKey: string;
    /** 事件类型 — 必须来自合同，aggregateType 由合同推导。 */
    eventType: "runtime.revision.published";
    aggregateId: string;
    /** 聚合版本号。 */
    aggregateVersion: number;
    payload: Record<string, unknown>;
    occurredAt: Date;
  }): Promise<void>;
  completeIdempotency(params: {
    recordId: string;
    httpStatus: number;
    responseRef: string | null;
    responseRedactedJson: string;
    completedAt: Date;
  }): Promise<boolean>;
}

export interface RuntimePublicationStore {
  transaction<T>(operation: (session: RuntimePublicationSession) => Promise<T>): Promise<T>;
}
