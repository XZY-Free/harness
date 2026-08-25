import { computeCanonicalDigest, rfc8785Canonicalize } from "@/lib/crypto/rfc-8785-canonicalize";
import {
  PUBLICATION_CONFORMANCE_CASES,
  PUBLICATION_CONFORMANCE_SUITE_REVISION,
  type PublicationConformanceCaseId,
} from "@/lib/runtime/domain/runtime-conformance-contract";

export { PUBLICATION_CONFORMANCE_CASES, PUBLICATION_CONFORMANCE_SUITE_REVISION };
export type RuntimeConformanceCaseId = PublicationConformanceCaseId;
export type RuntimeConformanceOverallResult = "passed" | "failed" | "error" | "cancelled";

export interface RuntimeConformanceReport {
  runId: string;
  runtimeRevisionId: string;
  runtimeTargetDigest: string;
  runtimeConfigDigest: string;
  protocolContractRevision: string;
  suiteRevision: string;
  runnerArtifactDigest: string;
  runnerIdentity: string;
  testEnvironmentRevision: string;
  startedAt: string;
  completedAt: string;
  overallResult: RuntimeConformanceOverallResult;
  evidenceManifestDigest: string;
  caseResults: Array<{
    caseId: RuntimeConformanceCaseId;
    passed: boolean;
    reason: string | null;
    evidenceDigest: string;
    /** 结构化真实证据对象（RFC8785-canonical-digestable），evidenceDigest 为其 canonical digest。 */
    evidence: Record<string, unknown>;
  }>;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * 计算单个 case 证据的权威 digest。
 *
 * 唯一事实源：evidence 对象的 RFC8785 canonical digest。runner / helper /
 * build-test-report / validator 全部复用本函数，禁止各自用任意 digest 占位。
 */
export function computeCaseEvidenceDigest(evidence: Record<string, unknown>): string {
  return computeCanonicalDigest(evidence);
}

/**
 * 计算 evidenceManifestDigest 的权威函数。
 *
 * Manifest canonical 绑定 suiteRevision、testEnvironmentRevision、runtimeRevisionId、
 * runtimeTargetDigest、runtimeConfigDigest、protocolContractRevision、
 * runnerArtifactDigest 与按 caseId 升序的 (caseId, passed, evidenceDigest)。
 * runner / helper / validator 全部复用本函数。
 */
export function computeEvidenceManifestDigest(params: {
  suiteRevision: string;
  testEnvironmentRevision: string;
  runtimeRevisionId: string;
  runtimeTargetDigest: string;
  runtimeConfigDigest: string;
  protocolContractRevision: string;
  runnerArtifactDigest: string;
  cases: Array<{ caseId: string; passed: boolean; evidenceDigest: string }>;
}): string {
  const manifest = {
    suiteRevision: params.suiteRevision,
    testEnvironmentRevision: params.testEnvironmentRevision,
    runtimeRevisionId: params.runtimeRevisionId,
    runtimeTargetDigest: params.runtimeTargetDigest,
    runtimeConfigDigest: params.runtimeConfigDigest,
    protocolContractRevision: params.protocolContractRevision,
    runnerArtifactDigest: params.runnerArtifactDigest,
    cases: [...params.cases].sort((a, b) => a.caseId.localeCompare(b.caseId)),
  };
  return computeCanonicalDigest(manifest);
}

export function canonicalizeRuntimeConformanceReport(report: RuntimeConformanceReport): string {
  return rfc8785Canonicalize({
    ...report,
    caseResults: [...report.caseResults].sort((a, b) => a.caseId.localeCompare(b.caseId)),
  });
}

export function validateRuntimeConformanceReport(report: RuntimeConformanceReport): void {
  const digests = [
    report.runtimeTargetDigest,
    report.runtimeConfigDigest,
    report.runnerArtifactDigest,
    report.evidenceManifestDigest,
    ...report.caseResults.map((result) => result.evidenceDigest),
  ];
  if (digests.some((digest) => !SHA256.test(digest))) {
    throw new RuntimeConformanceTrustError("Conformance 报告包含非法 sha256 digest");
  }
  const caseIds = report.caseResults.map((result) => result.caseId);
  if (
    caseIds.length !== PUBLICATION_CONFORMANCE_CASES.length ||
    new Set(caseIds).size !== PUBLICATION_CONFORMANCE_CASES.length ||
    PUBLICATION_CONFORMANCE_CASES.some((caseId) => !caseIds.includes(caseId))
  ) {
    throw new RuntimeConformanceTrustError(
      `Publication Conformance 报告必须包含全部且唯一的 ${PUBLICATION_CONFORMANCE_CASES.length} 个 case`,
    );
  }
  const startedAt = new Date(report.startedAt);
  const completedAt = new Date(report.completedAt);
  if (
    !Number.isFinite(startedAt.getTime()) ||
    !Number.isFinite(completedAt.getTime()) ||
    completedAt < startedAt
  ) {
    throw new RuntimeConformanceTrustError("Conformance Run 时间范围非法");
  }
  const allPassed = report.caseResults.every((result) => result.passed);
  if ((report.overallResult === "passed") !== allPassed) {
    throw new RuntimeConformanceTrustError("overallResult 与 case 结果不一致");
  }

  // 逐 case 证据自洽校验：evidence 必须是非空 JSON 对象，且 evidence.caseId /
  // evidence.passed / recomputed evidenceDigest 必须与 case 声明一致。
  for (const result of report.caseResults) {
    const evidence = result.evidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      throw new RuntimeConformanceTrustError("case evidence 必须是非空 JSON 对象");
    }
    if (evidence.caseId !== result.caseId) {
      throw new RuntimeConformanceTrustError("case evidence.caseId 与 caseId 不一致");
    }
    if (evidence.passed !== result.passed) {
      throw new RuntimeConformanceTrustError("case evidence.passed 与 passed 不一致");
    }
    if (computeCaseEvidenceDigest(evidence) !== result.evidenceDigest) {
      throw new RuntimeConformanceTrustError(
        "case evidenceDigest 与 evidence canonical digest 不一致",
      );
    }
  }

  // evidenceManifestDigest 必须 canonical 绑定报告内容。
  if (
    computeEvidenceManifestDigest({
      suiteRevision: report.suiteRevision,
      testEnvironmentRevision: report.testEnvironmentRevision,
      runtimeRevisionId: report.runtimeRevisionId,
      runtimeTargetDigest: report.runtimeTargetDigest,
      runtimeConfigDigest: report.runtimeConfigDigest,
      protocolContractRevision: report.protocolContractRevision,
      runnerArtifactDigest: report.runnerArtifactDigest,
      cases: report.caseResults.map((result) => ({
        caseId: result.caseId,
        passed: result.passed,
        evidenceDigest: result.evidenceDigest,
      })),
    }) !== report.evidenceManifestDigest
  ) {
    throw new RuntimeConformanceTrustError(
      "evidenceManifestDigest 与报告内容 canonical digest 不一致",
    );
  }
}

export class RuntimeConformanceTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConformanceTrustError";
  }
}

export class RuntimeConformanceBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConformanceBindingError";
  }
}
