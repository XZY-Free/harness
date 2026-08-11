import { describe, expect, it } from "vitest";
import { projectArtifactAttestation } from "./artifact-admin-projection";

describe("artifact admin projection", () => {
  it("投影服务端冻结的供应链与撤销事实", () => {
    expect(
      projectArtifactAttestation({
        id: "attestation-1",
        tenantId: "tenant-1",
        artifactId: "artifact-1",
        artifactType: "runtime_revision",
        artifactRevisionId: "revision-1",
        artifactDigest: `sha256:${"a".repeat(64)}`,
        dsseEnvelopeRef: "managed://envelopes/1",
        sbomRef: "managed://sbom/1",
        provenanceRef: "managed://provenance/1",
        builderIdentity: "builder-1",
        verificationState: "verified",
        policyRevisionId: "policy-1",
        sourceRevision: "git-sha-1",
        buildPipeline: "pipeline-1",
        dependencyLockFileHash: `sha256:${"b".repeat(64)}`,
        buildTime: new Date("2026-08-11T00:00:00.000Z"),
        scanSummaryJson: { critical: 0 },
        failureCode: null,
        verifiedAt: new Date("2026-08-11T00:01:00.000Z"),
        attestationFormat: "in_toto_dsse",
        statementType: "https://in-toto.io/Statement/v1",
        predicateType: "https://slsa.dev/provenance/v1",
        bundleDigest: `sha256:${"c".repeat(64)}`,
        subjectName: "runtime.tar",
        subjectDigest: `sha256:${"a".repeat(64)}`,
        verificationEngine: "snow-harness",
        verificationEngineVersion: "1",
        revokedAt: new Date("2026-08-11T00:02:00.000Z"),
        revokedBy: "security-1",
        revocationReason: "密钥泄漏",
        createdAt: new Date("2026-08-11T00:00:30.000Z"),
      }),
    ).toMatchObject({
      artifact_type: "runtime_revision",
      artifact_revision_id: "revision-1",
      verification_state: "verified",
      attestation_format: "in_toto_dsse",
      revoked_at: "2026-08-11T00:02:00.000Z",
      revocation_reason: "密钥泄漏",
    });
  });
});
