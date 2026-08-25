/**
 * submitAgentContractRegistration 应用命令测试 — 真实 MySQL（生产同构，禁止 fake-db）。
 *
 * 与 registerAgentContract（已存在的"Agent 先在、按 agentId 登记"命令）不同，本命令是
 * POST /admin/api/v1/agent-registrations 的应用事务：
 * - 身份是合同 agent.id（agentKey），调用方不得另行指定 agentId/agentKey/displayName；
 * - 单事务 find-or-create：Agent 缺失则创建 draft Agent（displayName=合同 name zh-CN、
 *   ownerUserId=登记的 user 主体），随后写入不可变快照 header + 子记录；
 * - 子行失败 → 新建的 Agent 一并回滚（不允许留下无合同的半成品 Agent）；
 * - Agent 已存在且非 retired/deleted → 复用，不覆盖 owner/lifecycle，每次显式登记产生新快照；
 * - service-only 主体不允许成为首次创建的 Agent owner；
 * - 并发/重复登记绝不产生两个 Agent（Agent_tenant_agentKey_uq 兜底）。
 *
 * 事实源：本切片冻结的 Public Agent Contract 登记流（agent-registrations 端点目标模型）。
 */
import { PublicAgentContractError } from "@/lib/agents/domain/public-agent-contract";
import {
  type AgentContractStore,
  mysqlAgentContractStore,
} from "@/lib/agents/persistence/agent-contract-store";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { hrAgentContract } from "@/lib/agents/test-support/hr-agent-contract";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { agentTable } from "@/lib/persistence/schema/agents";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

// 目标应用命令尚未实现 —— 本文件是该命令行为的先行冻结（预期 RED）。
import { createSubmitAgentContractRegistration } from "@/lib/agents/application/submit-agent-contract-registration";

const NOW = new Date("2026-08-25T00:00:00.000Z");

/** 协议事实是登记命令的独立显式字段（合同文件不含 protocol，禁止硬编码）。 */
const PROTOCOL = { type: "a2a", contractRevision: "0.3.0" } as const;

const CONTRACT_TABLES = [
  "AgentContractSnapshot",
  "AgentContractCapability",
  "AgentContractInvocationContext",
] as const;

beforeEach(async () => {
  await resetDatabase(db);
});

function contract(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(hrAgentContract)) as Record<string, unknown>;
}

async function seedUser(subject = "contract-registration-owner") {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: subject,
    email: `${subject}@example.com`,
    displayName: subject,
  });
  return { tenantId: tenant.id, identity };
}

async function countRows(table: string): Promise<number> {
  const [rows] = (await db.execute(
    sql.raw(`SELECT COUNT(*) AS n FROM \`${table}\``),
  )) as unknown as [{ n: number }[]];
  if (!rows || rows.length === 0) return -1;
  return Number(rows[0]!.n);
}

async function agentRows() {
  return db.select().from(agentTable);
}

function buildSubmit(overrides?: {
  newId?: () => string;
  newChildId?: () => string;
}) {
  return createSubmitAgentContractRegistration({
    store: mysqlAgentContractStore as AgentContractStore,
    now: () => NOW,
    ...overrides,
  });
}

describe("submitAgentContractRegistration", () => {
  it("happy path：Agent 缺失时单事务创建 draft Agent + 一个结构化快照", async () => {
    const { tenantId, identity } = await seedUser();
    let seq = 0;
    const submit = buildSubmit({
      newId: () => `contract-snapshot-${String(++seq).padStart(4, "0")}`,
    });

    const result = await submit({
      tenantId,
      protocol: PROTOCOL,
      contract: contract(),
      actor: { kind: "user", userId: identity.id },
    });

    // 投影：Agent 由合同 agent.id 决定身份，displayName 取合同 name zh-CN，lifecycle=draft
    expect(result.agent.agentKey).toBe("hr-assistant");
    expect(result.agent.displayName).toBe("企业人力智能助手");
    expect(result.agent.lifecycleState).toBe("draft");
    expect(result.agent.id).toEqual(expect.any(String));

    // 快照事实（真实 HR artifact）
    expect(result.contract.snapshotId).toBe("contract-snapshot-0001");
    expect(result.contract.contractVersion).toBe("1.0.0");
    expect(result.contract.publicAgentId).toBe("hr-assistant");
    expect(result.contract.publicAgentVersion).toBe("1.0.0");
    expect(result.contract.protocolType).toBe("a2a");
    expect(result.contract.protocolContractRevision).toBe("0.3.0");
    expect(result.contract.contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.contract.interaction).toEqual({
      streamingTransport: true,
      incrementalContent: false,
      inputRequired: true,
      resume: true,
      cancel: false,
      durableTaskRecovery: false,
      supportedLocales: ["zh-CN"],
    });
    expect(result.contract.capabilities.map((c) => c.key)).toEqual([
      "leave-and-attendance-service",
      "employee-self-service",
      "hr-policy-and-benefits-consultation",
      "hr-system-and-document-assistance",
    ]);
    expect(result.contract.invocationContexts.map((c) => c.key)).toEqual([
      "execution_subject",
      "timezone",
      "current_datetime",
      "locale",
      "conversation_summary",
      "attachment_references",
    ]);
    expect(result.contract.invocationContexts.map((c) => c.necessity)).toEqual([
      "preferred",
      "preferred",
      "preferred",
      "preferred",
      "preferred",
      "accepted",
    ]);
    expect(result.contract.resultContract.fields).toContain("answer");
    expect(result.contract.resultContract.errorCodes).toContain("identity_required");
    expect(result.contract.capturedAt).toEqual(NOW);
    expect(result.contract.createdBy).toBe(identity.id);

    // 落库：恰好一个 Agent，owner 是登记的 user 主体，快照挂在该 Agent 上
    expect(await countRows("Agent")).toBe(1);
    const [agentRow] = await agentRows();
    expect(agentRow!.id).toBe(result.agent.id);
    expect(agentRow!.agentKey).toBe("hr-assistant");
    expect(agentRow!.ownerUserId).toBe(identity.id);
    expect(agentRow!.lifecycleState).toBe("draft");

    const listed = await mysqlAgentContractStore.transaction((s) =>
      s.listContractSnapshotsByAgent(tenantId, result.agent.id),
    );
    expect(listed.map((h) => h.id)).toEqual([result.contract.snapshotId]);
  });

  it("Agent 已存在：复用同一 Agent、第二个不可变快照最新优先，不覆盖 owner/lifecycle", async () => {
    const { tenantId, identity } = await seedUser();
    const agent = await createAgent({
      tenantId,
      agentKey: "hr-assistant",
      displayName: "既有显示名（不得被登记覆盖）",
      ownerUserId: identity.id,
      lifecycleState: "enabled",
    });
    let seq = 0;
    const submit = buildSubmit({
      newId: () => `contract-snapshot-${String(++seq).padStart(4, "0")}`,
    });

    const first = await submit({
      tenantId,
      protocol: PROTOCOL,
      contract: contract(),
      actor: { kind: "user", userId: identity.id },
    });
    const second = await submit({
      tenantId,
      protocol: PROTOCOL,
      contract: contract(), // 同一合同再次显式登记 → 新快照，同一 Agent
      actor: { kind: "user", userId: identity.id },
    });

    expect(second.agent.id).toBe(agent.id);
    expect(second.contract.snapshotId).not.toBe(first.contract.snapshotId);
    expect(second.contract.contractDigest).toBe(first.contract.contractDigest);

    // 仍然只有一个 Agent；owner 与 lifecycle 未被覆盖
    expect(await countRows("Agent")).toBe(1);
    const [agentRow] = await agentRows();
    expect(agentRow!.id).toBe(agent.id);
    expect(agentRow!.ownerUserId).toBe(identity.id);
    expect(agentRow!.lifecycleState).toBe("enabled");
    expect(agentRow!.displayName).toBe("既有显示名（不得被登记覆盖）");

    // 最新优先的两个快照
    const listed = await mysqlAgentContractStore.transaction((s) =>
      s.listContractSnapshotsByAgent(tenantId, agent.id),
    );
    expect(listed.map((h) => h.id)).toEqual([
      second.contract.snapshotId,
      first.contract.snapshotId,
    ]);
  });

  it("校验 fail-closed：非法输入在写库前拒绝，Agent 与快照零行（不允许半成品 Agent）", async () => {
    const { tenantId, identity } = await seedUser();
    const submit = buildSubmit();

    const invalidVariants: Array<Record<string, unknown>> = [
      // secret/未知键
      { ...contract(), authorization: "Bearer secret" },
      // URL 字段（冻结 wire 不接受 runtime/agent card 类事实）
      { ...contract(), agent_card_url: "https://hr.example.com/card.json" },
      { ...contract(), runtime_endpoint: "https://hr.example.com/a2a" },
      // 破坏合同结构
      (() => {
        const broken = contract();
        broken.contract_version = undefined;
        return broken;
      })(),
      (() => {
        const emptyCaps = contract();
        emptyCaps.capabilities = [];
        return emptyCaps;
      })(),
    ];

    for (const invalid of invalidVariants) {
      await expect(
        submit({
          tenantId,
          protocol: PROTOCOL,
          contract: invalid,
          actor: { kind: "user", userId: identity.id },
        }),
      ).rejects.toThrow(PublicAgentContractError);
    }
    // protocol 缺失/非法同样拒绝
    for (const protocol of [undefined, null, { type: "", contractRevision: "0.3.0" }]) {
      const command: Record<string, unknown> = {
        tenantId,
        contract: contract(),
        actor: { kind: "user", userId: identity.id },
      };
      if (protocol !== undefined) command.protocol = protocol;
      await expect(submit(command as unknown as Parameters<typeof submit>[0])).rejects.toThrow();
    }

    expect(await countRows("Agent")).toBe(0);
    for (const table of CONTRACT_TABLES) {
      expect(await countRows(table)).toBe(0);
    }
  });

  it("子行冲突 → 整事务回滚：新建的 Agent 与快照/子行全部零行", async () => {
    const { tenantId, identity } = await seedUser();
    // newChildId 恒定 → 第二个子行起真实 PRIMARY KEY 冲突，由 MySQL 触发回滚。
    const submit = buildSubmit({
      newId: () => "rollback-header-id",
      newChildId: () => "rollback-child-id",
    });

    await expect(
      submit({
        tenantId,
        protocol: PROTOCOL,
        contract: contract(),
        actor: { kind: "user", userId: identity.id },
      }),
    ).rejects.toThrow();

    // 关键不变量：Agent 不允许留下无合同的半成品
    expect(await countRows("Agent")).toBe(0);
    for (const table of CONTRACT_TABLES) {
      expect(await countRows(table)).toBe(0);
    }
  });

  it("retired / 已删除 Agent 目标拒绝且不产生新快照", async () => {
    const { tenantId, identity } = await seedUser();
    const retiredAgent = await createAgent({
      tenantId,
      agentKey: "hr-assistant",
      displayName: "已退役",
      ownerUserId: identity.id,
      lifecycleState: "retired",
    });
    const submit = buildSubmit();

    await expect(
      submit({
        tenantId,
        protocol: PROTOCOL,
        contract: contract(),
        actor: { kind: "user", userId: identity.id },
      }),
    ).rejects.toThrow();

    expect(await countRows("AgentContractSnapshot")).toBe(0);
    expect(await countRows("Agent")).toBe(1); // 既有 retired Agent 原样保留

    // 已删除（deletedAt 非空）同样拒绝
    await resetDatabase(db);
    const { tenantId: tenantId2, identity: identity2 } = await seedUser("deleted-target-owner");
    const deletedAgent = await createAgent({
      tenantId: tenantId2,
      agentKey: "hr-assistant",
      displayName: "已删除",
      ownerUserId: identity2.id,
    });
    await db.execute(
      sql.raw(
        `UPDATE \`Agent\` SET deletedAt = '2026-08-25 00:00:00' WHERE id = '${deletedAgent.id}'`,
      ),
    );
    await expect(
      submit({
        tenantId: tenantId2,
        protocol: PROTOCOL,
        contract: contract(),
        actor: { kind: "user", userId: identity2.id },
      }),
    ).rejects.toThrow();
    expect(await countRows("AgentContractSnapshot")).toBe(0);
  });

  it("service-only 主体：首次创建 Agent 拒绝；已有 owner 的 Agent 允许登记且不写 service id", async () => {
    const { tenantId, identity } = await seedUser();
    const submit = buildSubmit();

    // 首次创建：service 主体不得成为 ownerUserId，整体拒绝且零行
    await expect(
      submit({
        tenantId,
        protocol: PROTOCOL,
        contract: contract(),
        actor: { kind: "service", serviceId: "cicd" },
      }),
    ).rejects.toThrow();
    expect(await countRows("Agent")).toBe(0);
    expect(await countRows("AgentContractSnapshot")).toBe(0);

    // Agent 已存在（user owner）时，service 主体可以登记快照，owner 不被覆盖
    const agent = await createAgent({
      tenantId,
      agentKey: "hr-assistant",
      displayName: "既有 Agent",
      ownerUserId: identity.id,
    });
    const result = await submit({
      tenantId,
      protocol: PROTOCOL,
      contract: contract(),
      actor: { kind: "service", serviceId: "cicd" },
    });
    expect(result.agent.id).toBe(agent.id);
    const [agentRow] = await agentRows();
    expect(agentRow!.ownerUserId).toBe(identity.id); // 绝不写 service id
    expect(await countRows("Agent")).toBe(1);
    expect(await countRows("AgentContractSnapshot")).toBe(1);
  });

  it("并发重复登记：绝不产生两个 Agent（Agent_tenant_agentKey_uq 兜底）", async () => {
    const { tenantId, identity } = await seedUser();
    let seq = 0;
    const submit = buildSubmit({
      newId: () => `contract-snapshot-${String(++seq).padStart(4, "0")}`,
    });

    const outcomes = await Promise.allSettled([
      submit({
        tenantId,
        protocol: PROTOCOL,
        contract: contract(),
        actor: { kind: "user", userId: identity.id },
      }),
      submit({
        tenantId,
        protocol: PROTOCOL,
        contract: contract(),
        actor: { kind: "user", userId: identity.id },
      }),
    ]);

    // 至少一个成功；无论交错如何，Agent 恒为 1 行
    expect(outcomes.some((o) => o.status === "fulfilled")).toBe(true);
    expect(await countRows("Agent")).toBe(1);
    const [agentRow] = await agentRows();
    expect(agentRow!.agentKey).toBe("hr-assistant");
    // 快照要么 1 要么 2（取决于赢者），都挂在唯一 Agent 上
    const listed = await mysqlAgentContractStore.transaction((s) =>
      s.listContractSnapshotsByAgent(tenantId, agentRow!.id),
    );
    expect(listed.length).toBeGreaterThanOrEqual(1);
    expect(listed.length).toBeLessThanOrEqual(2);
  });
});
