/**
 * Fake Runtime Conformance Verifier — 测试专用。
 *
 * §4.8: 直接返回 verified=true 和从输入构造的 claims 对象。
 * 仅用于纯单元测试，真实集成和端到端测试禁止使用。
 *
 * 生产代码禁止引用此模块。
 */

import { createHash } from "node:crypto";
import {
  ALL_CONFORMANCE_CASES,
  CONFORMANCE_SUITE_REVISION,
} from "@/lib/runtimes/domain/runtime-conformance-contract";
import type { RuntimeConformanceReport } from "@/lib/runtimes/domain/runtime-conformance-run";
import {
  RUNTIME_CONFORMANCE_PREDICATE_TYPE,
  type RuntimeConformanceVerifier,
  type VerifyConformanceInput,
  type VerifyConformanceResult,
} from "@/lib/runtimes/verification/runtime-conformance-verifier";

export function createFakeRuntimeConformanceVerifier(
  reportOverride?: Partial<RuntimeConformanceReport>,
): RuntimeConformanceVerifier {
  return {
    verify: async (input: VerifyConformanceInput): Promise<VerifyConformanceResult> => {
      const envelopeDigest = `sha256:${createHash("sha256").update(input.dsseEnvelopeBytes).digest("hex")}`;
      const report: RuntimeConformanceReport = {
        runId: "fake-run-id",
        runtimeRevisionId: input.expectedRuntimeRevisionId,
        runtimeArtifactDigest: input.expectedRuntimeArtifactDigest ?? `sha256:${"a".repeat(64)}`,
        runtimeConfigDigest: input.expectedRuntimeConfigDigest ?? `sha256:${"b".repeat(64)}`,
        protocolContractRevision: input.expectedProtocolContractRevision ?? "agent-runtime-protocol@1",
        suiteRevision: CONFORMANCE_SUITE_REVISION,
        runnerArtifactDigest: `sha256:${"f".repeat(64)}`,
        runnerIdentity: "fake-runner",
        testEnvironmentRevision: "fake-env@1",
        startedAt: new Date("2026-08-02T01:00:00.000Z").toISOString(),
        completedAt: new Date("2026-08-02T01:00:01.000Z").toISOString(),
        overallResult: "passed",
        evidenceManifestDigest: `sha256:${"e".repeat(64)}`,
        caseResults: ALL_CONFORMANCE_CASES.map((caseId, index) => ({
          caseId,
          passed: true,
          reason: null,
          evidenceDigest: `sha256:${index.toString(16).padStart(64, "0")}`,
        })),
        ...reportOverride,
      };
      return {
        verified: true,
        claims: {
          verified: true,
          envelopeDigest,
          payloadDigest: `sha256:${"p".repeat(64)}`,
          signingKeyId: "fake-key",
          runnerIdentity: "fake-runner",
          predicateType: RUNTIME_CONFORMANCE_PREDICATE_TYPE,
          verificationEngine: "fake",
          verificationEngineVersion: "test",
          report,
        },
      };
    },
  };
}
