import { describe, expect, it } from "vitest";
import { computeRuntimeRevisionEligibility, projectRuntime } from "./runtime-admin-projection";

describe("runtime admin projection", () => {
  it("投影真实 Runtime 生命周期与版本", () => {
    expect(
      projectRuntime({
        id: "runtime-1",
        tenantId: "tenant-1",
        runtimeKey: "hosted",
        displayName: "Hosted",
        runtimeKind: "hosted",
        ownerUserId: "user-1",
        lifecycleState: "enabled",
        currentRevisionId: "revision-1",
        versionNo: 3,
        createdAt: new Date("2026-08-11T00:00:00.000Z"),
        updatedAt: new Date("2026-08-11T00:01:00.000Z"),
        deletedAt: null,
      }),
    ).toMatchObject({
      tenant_id: "tenant-1",
      kind: "hosted",
      lifecycle_state: "enabled",
      version_no: 3,
    });
  });

  it("只有冻结 Publication 证据和 Conformance 全部有效时可执行", () => {
    const base = {
      runtimeLifecycleState: "enabled",
      revisionState: "published",
      runtimeEvidenceKind: "hosted_artifact" as const,
      artifactId: "artifact-1",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      publicationAttestationIds: ["attestation-1"],
      verifiedActiveAttestationIds: ["attestation-1"],
      publicationConformanceRunId: "run-1",
      validConformanceRunId: "run-1",
      hasPublication: true,
      hasWithdrawal: false,
    };
    expect(computeRuntimeRevisionEligibility(base)).toEqual({
      executionEligible: true,
      ineligibilityReasons: [],
    });
    expect(
      computeRuntimeRevisionEligibility({ ...base, validConformanceRunId: "run-2" }),
    ).toMatchObject({ executionEligible: false });
  });
});
