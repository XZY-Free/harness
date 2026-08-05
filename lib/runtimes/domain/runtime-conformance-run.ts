import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ALL_CONFORMANCE_CASES,
  CONFORMANCE_SUITE_REVISION,
  type ConformanceCaseId,
} from "@/lib/runtimes/domain/runtime-conformance-contract";

export { ALL_CONFORMANCE_CASES, CONFORMANCE_SUITE_REVISION };
export type RuntimeConformanceCaseId = ConformanceCaseId;
export type RuntimeConformanceOverallResult = "passed" | "failed" | "error" | "cancelled";

export interface RuntimeConformanceReport {
  runId: string;
  runtimeRevisionId: string;
  runtimeArtifactDigest: string;
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
  }>;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function canonicalizeRuntimeConformanceReport(report: RuntimeConformanceReport): string {
  return JSON.stringify({
    ...report,
    caseResults: [...report.caseResults].sort((a, b) => a.caseId.localeCompare(b.caseId)),
  });
}

export function verifyRuntimeConformanceReportSignature(
  report: RuntimeConformanceReport,
  signature: string,
  secret: string,
): void {
  if (secret.length < 32) throw new RuntimeConformanceTrustError("Runner 签名密钥未安全配置");
  if (!/^[0-9a-f]{64}$/.test(signature))
    throw new RuntimeConformanceTrustError("Runner 签名格式非法");
  const expected = createHmac("sha256", secret)
    .update(canonicalizeRuntimeConformanceReport(report))
    .digest();
  const supplied = Buffer.from(signature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new RuntimeConformanceTrustError("Runner 报告签名校验失败");
  }
}

export function validateRuntimeConformanceReport(report: RuntimeConformanceReport): void {
  const digests = [
    report.runtimeArtifactDigest,
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
    caseIds.length !== ALL_CONFORMANCE_CASES.length ||
    new Set(caseIds).size !== ALL_CONFORMANCE_CASES.length ||
    ALL_CONFORMANCE_CASES.some((caseId) => !caseIds.includes(caseId))
  ) {
    throw new RuntimeConformanceTrustError(
      `Conformance 报告必须包含全部且唯一的 ${ALL_CONFORMANCE_CASES.length} 个 case`,
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
}

export function protocolContractRevision(protocolType: string): string {
  return protocolType === "a2a" ? "a2a@1" : "agent-runtime-protocol@1";
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
