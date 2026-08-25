/**
 * AgentDescriptor 领域模型单元测试（无 DB）。
 *
 * 覆盖：canonicalizeAgentDescriptor 的规范化与 digest、Capability 防 Tool 化、necessity 校验、
 * capabilityKey 去重、provider/operator 来源标记、digest 稳定性（同输入同输出 / 异输入异输出）。
 *
 * 事实源：docs/V12/01/agent补充/00 §6.2/§7/§8、01 §2/§4。
 */
import {
  AgentCapabilityToolizationError,
  AgentDescriptorError,
  type ProviderAgentCard,
  type ProviderCapability,
  canonicalizeAgentDescriptor,
  computeStableDigest,
} from "@/lib/agents/domain/agent-descriptor";
import { describe, expect, it } from "vitest";

const REFUND_CAP: ProviderCapability = {
  capabilityKey: "refund_processing",
  name: "退款处理",
  description: "处理退款申请",
  tags: ["refund", "finance"],
  examples: ["创建退款单"],
  inputModes: ["text"],
  outputModes: ["text"],
};

const BASE_CARD: ProviderAgentCard = {
  protocol: { type: "a2a", contractRevision: "1.0" },
  identity: { name: "refund-agent", providerRevisionRef: "provider-v3" },
  capabilities: [REFUND_CAP],
  invocationContext: [
    { contextKind: "conversation_history", necessity: "required", purpose: "退款上下文" },
    { contextKind: "identity_context", necessity: "accepted" },
  ],
};

describe("canonicalizeAgentDescriptor", () => {
  it("生成稳定 digest：同输入两次规范化必须产生相同 digest（sha256: 前缀 + 64 hex）", () => {
    const a = canonicalizeAgentDescriptor({
      tenantId: "t1",
      agentId: "a1",
      descriptorKind: "agent_card",
      card: BASE_CARD,
    });
    const b = canonicalizeAgentDescriptor({
      tenantId: "t2",
      agentId: "a2",
      descriptorKind: "agent_card",
      card: BASE_CARD,
    });
    // 规范化 digest 与租户/Agent 无关（只由外部合同内容决定）。
    expect(a.providerDescriptorDigest).toBe(b.providerDescriptorDigest);
    expect(a.capabilityManifestDigest).toBe(b.capabilityManifestDigest);
    expect(a.invocationContextContractDigest).toBe(b.invocationContextContractDigest);
    for (const d of [
      a.providerDescriptorDigest,
      a.capabilityManifestDigest,
      a.invocationContextContractDigest,
    ]) {
      expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("能力内容变化 → capabilityManifestDigest 变化", () => {
    const base = canonicalizeAgentDescriptor({
      tenantId: "t",
      agentId: "a",
      descriptorKind: "agent_card",
      card: BASE_CARD,
    });
    const changed = canonicalizeAgentDescriptor({
      tenantId: "t",
      agentId: "a",
      descriptorKind: "agent_card",
      card: {
        ...BASE_CARD,
        capabilities: [{ ...REFUND_CAP, name: "退款处理（新版）" }],
      },
    });
    expect(changed.capabilityManifestDigest).not.toBe(base.capabilityManifestDigest);
  });

  it("operator context supplement 标记为 operator_declared，且改变 context digest", () => {
    const providerOnly = canonicalizeAgentDescriptor({
      tenantId: "t",
      agentId: "a",
      descriptorKind: "agent_card",
      card: BASE_CARD,
    });
    const withOperator = canonicalizeAgentDescriptor({
      tenantId: "t",
      agentId: "a",
      descriptorKind: "agent_card",
      card: BASE_CARD,
      operatorContextSupplement: {
        contexts: [{ contextKind: "compliance_policy", necessity: "preferred" }],
      },
    });
    // provider 声明的 context 仍标记 provider_declared
    const providerCtx = withOperator.invocationContextContract.contexts.find(
      (c) => c.contextKind === "conversation_history",
    );
    expect(providerCtx?.provenance).toBe("provider_declared");
    // operator 补充的 context 标记 operator_declared
    const operatorCtx = withOperator.invocationContextContract.contexts.find(
      (c) => c.contextKind === "compliance_policy",
    );
    expect(operatorCtx?.provenance).toBe("operator_declared");
    // 有 operator 补充时 context 来源聚合为 operator_declared，且 digest 变化
    expect(withOperator.contractSectionProvenance.context).toBe("operator_declared");
    expect(withOperator.invocationContextContractDigest).not.toBe(
      providerOnly.invocationContextContractDigest,
    );
  });

  it("Capability 携带函数/operation 字段被拒绝（Agent 是 task-oriented，不是 Tool）", () => {
    const badCard: ProviderAgentCard = {
      ...BASE_CARD,
      capabilities: [
        {
          capabilityKey: "refund_processing",
          name: "退款处理",
          // @ts-expect-error 测试非法输入
          operation: "refund.create",
        },
      ],
    };
    expect(() =>
      canonicalizeAgentDescriptor({
        tenantId: "t",
        agentId: "a",
        descriptorKind: "agent_card",
        card: badCard,
      }),
    ).toThrow(AgentCapabilityToolizationError);
  });

  it("necessity 非法值被拒绝", () => {
    const badCard: ProviderAgentCard = {
      ...BASE_CARD,
      invocationContext: [
        // @ts-expect-error 测试非法输入
        { contextKind: "x", necessity: "mandatory" },
      ],
    };
    expect(() =>
      canonicalizeAgentDescriptor({
        tenantId: "t",
        agentId: "a",
        descriptorKind: "agent_card",
        card: badCard,
      }),
    ).toThrow(AgentDescriptorError);
  });

  it("capabilityKey 重复被拒绝", () => {
    const badCard: ProviderAgentCard = {
      ...BASE_CARD,
      capabilities: [REFUND_CAP, REFUND_CAP],
    };
    expect(() =>
      canonicalizeAgentDescriptor({
        tenantId: "t",
        agentId: "a",
        descriptorKind: "agent_card",
        card: badCard,
      }),
    ).toThrow(/capabilityKey 重复/);
  });

  it("descriptorKind 为空被拒绝", () => {
    expect(() =>
      canonicalizeAgentDescriptor({
        tenantId: "t",
        agentId: "a",
        descriptorKind: "",
        card: BASE_CARD,
      }),
    ).toThrow(AgentDescriptorError);
  });

  it("protocol.type / protocol.contractRevision 缺失被拒绝", () => {
    const badCard = { ...BASE_CARD, protocol: { type: "a2a" } as never };
    expect(() =>
      canonicalizeAgentDescriptor({
        tenantId: "t",
        agentId: "a",
        descriptorKind: "agent_card",
        card: badCard,
      }),
    ).toThrow(/protocol\.type/);
  });

  it("capabilityManifest 不含 Runtime interface requirements（只由业务能力构成）", () => {
    const result = canonicalizeAgentDescriptor({
      tenantId: "t",
      agentId: "a",
      descriptorKind: "agent_card",
      card: BASE_CARD,
    });
    const manifest = result.normalizedCapabilityManifest;
    expect(manifest.capabilities).toHaveLength(1);
    // 规范化后只保留白名单字段，不携带 operation/interface 等字段
    const keys = Object.keys(manifest.capabilities[0]!);
    expect(keys).toEqual(
      expect.arrayContaining([
        "capabilityKey",
        "name",
        "tags",
        "examples",
        "inputModes",
        "outputModes",
      ]),
    );
    expect(keys).not.toContain("operation");
  });
});

describe("computeStableDigest", () => {
  it("对象键序不影响 digest（sortKeys 规范化）", () => {
    const a = computeStableDigest({ b: 1, a: 2 });
    const b = computeStableDigest({ a: 2, b: 1 });
    expect(a).toBe(b);
  });
});
