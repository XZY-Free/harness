import { computeCanonicalDigest, rfc8785Canonicalize } from "@/lib/crypto/rfc-8785-canonicalize";
import {
  PUBLICATION_BEHAVIOR_RECEIPT_KEYS,
  PUBLICATION_CONFORMANCE_CASES,
  PUBLICATION_CONFORMANCE_SUITE_REVISION,
  PUBLICATION_DECLARATION_CASE_IDS,
  type PublicationConformanceCaseId,
  type PublicationDeclarationCaseId,
} from "@/lib/runtime/domain/runtime-conformance-contract";
import {
  isRuntimeProtocolConformanceCase,
  validateRuntimeProtocolConformanceEvidence,
} from "@/lib/runtime/protocol-conformance";

export { PUBLICATION_CONFORMANCE_CASES, PUBLICATION_CONFORMANCE_SUITE_REVISION };

/**
 * 声明式用例必须携带的真实回执键。
 *
 * 「只有 boolean evidence 的材料不接受」：声明式 case 的回执同样必须绑定真实
 * Adapter 返回的关键字段，而不是把 `passed` 再抄一遍。
 */
const DECLARATION_RECEIPT_KEYS: Record<PublicationDeclarationCaseId, string[]> = {
  "capability-manifest-contract": ["protocolVersion", "features", "limits"],
  "dispatch-acknowledgement": ["response", "authorityMatches"],
  "cancel-acknowledgement": ["response"],
  "steer-capability-consistency": ["declared"],
  "resume-capability-consistency": ["declared"],
  "session-recovery-declaration": ["declared"],
};

/** 逐 case 的全部必需回执键（声明式 + 行为），单一权威。 */
export const PUBLICATION_CONFORMANCE_RECEIPT_KEYS: Record<
  PublicationConformanceCaseId,
  readonly string[]
> = {
  ...DECLARATION_RECEIPT_KEYS,
  ...PUBLICATION_BEHAVIOR_RECEIPT_KEYS,
};

export type RuntimeConformanceCaseId = PublicationConformanceCaseId;
export type RuntimeConformanceOverallResult = "passed" | "failed" | "error" | "cancelled";

export interface RuntimeConformanceReport {
  runId: string;
  runtimeRevisionId: string;
  runtimeTargetDigest: string;
  runtimeConfigDigest: string;
  protocolContractDigest: string;
  suiteRevision: string;
  runnerArtifactDigest: string;
  runnerIdentity: string;
  testEnvironmentRevision: string;
  startedAt: string;
  completedAt: string;
  overallResult: RuntimeConformanceOverallResult;
  evidenceManifestDigest: string;
  /**
   * 03 专项：Probe Context 审计摘要（只记录 kind，不记录 subject_id/datetime/attachment 等
   * 具体 Context value；成功时 unavailable_required 恒空）。可选：兼容既有历史报告。
   */
  probe_context_kinds?: {
    supplied: string[];
    omitted_preferred: string[];
    unavailable_required: string[];
  };
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
 * runtimeTargetDigest、runtimeConfigDigest、protocolContractDigest、
 * runnerArtifactDigest 与按 caseId 升序的 (caseId, passed, evidenceDigest)。
 * runner / helper / validator 全部复用本函数。
 */
export function computeEvidenceManifestDigest(params: {
  suiteRevision: string;
  testEnvironmentRevision: string;
  runtimeRevisionId: string;
  runtimeTargetDigest: string;
  runtimeConfigDigest: string;
  protocolContractDigest: string;
  runnerArtifactDigest: string;
  cases: Array<{ caseId: string; passed: boolean; evidenceDigest: string }>;
}): string {
  const manifest = {
    suiteRevision: params.suiteRevision,
    testEnvironmentRevision: params.testEnvironmentRevision,
    runtimeRevisionId: params.runtimeRevisionId,
    runtimeTargetDigest: params.runtimeTargetDigest,
    runtimeConfigDigest: params.runtimeConfigDigest,
    protocolContractDigest: params.protocolContractDigest,
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
    // R10 §3：只有 boolean evidence、无实际调用回执的材料不接受。
    // 只对**声明通过**的 case 强制回执：失败 case 由 overallResult 一致性单独拦下。
    if (!result.passed) continue;
    const requiredKeys = PUBLICATION_CONFORMANCE_RECEIPT_KEYS[result.caseId];
    if (!requiredKeys) {
      throw new RuntimeConformanceTrustError(`case ${result.caseId} 未声明回执要求`);
    }
    for (const key of requiredKeys) {
      const value = evidence[key];
      if (value === undefined || value === null) {
        throw new RuntimeConformanceTrustError(
          `case ${result.caseId} 缺少真实调用回执字段：${key}`,
        );
      }
    }
  }

  // RuntimeProtocol 行为清单（R10 §3）必须同时自洽：行为 case 恰出现一次、全部通过、
  // 且逐 case 携带真实调用回执。声明式 6 条不能替代它 —— 这正是「旧 case 全集与新协议
  // required behavior 清单脱节」的闭合点。
  validateRuntimeProtocolConformanceEvidence(
    report.caseResults.flatMap((result) =>
      isRuntimeProtocolConformanceCase(result.caseId)
        ? [{ caseId: result.caseId, passed: result.passed, receipt: result.evidence }]
        : [],
    ),
  );

  // evidenceManifestDigest 必须 canonical 绑定报告内容。
  if (
    computeEvidenceManifestDigest({
      suiteRevision: report.suiteRevision,
      testEnvironmentRevision: report.testEnvironmentRevision,
      runtimeRevisionId: report.runtimeRevisionId,
      runtimeTargetDigest: report.runtimeTargetDigest,
      runtimeConfigDigest: report.runtimeConfigDigest,
      protocolContractDigest: report.protocolContractDigest,
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
