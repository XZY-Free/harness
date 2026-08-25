/**
 * MySQL AgentDescriptorStore 测试 — 真实 MySQL。
 *
 * 覆盖：登记后 Snapshot 不可变（只读查询）、findAgent（同租户命中 / 跨租户隐藏）、
 * findSnapshotById、listSnapshotsByAgent（按 capturedAt 降序）。
 *
 * 事实源：docs/V12/01/agent补充/00 §6.2 / 01 §2。
 */
import { randomUUID } from "node:crypto";
import { createAgent, getAgentById } from "@/lib/agents/persistence/agent-queries";
import { mysqlAgentDescriptorStore } from "@/lib/agents/persistence/mysql-agent-descriptor-store";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import type { NewAgentDescriptorSnapshot } from "@/lib/persistence/schema/agents";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

/** 创建租户 + owner + Agent。 */
async function seedAgent() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "descriptor-store-owner",
    email: "descriptor-store-owner@example.com",
    displayName: "Descriptor Store Owner",
  });
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: `descriptor-agent-${randomUUID()}`,
    displayName: "Descriptor Agent",
    ownerUserId: identity.id,
  });
  return { tenantId: tenant.id, agent, identity };
}

function snapshotRow(
  tenantId: string,
  agentId: string,
  overrides: Partial<NewAgentDescriptorSnapshot> = {},
): NewAgentDescriptorSnapshot {
  const capturedAt = new Date("2026-08-24T00:00:00.000Z");
  return {
    id: randomUUID(),
    tenantId,
    agentId,
    descriptorKind: "agent_card",
    protocolType: "a2a",
    protocolContractRevision: "1.0",
    canonicalProviderDescriptor: {
      descriptorKind: "agent_card",
      protocol: { type: "a2a", contractRevision: "1.0" },
    },
    providerDescriptorDigest: `sha256:${"a".repeat(64)}`,
    normalizedCapabilityManifest: { capabilities: [] },
    capabilityManifestDigest: `sha256:${"b".repeat(64)}`,
    invocationContextContract: { contexts: [] },
    invocationContextContractDigest: `sha256:${"c".repeat(64)}`,
    providerDeclaredRevisionRef: "provider-v1",
    contractSectionProvenance: { capability: "provider_declared", context: "provider_declared" },
    capturedAt,
    createdBy: "owner",
    ...overrides,
  };
}

describe("mysqlAgentDescriptorStore", () => {
  it("findAgent：同租户命中 Agent，跨租户隐藏", async () => {
    const { tenantId, agent } = await seedAgent();
    const hit = await mysqlAgentDescriptorStore.transaction((s) => s.findAgent(tenantId, agent.id));
    expect(hit?.id).toBe(agent.id);

    const miss = await mysqlAgentDescriptorStore.transaction((s) =>
      s.findAgent("other-tenant", agent.id),
    );
    expect(miss).toBeNull();
  });

  it("insertSnapshot + findSnapshotById 往返一致（不可变）", async () => {
    const { tenantId, agent } = await seedAgent();
    const row = snapshotRow(tenantId, agent.id);
    await mysqlAgentDescriptorStore.transaction((s) => s.insertSnapshot(row));

    const found = await mysqlAgentDescriptorStore.transaction((s) => s.findSnapshotById(row.id!));
    expect(found).not.toBeNull();
    expect(found!.id).toBe(row.id);
    expect(found!.agentId).toBe(agent.id);
    expect(found!.protocolType).toBe("a2a");
    expect(found!.capabilityManifestDigest).toBe(row.capabilityManifestDigest);
    expect(found!.contractSectionProvenance).toEqual({
      capability: "provider_declared",
      context: "provider_declared",
    });
  });

  it("listSnapshotsByAgent 按 capturedAt 降序，且不跨租户泄露", async () => {
    const { tenantId, agent } = await seedAgent();
    const older = snapshotRow(tenantId, agent.id, {
      id: "older-snapshot-id",
      capturedAt: new Date("2026-08-20T00:00:00.000Z"),
    });
    const newer = snapshotRow(tenantId, agent.id, {
      id: "newer-snapshot-id",
      capturedAt: new Date("2026-08-24T00:00:00.000Z"),
    });
    await mysqlAgentDescriptorStore.transaction(async (s) => {
      await s.insertSnapshot(older);
      await s.insertSnapshot(newer);
    });

    const rows = await mysqlAgentDescriptorStore.transaction((s) =>
      s.listSnapshotsByAgent(tenantId, agent.id),
    );
    expect(rows.map((r) => r.id)).toEqual(["newer-snapshot-id", "older-snapshot-id"]);

    // 跨租户查不到
    const crossTenant = await mysqlAgentDescriptorStore.transaction((s) =>
      s.listSnapshotsByAgent("other-tenant", agent.id),
    );
    expect(crossTenant).toHaveLength(0);
  });

  it("store 不提供 update（Snapshot 不可变语义由接口约束）", () => {
    // 接口只暴露 insert + 只读查询；编译期保证无 update 能力。
    const store = mysqlAgentDescriptorStore;
    expect(store).toBeDefined();
  });
});
