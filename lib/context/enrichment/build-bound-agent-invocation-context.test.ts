/**
 * Bound Context Orchestration 测试（04 专项 §2/§3/§7/§8/§10/§14）。
 *
 * 不变量：
 * - Contract 只来自 Binding 冻结 exact Snapshot（新登记 Snapshot 不影响旧 Binding）；
 * - Base Harness（snapshot 全 null）→ null，不执行 Agent 级 Context Contract；
 * - required 缺失/被 external policy 拒绝 → 调用前 fail；
 * - current_datetime 每次 dispatch 真实刷新；timezone/locale 无权威来源 → preferred 省略；
 * - accepted 数据型 context 无明确 allow/未显式选择 → 不发送；
 * - 对外 value 只含公开字段（subject_id/subject_kind），不含 tenantId/email。
 */
import { randomUUID } from "node:crypto";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { hrAgentContract } from "@/lib/agents/test-support/hr-agent-contract";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import { buildBoundAgentInvocationContext } from "@/lib/context/enrichment/build-bound-agent-invocation-context";
import {
  RequiredContextDeniedError,
  RequiredContextUnavailableError,
} from "@/lib/context/enrichment/build-invocation-context-bundle";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import type { AgentContractSnapshot } from "@/lib/persistence/schema/agents";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

function contractWithContexts(
  contexts: Array<{ key: string; necessity: string }>,
): Record<string, unknown> {
  return {
    ...hrAgentContract,
    invocation_context: contexts.map((c) => ({
      key: c.key,
      name: { "zh-CN": c.key },
      necessity: c.necessity,
      description: { "zh-CN": `${c.key} 上下文` },
    })),
  };
}

async function seed(): Promise<{
  tenantId: string;
  seedSnapshot: (
    contexts: Array<{ key: string; necessity: string }>,
  ) => Promise<AgentContractSnapshot>;
}> {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "bound-context-owner",
    email: "bound-context-owner@example.com",
    displayName: "Bound Context Owner",
  });
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: `bound-context-agent-${randomUUID()}`,
    displayName: "Bound Context Agent",
    ownerUserId: identity.id,
  });
  return {
    tenantId: tenant.id,
    seedSnapshot: (contexts) =>
      seedAgentContractSnapshot({
        tenantId: tenant.id,
        agentId: agent.id,
        createdBy: "test-operator",
        contract: contractWithContexts(contexts),
      }),
  };
}

const SUBJECT: ExecutionSubject = {
  tenantId: "placeholder",
  subjectType: "user",
  subjectId: "user-1",
};

describe("buildBoundAgentInvocationContext（04 §3）", () => {
  it("Agent route：preferred 公共 Context 供给（subject 公开形态 + current_datetime + timezone 有权威才供给）", async () => {
    const { tenantId, seedSnapshot } = await seed();
    const snapshot = await seedSnapshot([
      { key: "execution_subject", necessity: "preferred" },
      { key: "current_datetime", necessity: "preferred" },
      { key: "timezone", necessity: "preferred" },
      { key: "locale", necessity: "preferred" },
    ]);
    const now = new Date("2026-08-26T09:30:00.000Z");
    const bundle = await buildBoundAgentInvocationContext({
      tenantId,
      binding: {
        agentContractSnapshotId: snapshot.id,
        agentContextDigest: snapshot.contextDigest,
      },
      executionSubject: { ...SUBJECT, tenantId },
      now,
      // timezone 有可信来源；locale 无 → preferred 省略。
      platform: { timezone: "Asia/Shanghai", locale: null },
    });
    expect(bundle).not.toBeNull();
    const byKind = new Map(bundle!.entries.map((e) => [e.contextKind, e]));
    expect(byKind.get("execution_subject")).toMatchObject({
      supplied: true,
      trusted: true,
      value: { subject_id: "user-1", subject_kind: "platform_user" },
    });
    expect(JSON.stringify(byKind.get("execution_subject")?.value)).not.toContain(tenantId);
    expect(byKind.get("current_datetime")?.value).toBe(now.toISOString());
    expect(byKind.get("timezone")).toMatchObject({ supplied: true, value: "Asia/Shanghai" });
    expect(byKind.get("locale")).toMatchObject({
      supplied: false,
      omissionReason: "not_available",
    });
  });

  it("exact Snapshot：登记新 Snapshot 后，旧 Binding 冻结合同不漂移", async () => {
    const { tenantId, seedSnapshot } = await seed();
    const oldSnapshot = await seedSnapshot([{ key: "current_datetime", necessity: "preferred" }]);
    // Agent 之后登记新 Snapshot（合同 facts 变化）。
    await seedSnapshot([
      { key: "current_datetime", necessity: "preferred" },
      { key: "timezone", necessity: "required" },
    ]);
    const bundle = await buildBoundAgentInvocationContext({
      tenantId,
      binding: {
        agentContractSnapshotId: oldSnapshot.id,
        agentContextDigest: oldSnapshot.contextDigest,
      },
      executionSubject: null,
      now: new Date(),
    });
    expect(bundle?.entries.map((e) => e.contextKind)).toEqual(["current_datetime"]);
  });

  it("required 数据型 context 被 external policy 拒绝 → 调用前 fail（RequiredContextDeniedError）", async () => {
    const { tenantId, seedSnapshot } = await seed();
    const snapshot = await seedSnapshot([{ key: "conversation_summary", necessity: "required" }]);
    await expect(
      buildBoundAgentInvocationContext({
        tenantId,
        binding: {
          agentContractSnapshotId: snapshot.id,
          agentContextDigest: snapshot.contextDigest,
        },
        executionSubject: { ...SUBJECT, tenantId },
        now: new Date(),
      }),
    ).rejects.toThrow(RequiredContextDeniedError);
  });

  it("required execution_subject 但无可信主体 → 调用前 fail（RequiredContextUnavailableError）", async () => {
    const { tenantId, seedSnapshot } = await seed();
    const snapshot = await seedSnapshot([{ key: "execution_subject", necessity: "required" }]);
    await expect(
      buildBoundAgentInvocationContext({
        tenantId,
        binding: {
          agentContractSnapshotId: snapshot.id,
          agentContextDigest: snapshot.contextDigest,
        },
        executionSubject: null,
        now: new Date(),
      }),
    ).rejects.toThrow(RequiredContextUnavailableError);
  });

  it("Base Harness（snapshot 全 null）→ null：不读取 Agent Contract、不执行 Agent 级 Enrichment", async () => {
    const { tenantId } = await seed();
    const bundle = await buildBoundAgentInvocationContext({
      tenantId,
      binding: { agentContractSnapshotId: null, agentContextDigest: null },
      executionSubject: { ...SUBJECT, tenantId },
      now: new Date(),
    });
    expect(bundle).toBeNull();
  });

  it("current_datetime 每次 dispatch 真实刷新（不得冻结）", async () => {
    const { tenantId, seedSnapshot } = await seed();
    const snapshot = await seedSnapshot([{ key: "current_datetime", necessity: "preferred" }]);
    const binding = {
      agentContractSnapshotId: snapshot.id,
      agentContextDigest: snapshot.contextDigest,
    };
    const first = await buildBoundAgentInvocationContext({
      tenantId,
      binding,
      executionSubject: null,
      now: new Date("2026-08-26T10:00:00.000Z"),
    });
    const second = await buildBoundAgentInvocationContext({
      tenantId,
      binding,
      executionSubject: null,
      now: new Date("2026-08-26T11:30:00.000Z"),
    });
    expect(first?.entries[0]?.value).toBe("2026-08-26T10:00:00.000Z");
    expect(second?.entries[0]?.value).toBe("2026-08-26T11:30:00.000Z");
  });

  it("accepted attachment_references：未显式选择 → not_selected；显式选择但无 egress allow → policy_denied", async () => {
    const { tenantId, seedSnapshot } = await seed();
    const snapshot = await seedSnapshot([{ key: "attachment_references", necessity: "accepted" }]);
    const binding = {
      agentContractSnapshotId: snapshot.id,
      agentContextDigest: snapshot.contextDigest,
    };
    const base = {
      tenantId,
      binding,
      executionSubject: { ...SUBJECT, tenantId },
      now: new Date(),
      platform: { attachmentRefs: ["attachment:ref-1"] },
    };
    const unselected = await buildBoundAgentInvocationContext(base);
    expect(unselected?.entries[0]).toMatchObject({
      supplied: false,
      omissionReason: "not_selected",
    });
    // 04 §7：数据型 Context 必须有明确 egress allow；external policy 默认 deny。
    const denied = await buildBoundAgentInvocationContext({
      ...base,
      selectedAcceptedContextKinds: ["attachment_references"],
    });
    expect(denied?.entries[0]).toMatchObject({
      supplied: false,
      omissionReason: "policy_denied",
    });
  });
});
