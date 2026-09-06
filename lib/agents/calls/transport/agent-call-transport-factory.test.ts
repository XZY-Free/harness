import { buildAgentCallContextMetadata } from "@/lib/agents/calls/transport/agent-call-transport-factory";
import { describe, expect, it } from "vitest";

describe("buildAgentCallContextMetadata", () => {
  it("不在运行时补写 enterprise_user_context；只执行冻结合同的显式声明", () => {
    const metadata = buildAgentCallContextMetadata(
      { contexts: [] },
      {
        tenantId: "tenant-1",
        executionSubject: null,
        now: new Date("2026-09-06T00:00:00.000Z"),
        enterpriseUserContext: {
          context_version: "1",
          profile_status: "fresh",
          last_verified_at: "2026-09-06T00:00:00.000Z",
          fields: { employeeNo: "E-100" },
        },
      },
      { profileRequirement: "fresh_required", allowedFields: ["employeeNo"] },
    );

    expect(metadata).toEqual({});
  });
});
