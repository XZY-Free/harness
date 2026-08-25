/**
 * resolveBindingContextContract 测试 — 真实 MySQL。
 *
 * Batch 4 Gate（05 §6）：Invocation 只能使用 Binding 冻结 Revision 对应的 Context Contract：
 * - 按 Binding 冻结 snapshotId 精确解析（不是 Agent 最新 Snapshot）；
 * - Snapshot 缺失 / 租户不符 / digest 漂移 → fail-closed；
 * - Agent 之后登记新 Snapshot 不影响已开始 Invocation（append-only）。
 */
import { randomUUID } from "node:crypto";
import { createCreateAgentDescriptorSnapshot } from "@/lib/agents/application/create-agent-descriptor-snapshot";
import type { ProviderAgentCard } from "@/lib/agents/domain/agent-descriptor";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { mysqlAgentDescriptorStore } from "@/lib/agents/persistence/mysql-agent-descriptor-store";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  BindingContextContractError,
  resolveBindingContextContract,
} from "@/lib/executions/application/resolve-binding-context-contract";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { beforeEach, describe, expect, it } from "vitest";

const CARD: ProviderAgentCard = {
  protocol: { type: "a2a", contractRevision: "1.0" },
  identity: { name: "contract-agent", providerRevisionRef: "provider-v1" },
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
    externalSubject: "context-contract-owner",
    email: "context-contract-owner@example.com",
    displayName: "Context Contract Owner",
  });
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: `context-contract-agent-${randomUUID()}`,
    displayName: "Context Contract Agent",
    ownerUserId: identity.id,
  });
  return { tenantId: tenant.id, agent };
}

async function seedSnapshot(tenantId: string, agentId: string, card: ProviderAgentCard) {
  const create = createCreateAgentDescriptorSnapshot({ store: mysqlAgentDescriptorStore });
  return create({
    tenantId,
    agentId,
    descriptorKind: "agent_card",
    card,
    createdBy: "test-operator",
  });
}

describe("resolveBindingContextContract（05 §6）", () => {
  it("按 Binding 冻结 snapshotId 精确解析 InvocationContextContract", async () => {
    const { tenantId, agent } = await seedAgent();
    const snapshot = await seedSnapshot(tenantId, agent.id, CARD);

    const contract = await resolveBindingContextContract({
      tenantId,
      agentDescriptorSnapshotId: snapshot.snapshotId,
      agentInvocationContextContractDigest: snapshot.invocationContextContractDigest,
    });
    expect(contract).not.toBeNull();
    expect(
      contract?.contexts.some(
        (e) => e.contextKind === "conversation_history" && e.necessity === "required",
      ),
    ).toBe(true);
  });

  it("base route（三元组全 null）→ 返回 null（§18 not_applicable）", async () => {
    const { tenantId } = await seedAgent();
    const contract = await resolveBindingContextContract({
      tenantId,
      agentDescriptorSnapshotId: null,
      agentInvocationContextContractDigest: null,
    });
    expect(contract).toBeNull();
  });

  it("Snapshot 不存在 → fail-closed（不回退最新 Snapshot）", async () => {
    const { tenantId } = await seedAgent();
    await expect(
      resolveBindingContextContract({
        tenantId,
        agentDescriptorSnapshotId: "snapshot-not-exist",
        agentInvocationContextContractDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toThrow(BindingContextContractError);
  });

  it("跨租户 Snapshot → 视为不存在（fail-closed）", async () => {
    const { tenantId, agent } = await seedAgent();
    const snapshot = await seedSnapshot(tenantId, agent.id, CARD);
    await expect(
      resolveBindingContextContract({
        tenantId: "other-tenant",
        agentDescriptorSnapshotId: snapshot.snapshotId,
        agentInvocationContextContractDigest: snapshot.invocationContextContractDigest,
      }),
    ).rejects.toThrow(BindingContextContractError);
  });

  it("digest 漂移 → 拒绝（精确一致，不接受近似匹配）", async () => {
    const { tenantId, agent } = await seedAgent();
    const snapshot = await seedSnapshot(tenantId, agent.id, CARD);
    await expect(
      resolveBindingContextContract({
        tenantId,
        agentDescriptorSnapshotId: snapshot.snapshotId,
        agentInvocationContextContractDigest: `sha256:${"9".repeat(64)}`,
      }),
    ).rejects.toThrow(BindingContextContractError);
  });

  it("Agent 之后登记新 Snapshot → 已冻结 Binding 仍解析旧 Contract（append-only）", async () => {
    const { tenantId, agent } = await seedAgent();
    const first = await seedSnapshot(tenantId, agent.id, CARD);

    // 之后 Provider 变更上下文合同 → 登记 second Snapshot。
    const changedCard: ProviderAgentCard = {
      ...CARD,
      identity: { ...CARD.identity, providerRevisionRef: "provider-v2" },
      invocationContext: [
        { contextKind: "conversation_history", necessity: "preferred", purpose: "新上下文" },
        { contextKind: "user_profile", necessity: "accepted", purpose: "用户画像" },
      ],
    };
    const second = await seedSnapshot(tenantId, agent.id, changedCard);
    expect(second.invocationContextContractDigest).not.toBe(first.invocationContextContractDigest);

    // Binding 冻结的是 first → 解析结果仍是 first 的 Contract（新 Snapshot 不影响）。
    const contract = await resolveBindingContextContract({
      tenantId,
      agentDescriptorSnapshotId: first.snapshotId,
      agentInvocationContextContractDigest: first.invocationContextContractDigest,
    });
    expect(
      contract?.contexts.some(
        (e) => e.necessity === "required" && e.contextKind === "conversation_history",
      ),
    ).toBe(true);
  });

  it("三元组半空（all-or-nothing 违例）→ 拒绝", async () => {
    const { tenantId } = await seedAgent();
    await expect(
      resolveBindingContextContract({
        tenantId,
        agentDescriptorSnapshotId: "snapshot-x",
        agentInvocationContextContractDigest: null,
      }),
    ).rejects.toThrow(BindingContextContractError);
  });
});
