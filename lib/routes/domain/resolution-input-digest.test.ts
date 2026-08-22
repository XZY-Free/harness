import { describe, expect, it } from "vitest";
import { computeResolutionInputDigest } from "./resolution-input-digest";

const baseInput = {
  tenantId: "tenant-1",
  agentConstraint: "agent-1",
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
      agentConstraint: "agent-1",
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
    ["agentConstraint", { agentConstraint: "agent-2" }],
    ["routeScopeKey", { routeScopeKey: "staging" }],
    ["businessKey", { businessKey: { jobId: "job-1" } }],
    ["attributes", { attributes: { ...baseInput.attributes, region: "eu-west" } }],
    ["threadDefaultModelRef", { threadDefaultModelRef: "model-v2" }],
  ])("%s 变化时摘要变化", (_field, change) => {
    expect(computeResolutionInputDigest({ ...baseInput, ...change })).not.toBe(
      computeResolutionInputDigest(baseInput),
    );
  });

  it("agentConstraint null（基础 Harness Route）与 concrete 产生不同摘要（§8.4）", () => {
    const base = computeResolutionInputDigest(baseInput);
    // 显式 null（缺失与 null 统一为 null）不得与 concrete 混同。
    expect(computeResolutionInputDigest({ ...baseInput, agentConstraint: null })).not.toBe(base);
    // missing 与 null 统一为 null（同一态）。
    const { agentConstraint: _omitted, ...missing } = baseInput;
    expect(computeResolutionInputDigest(missing)).toBe(
      computeResolutionInputDigest({ ...baseInput, agentConstraint: null }),
    );
    // 禁 empty / "default" 四态：空串与 "default" 也按 concrete 处理，不得吞并 null。
    expect(computeResolutionInputDigest({ ...baseInput, agentConstraint: "" })).not.toBe(
      computeResolutionInputDigest({ ...baseInput, agentConstraint: null }),
    );
    expect(computeResolutionInputDigest({ ...baseInput, agentConstraint: "default" })).not.toBe(
      computeResolutionInputDigest({ ...baseInput, agentConstraint: null }),
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
