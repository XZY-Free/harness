/**
 * resolveBindingContextContract 测试 — 真实 MySQL。
 *
 * Batch 4 Gate（05 §6）：Invocation 只能使用 Binding 冻结 Revision 对应的 Context Contract：
 * - 按 Binding 冻结 snapshotId 精确解析（不是 Agent 最新 Snapshot）；
 * - Snapshot 缺失 / 租户不符 / digest 漂移 → fail-closed；
 * - Agent 之后登记新 Snapshot 不影响已开始 Invocation（append-only）。
 *
 * 发布权威切换后，Binding 冻结的是结构化 AgentContractSnapshot：上下文合同来自
 * 快照的 AgentContractInvocationContext 子记录（按 position 升序），digest 权威是
 * 快照 header.contextDigest。
 */
import { randomUUID } from "node:crypto";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { hrAgentContract } from "@/lib/agents/test-support/hr-agent-contract";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import { buildInvocationContextBundle } from "@/lib/context/enrichment/build-invocation-context-bundle";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  BindingContextContractError,
  resolveBindingContextContract,
} from "@/lib/executions/application/resolve-binding-context-contract";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import type { AgentContractSnapshot } from "@/lib/persistence/schema/agents";
import { beforeEach, describe, expect, it } from "vitest";

/** 合同 invocation_context 基线：conversation_history required + user_profile accepted。 */
function contractWithContexts(
  contexts: Array<{ key: string; necessity: string; descriptionZhCn: string }>,
) {
  return {
    ...hrAgentContract,
    invocation_context: contexts.map((c) => ({
      key: c.key,
      name: { "zh-CN": c.key },
      necessity: c.necessity,
      description: { "zh-CN": c.descriptionZhCn },
    })),
  };
}

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

async function seedSnapshot(
  tenantId: string,
  agentId: string,
  contexts: Array<{ key: string; necessity: string; descriptionZhCn: string }>,
): Promise<AgentContractSnapshot> {
  return seedAgentContractSnapshot({
    tenantId,
    agentId,
    createdBy: "test-operator",
    contract: contractWithContexts(contexts),
  });
}

const BASE_CONTEXTS = [
  { key: "conversation_history", necessity: "required", descriptionZhCn: "退款上下文" },
] as const;

describe("resolveBindingContextContract（05 §6）", () => {
  it("按 Binding 冻结 snapshotId 精确解析 InvocationContextContract（结构化子记录）", async () => {
    const { tenantId, agent } = await seedAgent();
    const snapshot = await seedSnapshot(tenantId, agent.id, [
      ...BASE_CONTEXTS,
      { key: "user_profile", necessity: "accepted", descriptionZhCn: "用户画像" },
    ]);

    const contract = await resolveBindingContextContract({
      tenantId,
      agentContractSnapshotId: snapshot.id,
      agentContextDigest: snapshot.contextDigest,
    });
    expect(contract).not.toBeNull();
    expect(
      contract?.contexts.some(
        (e) => e.contextKind === "conversation_history" && e.necessity === "required",
      ),
    ).toBe(true);
    expect(
      contract?.contexts.some(
        (e) => e.contextKind === "user_profile" && e.necessity === "accepted",
      ),
    ).toBe(true);
  });

  it("base route（三元组全 null）→ 返回 null（§18 not_applicable）", async () => {
    const { tenantId } = await seedAgent();
    const contract = await resolveBindingContextContract({
      tenantId,
      agentContractSnapshotId: null,
      agentContextDigest: null,
    });
    expect(contract).toBeNull();
  });

  it("Snapshot 不存在 → fail-closed（不回退最新 Snapshot）", async () => {
    const { tenantId } = await seedAgent();
    await expect(
      resolveBindingContextContract({
        tenantId,
        agentContractSnapshotId: "snapshot-not-exist",
        agentContextDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toThrow(BindingContextContractError);
  });

  it("跨租户 Snapshot → 视为不存在（fail-closed）", async () => {
    const { tenantId, agent } = await seedAgent();
    const snapshot = await seedSnapshot(tenantId, agent.id, [...BASE_CONTEXTS]);
    await expect(
      resolveBindingContextContract({
        tenantId: "other-tenant",
        agentContractSnapshotId: snapshot.id,
        agentContextDigest: snapshot.contextDigest,
      }),
    ).rejects.toThrow(BindingContextContractError);
  });

  it("digest 漂移 → 拒绝（精确一致，不接受近似匹配）", async () => {
    const { tenantId, agent } = await seedAgent();
    const snapshot = await seedSnapshot(tenantId, agent.id, [...BASE_CONTEXTS]);
    await expect(
      resolveBindingContextContract({
        tenantId,
        agentContractSnapshotId: snapshot.id,
        agentContextDigest: `sha256:${"9".repeat(64)}`,
      }),
    ).rejects.toThrow(BindingContextContractError);
  });

  it("Agent 之后登记新 Snapshot → 已冻结 Binding 仍解析旧 Contract（append-only）", async () => {
    const { tenantId, agent } = await seedAgent();
    const first = await seedSnapshot(tenantId, agent.id, [...BASE_CONTEXTS]);

    // 之后 Provider 变更上下文合同 → 登记 second Snapshot。
    const second = await seedSnapshot(tenantId, agent.id, [
      { key: "conversation_history", necessity: "preferred", descriptionZhCn: "新上下文" },
      { key: "user_profile", necessity: "accepted", descriptionZhCn: "用户画像" },
    ]);
    expect(second.contextDigest).not.toBe(first.contextDigest);

    // Binding 冻结的是 first → 解析结果仍是 first 的 Contract（新 Snapshot 不影响）。
    const contract = await resolveBindingContextContract({
      tenantId,
      agentContractSnapshotId: first.id,
      agentContextDigest: first.contextDigest,
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
        agentContractSnapshotId: "snapshot-x",
        agentContextDigest: null,
      }),
    ).rejects.toThrow(BindingContextContractError);
  });

  it("全链：Binding 冻结 Snapshot → Context Contract → Context Bundle（Batch 5 Gate）", async () => {
    const { tenantId, agent } = await seedAgent();
    // preferred 声明（required 的 fail 行为已由 unit 测试覆盖）。
    const snapshot = await seedSnapshot(tenantId, agent.id, [
      { key: "conversation_history", necessity: "preferred", descriptionZhCn: "退款上下文" },
    ]);

    // Binding 冻结的 Contract 经 resolveBindingContextContract 精确解析。
    const contract = await resolveBindingContextContract({
      tenantId,
      agentContractSnapshotId: snapshot.id,
      agentContextDigest: snapshot.contextDigest,
    });
    expect(contract).not.toBeNull();

    // Contract 直接进入 Context Enrichment（preferred 可用 → supplied）。
    const bundle = buildInvocationContextBundle({
      contract: contract as NonNullable<typeof contract>,
      environment: {
        tenantId,
        executionSubject: {
          userIdentityId: "user-1",
          externalSubject: "employee-42",
          email: "employee42@example.com",
          displayName: "员工42",
        },
        now: new Date("2026-08-25T08:00:00.000Z"),
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
      },
    });
    expect(bundle).not.toBeNull();
  });
});
