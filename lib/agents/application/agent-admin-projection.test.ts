import { describe, expect, it } from "vitest";
import { computeAgentRevisionEligibility } from "./agent-admin-projection";

const BASE = {
  agentLifecycleState: "enabled",
  revisionState: "published",
  agentContractSnapshotId: "snap-1",
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

  it("快照缺失或 Publication 缺失均 fail-closed", () => {
    expect(computeAgentRevisionEligibility({ ...BASE, agentContractSnapshotId: "" })).toMatchObject(
      { executionEligible: false },
    );
    expect(computeAgentRevisionEligibility({ ...BASE, hasPublication: false })).toMatchObject({
      executionEligible: false,
    });
    expect(computeAgentRevisionEligibility({ ...BASE, hasWithdrawal: true })).toMatchObject({
      executionEligible: false,
    });
  });
});
