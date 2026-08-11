import { describe, expect, it } from "vitest";
import { computeResolutionInputDigest } from "./resolution-input-digest";

const baseInput = {
  tenantId: "tenant-1",
  agentId: "agent-1",
  routeScopeKey: "production",
  businessKey: { threadId: "thread-1" },
  attributes: {
    region: "cn-north",
    nested: { tier: 2, flags: { audited: true } },
    ordered: ["primary", "secondary"],
  },
  threadDefaultModelRef: "model-v1",
};

describe("computeResolutionInputDigest", () => {
  it("递归排序对象键且不受对象插入顺序影响", () => {
    const reordered = {
      threadDefaultModelRef: "model-v1",
      attributes: {
        ordered: ["primary", "secondary"],
        nested: { flags: { audited: true }, tier: 2 },
        region: "cn-north",
      },
      businessKey: { threadId: "thread-1" },
      routeScopeKey: "production",
      agentId: "agent-1",
      tenantId: "tenant-1",
    };

    expect(computeResolutionInputDigest(reordered)).toBe(computeResolutionInputDigest(baseInput));
  });

  it("数组保持领域顺序", () => {
    const reversed = {
      ...baseInput,
      attributes: { ...baseInput.attributes, ordered: ["secondary", "primary"] },
    };

    expect(computeResolutionInputDigest(reversed)).not.toBe(
      computeResolutionInputDigest(baseInput),
    );
  });

  it("threadDefaultModelRef missing 与 null 统一为 null", () => {
    const { threadDefaultModelRef: _omitted, ...missing } = baseInput;
    expect(computeResolutionInputDigest(missing)).toBe(
      computeResolutionInputDigest({ ...missing, threadDefaultModelRef: null }),
    );
  });

  it.each([
    ["tenantId", { tenantId: "tenant-2" }],
    ["agentId", { agentId: "agent-2" }],
    ["routeScopeKey", { routeScopeKey: "staging" }],
    ["businessKey", { businessKey: { jobId: "job-1" } }],
    ["attributes", { attributes: { ...baseInput.attributes, region: "eu-west" } }],
    ["threadDefaultModelRef", { threadDefaultModelRef: "model-v2" }],
  ])("%s 变化时摘要变化", (_field, change) => {
    expect(computeResolutionInputDigest({ ...baseInput, ...change })).not.toBe(
      computeResolutionInputDigest(baseInput),
    );
  });

  it("返回 UTF-8 RFC 8785 canonical JSON 的 SHA-256", () => {
    expect(
      computeResolutionInputDigest({
        ...baseInput,
        attributes: { label: "雪" },
      }),
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
