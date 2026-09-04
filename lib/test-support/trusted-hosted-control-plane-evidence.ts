import { createHash } from "node:crypto";
import type {
  BuilderKeyRegistry,
  ManagedArtifactStore,
  ProvenanceDocument,
} from "@/lib/artifacts/domain/artifact-attestation";
import {
  type TestBuilderKey,
  buildDsseArtifactAttestationEnvelope,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { createHostedAdapter } from "@/lib/runtime/adapters/hosted-adapter";
import {
  type HostedControlPlaneEvidenceProvider,
  resetHostedControlPlaneEvidenceProvider,
  setHostedControlPlaneEvidenceProvider,
} from "@/lib/runtime/domain/hosted-control-plane-evidence";
import type { RunnerSigningIdentity } from "@/lib/runtime/domain/runner-signing-identity";
import { PUBLICATION_CONFORMANCE_SUITE_REVISION } from "@/lib/runtime/domain/runtime-conformance-contract";
import { computeEvidenceManifestDigest } from "@/lib/runtime/domain/runtime-conformance-run";
import { createDirectResponsePorts } from "@/lib/runtime/harness-loop/test-ports";
import { runPublicationConformanceSuite } from "@/lib/runtime/runtime-conformance-runner";
import {
  buildDsseConformanceEnvelope,
  generateTestRunnerKey,
} from "@/lib/runtime/test-support/build-dsse-conformance-envelope";
import { createCapturingEventBatchSink } from "@/lib/runtime/test-support/capturing-event-batch-sink";
import { createConformanceHostedApplicationService } from "@/lib/runtime/test-support/conformance-hosted-application-service";
import { computeRunnerArtifactDigest } from "@/lib/test-support/publish-runtime-revision-for-test";

const TRUSTED_RUNNER_KEY = generateTestRunnerKey("hosted-control-plane-runner");
const RUNNER_IDENTITY = "ci/hosted-runtime-conformance";
/** 实际执行环境：in-process Hosted Adapter（真实 suite 运行环境）。 */
const TEST_ENVIRONMENT_REVISION = "in-process-hosted-adapter@1";
const BUILDER_IDENTITY = "builder:snow-harness-hosted-release";

export function trustedHostedRunnerSigningIdentityForTest(tenantId: string): RunnerSigningIdentity {
  return {
    keyId: TRUSTED_RUNNER_KEY.keyid,
    publicKey: TRUSTED_RUNNER_KEY.publicKeyBase64,
    runnerIdentity: RUNNER_IDENTITY,
    tenantScope: tenantId,
    validFrom: "2020-01-01T00:00:00.000Z",
    validUntil: null,
    revokedAt: null,
  };
}

class TestManagedArtifactStore implements ManagedArtifactStore {
  readonly envelopes = new Map<string, Buffer>();
  readonly sboms = new Map<string, unknown>();
  readonly provenances = new Map<string, ProvenanceDocument>();

  async readDsseEnvelope(ref: string): Promise<Buffer> {
    const value = this.envelopes.get(ref);
    if (!value) throw new Error(`DSSE envelope not found: ${ref}`);
    return value;
  }

  async readSbom(ref: string) {
    const value = this.sboms.get(ref);
    if (!value) throw new Error(`sbom not found: ${ref}`);
    return value;
  }

  async readProvenance(ref: string) {
    const value = this.provenances.get(ref);
    if (!value) throw new Error(`provenance not found: ${ref}`);
    return value;
  }
}

export function installTrustedHostedControlPlaneEvidenceForTest(options?: {
  failRuntimeConformanceAttempts?: number;
  corruptArtifactSignatureFor?: "runtime_revision";
}): () => void {
  setHostedControlPlaneEvidenceProvider(createEvidenceProvider(options));
  return () => {
    resetHostedControlPlaneEvidenceProvider();
  };
}

function createEvidenceProvider(options?: {
  failRuntimeConformanceAttempts?: number;
  corruptArtifactSignatureFor?: "runtime_revision";
}): HostedControlPlaneEvidenceProvider {
  const store = new TestManagedArtifactStore();
  const builderKey: TestBuilderKey = generateTestBuilderKey(BUILDER_IDENTITY);
  const builderKeys: BuilderKeyRegistry = {
    [BUILDER_IDENTITY]: builderKey.publicKeyBase64,
  };
  let remainingConformanceFailures = options?.failRuntimeConformanceAttempts ?? 0;
  /** 幂等缓存：idempotencyKey → 已执行并签名的 DSSE Envelope。 */
  const conformanceCache = new Map<string, string>();

  return {
    async loadArtifactEvidence({ artifactType }) {
      const artifactDigest = digest(`snow-harness:${artifactType}:release-1`);
      const prefix = `managed://snow-harness/${artifactType}/release-1`;
      const dsseEnvelopeRef = `${prefix}/dsse-envelope`;
      const sbomRef = `${prefix}/sbom`;
      const provenanceRef = `${prefix}/provenance`;
      store.envelopes.set(
        dsseEnvelopeRef,
        buildDsseArtifactAttestationEnvelope(
          builderKey,
          artifactDigest,
          {
            sbomRef,
            sbomContent: {
              bomFormat: "CycloneDX",
              specVersion: "1.6",
              version: 1,
              metadata: {
                component: { type: "application", name: "snow-harness", version: "release-1" },
              },
              components: [
                {
                  type: "library",
                  name: "snow-harness",
                  version: "release-1",
                  licenses: [{ license: { id: "MIT" } }],
                },
              ],
            },
            provenanceRef,
            provenanceContent: {
              sourceRevision: "git:hosted-release-1",
              buildPipeline: "ci/hosted-release",
              dependencyLockFile: "pnpm-lock.yaml:sha256:hosted-release-1",
              buildTime: "2026-08-03T00:00:00.000Z",
            },
          },
          {
            tamperSignature: options?.corruptArtifactSignatureFor === artifactType,
          },
        ),
      );
      store.sboms.set(sbomRef, {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: {
          component: { type: "application", name: "snow-harness", version: "release-1" },
        },
        components: [
          {
            type: "library",
            name: "snow-harness",
            version: "release-1",
            licenses: [{ license: { id: "MIT" } }],
          },
        ],
      });
      store.provenances.set(provenanceRef, {
        sourceRevision: "git:hosted-release-1",
        buildPipeline: "ci/hosted-release",
        dependencyLockFile: "pnpm-lock.yaml:sha256:hosted-release-1",
        buildTime: "2026-08-03T00:00:00.000Z",
      });
      return {
        artifactDigest,
        artifactRef: `managed://snow-harness/${artifactType}@${artifactDigest}`,
        dsseEnvelopeRef,
        sbomRef,
        provenanceRef,
        builderIdentity: BUILDER_IDENTITY,
        managedStore: store,
        builderKeys,
      };
    },
    async runRuntimeConformance(input) {
      // 幂等：同一 idempotencyKey 重试返回同一个已执行并签名的 DSSE，不重复跑 suite。
      const cached = conformanceCache.get(input.idempotencyKey);
      if (cached) {
        return { dsseEnvelope: cached };
      }
      if (remainingConformanceFailures > 0) {
        remainingConformanceFailures -= 1;
        throw new Error("可信 Hosted Conformance Runner 暂时不可用");
      }

      // 真实执行：创建真实 Hosted Adapter，跑正式 Publication runner，证据全部来自真实调用。
      // 注入进程内捕获型 EventBatchSink：接收并保留真实候选事件，不黑洞、不伪造 ack。
      const startedAt = new Date();
      const capturing = createCapturingEventBatchSink();
      const adapter = createHostedAdapter({
        platformEndpoint: "in-process://hosted-conformance-test",
        platformAuthToken: "conformance-test-token",
        eventBatchSink: capturing.sink,
        applicationService: createConformanceHostedApplicationService({
          eventBatchSink: capturing.sink,
        }),
        ...createDirectResponsePorts(async (view) => `conformance probe reply: ${view.objective}`),
        modelRef: "conformance-test-model",
      });
      const caseResults = await runPublicationConformanceSuite({
        tenantId: input.tenantId,
        runtimeRevisionId: input.runtimeRevisionId,
        runtimeAdapter: adapter,
      });

      const runnerArtifactDigest = await computeRunnerArtifactDigest();
      const allPassed = caseResults.every((result) => result.passed);
      const runId = deterministicUuid(input.idempotencyKey);
      const report = {
        runId,
        runtimeRevisionId: input.runtimeRevisionId,
        runtimeTargetDigest: input.runtimeTargetDigest,
        runtimeConfigDigest: input.runtimeConfigDigest,
        protocolContractRevision: input.protocolContractRevision,
        suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
        runnerArtifactDigest,
        runnerIdentity: RUNNER_IDENTITY,
        testEnvironmentRevision: TEST_ENVIRONMENT_REVISION,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        overallResult: allPassed ? ("passed" as const) : ("failed" as const),
        evidenceManifestDigest: computeEvidenceManifestDigest({
          suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
          testEnvironmentRevision: TEST_ENVIRONMENT_REVISION,
          runtimeRevisionId: input.runtimeRevisionId,
          runtimeTargetDigest: input.runtimeTargetDigest,
          runtimeConfigDigest: input.runtimeConfigDigest,
          protocolContractRevision: input.protocolContractRevision,
          runnerArtifactDigest,
          cases: caseResults.map((result) => ({
            caseId: result.caseId,
            passed: result.passed,
            evidenceDigest: result.evidenceDigest,
          })),
        }),
        caseResults: caseResults.map((result) => ({
          caseId: result.caseId,
          passed: result.passed,
          reason: result.passed ? null : (result.reason ?? null),
          evidenceDigest: result.evidenceDigest,
          evidence: result.evidence,
        })),
      };
      const dsseEnvelope = buildDsseConformanceEnvelope(report, TRUSTED_RUNNER_KEY);
      conformanceCache.set(input.idempotencyKey, dsseEnvelope);
      return { dsseEnvelope };
    },
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex
    .slice(12, 16)
    .join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}
