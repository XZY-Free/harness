import { createHash } from "node:crypto";
import type {
 BuilderKeyRegistry,
 ManagedArtifactStore,
 ProvenanceDocument,
} from "@/lib/artifacts/domain/artifact-attestation";
import {
 buildDsseArtifactAttestationEnvelope,
 generateTestBuilderKey,
 type TestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import {
 type HostedControlPlaneEvidenceProvider,
 resetHostedControlPlaneEvidenceProvider,
 setHostedControlPlaneEvidenceProvider,
} from "@/lib/runtime/domain/hosted-control-plane-evidence";
import { ALL_CONFORMANCE_CASES } from "@/lib/runtime/domain/runtime-conformance-contract";
import { CONFORMANCE_SUITE_REVISION } from "@/lib/runtime/domain/runtime-conformance-contract";
import {
 buildDsseConformanceEnvelope,
 generateTestRunnerKey,
} from "@/lib/runtime/test-support/build-dsse-conformance-envelope";
import type { RunnerSigningIdentity } from "@/lib/runtime/domain/runner-signing-identity";

const TRUSTED_RUNNER_KEY = generateTestRunnerKey("hosted-control-plane-runner");
const RUNNER_IDENTITY = "ci/hosted-runtime-conformance";
const BUILDER_IDENTITY = "builder:snow-harness-hosted-release";

export function trustedHostedRunnerSigningIdentityForTest(
 tenantId: string,
): RunnerSigningIdentity {
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
 corruptArtifactSignatureFor?: "agent_revision" | "runtime_revision";
 delaySecondAgentEvidenceMs?: number;
}): () => void {
 setHostedControlPlaneEvidenceProvider(createEvidenceProvider(options));
 return () => {
 resetHostedControlPlaneEvidenceProvider();
 };
}

function createEvidenceProvider(options?: {
 failRuntimeConformanceAttempts?: number;
 corruptArtifactSignatureFor?: "agent_revision" | "runtime_revision";
 delaySecondAgentEvidenceMs?: number;
}): HostedControlPlaneEvidenceProvider {
 const store = new TestManagedArtifactStore();
 const builderKey: TestBuilderKey = generateTestBuilderKey(BUILDER_IDENTITY);
 const builderKeys: BuilderKeyRegistry = {
 [BUILDER_IDENTITY]: builderKey.publicKeyBase64,
 };
 let remainingConformanceFailures = options?.failRuntimeConformanceAttempts ?? 0;
 let agentEvidenceCalls = 0;

 return {
 async loadArtifactEvidence({ artifactType }) {
 if (artifactType === "agent_revision") {
 agentEvidenceCalls += 1;
 if (agentEvidenceCalls === 2 && options?.delaySecondAgentEvidenceMs) {
 await new Promise((resolve) => setTimeout(resolve, options.delaySecondAgentEvidenceMs));
 }
 }
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
 metadata: { component: { type: "application", name: "snow-harness", version: "release-1" } },
 components: [
 { type: "library", name: "snow-harness", version: "release-1", licenses: [{ license: { id: "MIT" } }] },
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
 metadata: { component: { type: "application", name: "snow-harness", version: "release-1" } },
 components: [
 { type: "library", name: "snow-harness", version: "release-1", licenses: [{ license: { id: "MIT" } }] },
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
 if (remainingConformanceFailures > 0) {
 remainingConformanceFailures -= 1;
 throw new Error("可信 Hosted Conformance Runner 暂时不可用");
 }
 const runId = deterministicUuid(input.idempotencyKey);
 const report = {
 runId,
 runtimeRevisionId: input.runtimeRevisionId,
 runtimeArtifactDigest: input.runtimeArtifactDigest,
 runtimeConfigDigest: input.runtimeConfigDigest,
 protocolContractRevision: input.protocolContractRevision,
 suiteRevision: CONFORMANCE_SUITE_REVISION,
 runnerArtifactDigest: digest("snow-harness:isolated-hosted-runner:release-1"),
 runnerIdentity: RUNNER_IDENTITY,
 testEnvironmentRevision: "isolated-mysql8@1",
 startedAt: "2026-08-03T00:01:00.000Z",
 completedAt: "2026-08-03T00:01:01.000Z",
 overallResult: "passed" as const,
 evidenceManifestDigest: digest(`hosted-evidence:${input.runtimeRevisionId}`),
 caseResults: ALL_CONFORMANCE_CASES.map((caseId) => ({
 caseId,
 passed: true,
 reason: null,
 evidenceDigest: digest(`${input.runtimeRevisionId}:${caseId}`),
 })),
 };
 const dsseEnvelope = buildDsseConformanceEnvelope(report, TRUSTED_RUNNER_KEY);
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
