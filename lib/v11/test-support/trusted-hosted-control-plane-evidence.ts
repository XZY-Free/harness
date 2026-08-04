import { type KeyObject, createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import type {
  BuilderKeyRegistry,
  ManagedArtifactStore,
  ProvenanceDocument,
  SbomDocument,
  SignatureBundle,
} from "@/lib/artifacts/domain/artifact-attestation";
import {
  type HostedControlPlaneEvidenceProvider,
  resetHostedControlPlaneEvidenceProvider,
  setHostedControlPlaneEvidenceProvider,
} from "@/lib/runtimes/domain/hosted-control-plane-evidence";
import {
  ALL_CONFORMANCE_CASES,
  canonicalizeRuntimeConformanceReport,
} from "@/lib/runtimes/domain/runtime-conformance-run";

const CONFORMANCE_SECRET = "hosted-control-plane-test-secret-32-bytes";

class TestManagedArtifactStore implements ManagedArtifactStore {
  readonly signatures = new Map<string, SignatureBundle>();
  readonly sboms = new Map<string, SbomDocument>();
  readonly provenances = new Map<string, ProvenanceDocument>();

  async readSignatureBundle(ref: string) {
    const value = this.signatures.get(ref);
    if (!value) throw new Error(`signature bundle not found: ${ref}`);
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
  const originalSecret = process.env.SNOW_RUNTIME_CONFORMANCE_SIGNING_SECRET;
  process.env.SNOW_RUNTIME_CONFORMANCE_SIGNING_SECRET = CONFORMANCE_SECRET;
  setHostedControlPlaneEvidenceProvider(createEvidenceProvider(options));
  return () => {
    resetHostedControlPlaneEvidenceProvider();
    process.env.SNOW_RUNTIME_CONFORMANCE_SIGNING_SECRET = originalSecret;
  };
}

function createEvidenceProvider(options?: {
  failRuntimeConformanceAttempts?: number;
  corruptArtifactSignatureFor?: "agent_revision" | "runtime_revision";
  delaySecondAgentEvidenceMs?: number;
}): HostedControlPlaneEvidenceProvider {
  const store = new TestManagedArtifactStore();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const builderIdentity = "builder:snow-harness-hosted-release";
  const builderKeys: BuilderKeyRegistry = { [builderIdentity]: rawPublicKey(publicKey) };
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
      const signatureBundleRef = `${prefix}/signature`;
      const sbomRef = `${prefix}/sbom`;
      const provenanceRef = `${prefix}/provenance`;
      store.signatures.set(signatureBundleRef, {
        algorithm: "ed25519",
        publicKey: builderKeys[builderIdentity] as string,
        signature: sign(
          null,
          Buffer.from(
            options?.corruptArtifactSignatureFor === artifactType
              ? `${artifactDigest}:corrupted`
              : artifactDigest,
          ),
          privateKey,
        ).toString("base64"),
      });
      store.sboms.set(sbomRef, {
        packages: [
          { name: "snow-harness", version: "release-1", licenses: ["MIT"], vulnerabilities: [] },
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
        signatureBundleRef,
        sbomRef,
        provenanceRef,
        builderIdentity,
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
        suiteRevision: "runtime-conformance@1",
        runnerArtifactDigest: digest("snow-harness:isolated-hosted-runner:release-1"),
        runnerIdentity: "ci/hosted-runtime-conformance",
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
      return {
        report,
        signature: createHmac("sha256", CONFORMANCE_SECRET)
          .update(canonicalizeRuntimeConformanceReport(report))
          .digest("hex"),
      };
    },
  };
}

function rawPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64");
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
