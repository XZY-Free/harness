import { describe, expect, it } from "vitest";
import { computeAgentRevisionEligibility } from "./agent-admin-projection";

const BASE = {
  agentLifecycleState: "enabled",
  revisionState: "published",
  artifactId: "artifact-1",
  artifactDigest: "sha256:artifact",
  publicationAttestationIds: ["attestation-1"],
  verifiedActiveAttestationIds: ["attestation-1"],
  hasPublication: true,
  hasWithdrawal: false,
};

describe("AgentRevision admin projection eligibility", () => {
  it("只有权威 Publication 绑定的证据全集精确有效时可执行", () => {
    expect(computeAgentRevisionEligibility(BASE)).toEqual({
      executionEligible: true,
      ineligibilityReasons: [],
    });
  });

  it("证据缺失、多出或重复均 fail-closed", () => {
    for (const publicationAttestationIds of [
      [],
      ["attestation-1", "attestation-2"],
      ["attestation-1", "attestation-1"],
    ]) {
      expect(computeAgentRevisionEligibility({ ...BASE, publicationAttestationIds })).toMatchObject(
        { executionEligible: false },
      );
    }
  });
});
