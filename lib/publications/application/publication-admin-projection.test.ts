import { describe, expect, it } from "vitest";
import { projectPublicationRecord, projectWithdrawalRecord } from "./publication-admin-projection";

describe("publication admin projection", () => {
  it("保留发布时冻结的证据集合", () => {
    expect(
      projectPublicationRecord({
        id: "publication-1",
        tenantId: "tenant-1",
        subjectType: "runtime_revision",
        subjectRevisionId: "revision-1",
        publicationSequence: 3,
        evidenceSetDigest: "sha256:evidence",
        attestationIds: ["attestation-1"],
        conformanceRunId: "run-1",
        approvals: [{ actor: "security" }],
        agentDescriptorSnapshotId: null,
        agentProviderDescriptorDigest: null,
        agentCapabilityManifestDigest: null,
        agentInvocationContextContractDigest: null,
        publishedByType: "service",
        publishedBy: "publisher-1",
        publishedAt: new Date("2026-08-11T00:00:00.000Z"),
        idempotencyKey: "idem-1",
        idempotencyRecordId: "record-1",
      }),
    ).toMatchObject({
      subject_revision_id: "revision-1",
      evidence_set_digest: "sha256:evidence",
      attestation_ids: ["attestation-1"],
      conformance_run_id: "run-1",
      actor_type: "service",
    });
  });

  it("撤回投影保留 Publication 关联与原因码", () => {
    expect(
      projectWithdrawalRecord({
        id: "withdrawal-1",
        tenantId: "tenant-1",
        publicationRecordId: "publication-1",
        subjectType: "agent_revision",
        subjectRevisionId: "revision-1",
        reasonCode: "security_response",
        reason: "发现风险",
        withdrawnByType: "user",
        withdrawnBy: "user-1",
        withdrawnAt: new Date("2026-08-11T01:00:00.000Z"),
      }),
    ).toMatchObject({
      publication_record_id: "publication-1",
      subject_revision_id: "revision-1",
      reason_code: "security_response",
    });
  });
});
