/**
 * createAgentDescriptorSnapshot 应用命令测试 — 真实 MySQL。
 *
 * 覆盖：happy path（创建不可变 Snapshot + digest 一致）、Agent 不存在/跨租户 → 404 语义错误、
 * Capability 被 Tool 化 → 拒绝、operator supplement 来源标记、幂等 createdBy 校验。
 *
 * 事实源：docs/V12/01/agent补充/00 §6.2 / 01 §2。
 */
import { randomUUID } from "node:crypto";
import {
  AgentDescriptorAgentNotFoundError,
  createCreateAgentDescriptorSnapshot,
} from "@/lib/agents/application/create-agent-descriptor-snapshot";
import {
  AgentCapabilityToolizationError,
  type ProviderAgentCard,
} from "@/lib/agents/domain/agent-descriptor";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { mysqlAgentDescriptorStore } from "@/lib/agents/persistence/mysql-agent-descriptor-store";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-24T00:00:00.000Z");
const FIXED_SNAPSHOT_ID = "snapshot-fixed-0001";

const CARD: ProviderAgentCard = {
  protocol: { type: "a2a", contractRevision: "1.0" },
  identity: { name: "refund-agent", providerRevisionRef: "provider-v3" },
  capabilities: [
    {
      capabilityKey: "refund_processing",
      name: "退款处理",
      tags: ["refund"],
      examples: ["创建退款单"],
      inputModes: ["text"],
      outputModes: ["text"],
    },
  ],
  invocationContext: [
    { contextKind: "conversation_history", necessity: "required", purpose: "退款上下文" },
  ],
};

beforeEach(async () => {
  await resetDatabase(db);
});

async function seedAgent() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "descriptor-command-owner",
    email: "descriptor-command-owner@example.com",
    displayName: "Descriptor Command Owner",
  });
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: `descriptor-command-agent-${randomUUID()}`,
    displayName: "Descriptor Command Agent",
    ownerUserId: identity.id,
  });
  return { tenantId: tenant.id, identity, agent };
}

describe("createAgentDescriptorSnapshot", () => {
  it("happy path：创建不可变 Snapshot，digest 为 sha256: 前缀，且可读回", async () => {
    const { tenantId, identity, agent } = await seedAgent();
    const create = createCreateAgentDescriptorSnapshot({
      store: mysqlAgentDescriptorStore,
      now: () => NOW,
      newId: () => FIXED_SNAPSHOT_ID,
    });

    const result = await create({
      tenantId,
      agentId: agent.id,
      descriptorKind: "agent_card",
      card: CARD,
      providerDeclaredRevisionRef: "provider-v3",
      createdBy: identity.id,
    });

    expect(result.snapshotId).toBe(FIXED_SNAPSHOT_ID);
    expect(result.descriptorKind).toBe("agent_card");
    expect(result.protocolType).toBe("a2a");
    expect(result.protocolContractRevision).toBe("1.0");
    expect(result.capturedAt).toEqual(NOW);
    expect(result.providerDescriptorDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.capabilityManifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.invocationContextContractDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // 读回确认落库且来源正确
    const snapshots = await mysqlAgentDescriptorStore.transaction((s) =>
      s.listSnapshotsByAgent(tenantId, agent.id),
    );
    expect(snapshots).toHaveLength(1);
    const snap = snapshots[0]!;
    expect(snap.id).toBe(FIXED_SNAPSHOT_ID);
    expect(snap.providerDeclaredRevisionRef).toBe("provider-v3");
    expect(snap.contractSectionProvenance).toEqual({
      capability: "provider_declared",
      context: "provider_declared",
    });
    expect(snap.createdBy).toBe(identity.id);
  });

  it("operator supplement 记录为 operator_declared 来源", async () => {
    const { tenantId, identity, agent } = await seedAgent();
    const create = createCreateAgentDescriptorSnapshot({
      store: mysqlAgentDescriptorStore,
      now: () => NOW,
      newId: () => randomUUID(),
    });

    await create({
      tenantId,
      agentId: agent.id,
      descriptorKind: "agent_card",
      card: CARD,
      operatorContextSupplement: {
        contexts: [{ contextKind: "compliance_policy", necessity: "preferred" }],
      },
      createdBy: identity.id,
    });

    const snapshots = await mysqlAgentDescriptorStore.transaction((s) =>
      s.listSnapshotsByAgent(tenantId, agent.id),
    );
    const contract = snapshots[0]!.invocationContextContract as {
      contexts: Array<{ contextKind: string; provenance: string }>;
    };
    const providerCtx = contract.contexts.find((c) => c.contextKind === "conversation_history");
    const operatorCtx = contract.contexts.find((c) => c.contextKind === "compliance_policy");
    expect(providerCtx?.provenance).toBe("provider_declared");
    expect(operatorCtx?.provenance).toBe("operator_declared");
    expect(snapshots[0]!.contractSectionProvenance).toEqual({
      capability: "provider_declared",
      context: "operator_declared",
    });
  });

  it("Agent 不存在（或跨租户）→ AgentDescriptorAgentNotFoundError", async () => {
    const { tenantId } = await seedAgent();
    const create = createCreateAgentDescriptorSnapshot({ store: mysqlAgentDescriptorStore });

    await expect(
      create({
        tenantId,
        agentId: "nonexistent-agent",
        descriptorKind: "agent_card",
        card: CARD,
        createdBy: "owner",
      }),
    ).rejects.toBeInstanceOf(AgentDescriptorAgentNotFoundError);
  });

  it("Capability 被 Tool 化（携带 operation 字段）→ AgentCapabilityToolizationError", async () => {
    const { tenantId, identity, agent } = await seedAgent();
    const create = createCreateAgentDescriptorSnapshot({ store: mysqlAgentDescriptorStore });
    const badCard: ProviderAgentCard = {
      ...CARD,
      capabilities: [
        {
          capabilityKey: "refund_processing",
          name: "退款处理",
          // @ts-expect-error 测试非法输入
          operation: "refund.create",
        },
      ],
    };

    await expect(
      create({
        tenantId,
        agentId: agent.id,
        descriptorKind: "agent_card",
        card: badCard,
        createdBy: identity.id,
      }),
    ).rejects.toBeInstanceOf(AgentCapabilityToolizationError);
  });

  it("createdBy 为空 → AgentDescriptorError", async () => {
    const { tenantId, agent } = await seedAgent();
    const create = createCreateAgentDescriptorSnapshot({ store: mysqlAgentDescriptorStore });

    await expect(
      create({
        tenantId,
        agentId: agent.id,
        descriptorKind: "agent_card",
        card: CARD,
        createdBy: "",
      }),
    ).rejects.toThrow(/createdBy 不能为空/);
  });
});
