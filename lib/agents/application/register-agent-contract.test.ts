/**
 * registerAgentContract 应用命令测试 — 真实 MySQL（生产同构，禁止 fake-db）。
 *
 * 不变量：agent-contract.json 是 request-only 输入。登记产生不可变结构化快照：
 * - header 持久化每个合同事实的显式列（identity / 六 interaction 布尔 / digests / provenance）；
 * - capabilities 与 invocation contexts 是独立、有序、可查询的子记录；
 * - 绝不持久化整份源文件、原始合同对象或整节 JSON；
 * - 同一合同再次显式登记产生新快照修订，绝不更新旧快照；子行失败整体回滚；
 * - 跨租户/缺失 Agent 稳定报错且零行落库。
 *
 * 事实源：本切片冻结的 Public Agent Contract 目标模型。
 */
import {
  AgentContractAgentNotFoundError,
  AgentContractIdentityMismatchError,
  createRegisterAgentContract,
} from "@/lib/agents/application/register-agent-contract";
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
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-25T00:00:00.000Z");

/**
 * 协议事实来自登记命令的独立显式字段（agent-contract.json 不含 protocol，禁止硬编码）。
 */
const PROTOCOL = { type: "a2a", contractRevision: "0.3.0" } as const;

/** 冻结目标物理表名（结构化子记录表）。 */
const CONTRACT_TABLES = [
  "AgentContractSnapshot",
  "AgentContractCapability",
  "AgentContractInvocationContext",
] as const;

/** 任何情况下都不得出现在目标 schema 的整文件/整节 payload 列名。 */
const FORBIDDEN_COLUMN_PATTERNS = [
  "rawContract",
  "contractJson",
  "rawJson",
  "canonicalProviderDescriptor",
  "normalizedCapabilityManifest",
  "invocationContextContract",
] as const;

beforeEach(async () => {
  await resetDatabase(db);
});

/** 深拷贝 fixture。 */
function contract(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(hrAgentContract)) as Record<string, unknown>;
}

async function seedAgent() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "contract-registration-owner",
    email: "contract-registration-owner@example.com",
    displayName: "Contract Registration Owner",
  });
  // 目标 Agent 的 agentKey 必须与合同 agent.id（"hr-assistant"）一致
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: "hr-assistant",
    displayName: "Enterprise HR Assistant",
    ownerUserId: identity.id,
  });
  return { tenantId: tenant.id, identity, agent };
}

/** 统计目标表行数（表缺失时返回 -1，测试据此断言 RED/schema 未建）。 */
async function countRows(table: string): Promise<number> {
  const [rows] = (await db.execute(
    sql.raw(`SELECT COUNT(*) AS n FROM \`${table}\``),
  )) as unknown as [{ n: number }[]];
  if (!rows || rows.length === 0) return -1;
  return Number(rows[0]!.n);
}

async function tableColumns(table: string): Promise<string[]> {
  const [rows] = (await db.execute(
    sql`SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}`,
  )) as unknown as [{ c: string }[]];
  return (rows ?? []).map((r) => r.c);
}

/** 读取完整快照（header + 有序子记录），供断言结构化事实。 */
async function readSnapshot(store: AgentContractStore, tenantId: string, snapshotId: string) {
  return store.transaction(async (s) => {
    const header = await s.findContractSnapshotById(tenantId, snapshotId);
    if (!header) return null;
    const capabilities = await s.listCapabilities(tenantId, snapshotId);
    const contexts = await s.listInvocationContexts(tenantId, snapshotId);
    return { header, capabilities, contexts };
  });
}

describe("registerAgentContract", () => {
  it("happy path：登记 HR 合同，读回显式 header + 4 项有序 capabilities + 6 项有序 contexts", async () => {
    const { tenantId, identity, agent } = await seedAgent();
    const register = createRegisterAgentContract({
      store: mysqlAgentContractStore,
      now: () => NOW,
      newId: () => "contract-snapshot-0001",
    });

    const result = await register({
      tenantId,
      agentId: agent.id,
      protocol: PROTOCOL, // agent-contract.json 不含 protocol —— 命令字段显式提供，禁止硬编码
      contract: contract(),
      createdBy: identity.id,
    });

    expect(result.snapshotId).toBe("contract-snapshot-0001");
    expect(result.contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const snapshot = await readSnapshot(mysqlAgentContractStore, tenantId, result.snapshotId);
    expect(snapshot).not.toBeNull();
    const { header, capabilities, contexts } = snapshot!;

    // header：显式标量事实，而非 JSON 聚合（真实 HR artifact 事实）
    expect(header.contractVersion).toBe("1.0.0");
    expect(header.publicAgentId).toBe("hr-assistant");
    expect(header.publicAgentVersion).toBe("1.0.0");
    expect(header.agentNameZhCn).toBe("企业人力智能助手");
    expect(header.agentNameEn).toBe("Enterprise HR Assistant");
    expect(header.protocolType).toBe("a2a");
    expect(header.protocolContractRevision).toBe("0.3.0");
    expect(header.streamingTransport).toBe(true);
    expect(header.incrementalContent).toBe(false);
    expect(header.inputRequired).toBe(true);
    expect(header.resume).toBe(true);
    expect(header.cancel).toBe(false);
    expect(header.durableTaskRecovery).toBe(false); // 显式 false 必须往返保留
    expect(header.supportedLocales).toEqual(["zh-CN"]);
    expect(header.resultFields).toEqual([
      "request_id",
      "status",
      "answer",
      "result_type",
      "data",
      "actions",
      "error_code",
      "retryable",
      "agent_name",
      "agent_version",
    ]);
    expect(header.errorCodes).toEqual([
      "identity_required",
      "identity_unverified",
      "input_required",
      "not_found",
      "rejected",
      "temporarily_unavailable",
      "failed",
      "cancelled",
      "contract_error",
    ]);
    expect(header.createdBy).toBe(identity.id);
    expect(header.capturedAt).toEqual(NOW);

    // header 不得携带原始合同/整节 payload
    const serialized = JSON.stringify(header);
    expect(serialized).not.toContain("contract_version");
    expect(serialized).not.toContain("invocation_context");
    expect(serialized).not.toContain("result_contract");

    // capabilities：独立有序子记录（真实 artifact 顺序与中英文文本）
    expect(capabilities.map((c) => c.key)).toEqual([
      "leave-and-attendance-service",
      "employee-self-service",
      "hr-policy-and-benefits-consultation",
      "hr-system-and-document-assistance",
    ]);
    expect(capabilities[0]!.nameZhCn).toBe("假勤与请假服务");
    expect(capabilities[0]!.nameEn).toBe("Leave and Attendance Service");
    expect(capabilities[0]!.descriptionZhCn).toContain("请假申请");
    expect(capabilities[0]!.descriptionEn).toContain("Leave requests");
    // 当前 artifact 无 tags/examples/input_modes/output_modes —— 空数组，不虚构
    expect(capabilities[0]!.tags).toEqual([]);
    expect(capabilities[0]!.examples).toEqual([]);
    expect(capabilities[0]!.inputModes).toEqual([]);
    expect(capabilities[0]!.outputModes).toEqual([]);

    // contexts：独立有序子记录，含 necessity / 可选字段
    expect(contexts.map((c) => c.key)).toEqual([
      "execution_subject",
      "timezone",
      "current_datetime",
      "locale",
      "conversation_summary",
      "attachment_references",
    ]);
    expect(contexts.map((c) => c.necessity)).toEqual([
      "preferred",
      "preferred",
      "preferred",
      "preferred",
      "preferred",
      "accepted",
    ]);
    expect(contexts[0]!.nameZhCn).toBe("执行主体");
    expect(contexts[0]!.descriptionZhCn).toContain("可信调用者身份");
    expect(contexts[0]!.appliesTo).toEqual([
      "leave-and-attendance-service",
      "employee-self-service",
    ]);
    expect(contexts[5]!.appliesTo).toEqual(["hr-system-and-document-assistance"]);
    expect(contexts[1]!.appliesTo).toBeNull();
    // wire 上无 trust_requirement / declaration_source —— trustRequirement 为 null；
    // declarationSource 是登记侧系统 provenance（合同由 provider 供给），非 wire 事实
    expect(contexts[0]!.trustRequirement).toBeNull();
    expect(contexts[0]!.declarationSource).toBe("provider_declared");

    // 子记录查询本身强制租户过滤，不依赖调用方先查 header 的约定。
    const crossTenantChildren = await mysqlAgentContractStore.transaction(async (s) => ({
      capabilities: await s.listCapabilities("other-tenant", result.snapshotId),
      contexts: await s.listInvocationContexts("other-tenant", result.snapshotId),
    }));
    expect(crossTenantChildren.capabilities).toEqual([]);
    expect(crossTenantChildren.contexts).toEqual([]);
  });

  it("目标 schema 无整文件/整节 payload 列，且子记录表存在", async () => {
    // 冻结目标模型要求三张结构化表存在
    for (const table of CONTRACT_TABLES) {
      const columns = await tableColumns(table);
      expect(columns.length, `表 ${table} 应存在且含显式列`).toBeGreaterThan(0);
      for (const forbidden of FORBIDDEN_COLUMN_PATTERNS) {
        expect(columns, `${table} 不得含整节 payload 列 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("校验 fail-closed：非法合同拒绝且零行落库", async () => {
    const { tenantId, identity, agent } = await seedAgent();
    const register = createRegisterAgentContract({
      store: mysqlAgentContractStore,
      now: () => NOW,
    });

    const invalidVariants: Array<Record<string, unknown>> = [
      { ...contract(), authorization: "Bearer secret" },
      (() => {
        const c = contract();
        c.contract_version = undefined;
        return c;
      })(),
      (() => {
        const c = contract();
        c.capabilities = [];
        return c;
      })(),
      (() => {
        const c = contract();
        (c.interaction as Record<string, unknown>).resume = undefined; // HR 现行 artifact 的遗漏
        return c;
      })(),
      (() => {
        const c = contract();
        (c.capabilities as Record<string, unknown>[])[0]!.function = { name: "leave_query" };
        return c;
      })(),
    ];

    for (const invalid of invalidVariants) {
      await expect(
        register({
          tenantId,
          agentId: agent.id,
          protocol: PROTOCOL,
          contract: invalid,
          createdBy: identity.id,
        }),
      ).rejects.toThrow(PublicAgentContractError);
    }

    for (const table of CONTRACT_TABLES) {
      expect(await countRows(table)).toBe(0);
    }
  });

  it("secrets 类未知键拒绝，且任何已登记数据读回不含 secret 值", async () => {
    const { tenantId, identity, agent } = await seedAgent();
    const register = createRegisterAgentContract({
      store: mysqlAgentContractStore,
      now: () => NOW,
    });

    for (const secretKey of ["authorization", "client_secret", "runtime_api_key"]) {
      const poisoned = { ...contract(), [secretKey]: "super-secret-value" };
      await expect(
        register({
          tenantId,
          agentId: agent.id,
          protocol: PROTOCOL,
          contract: poisoned,
          createdBy: identity.id,
        }),
      ).rejects.toThrow(PublicAgentContractError);
    }

    // 正常登记一次后，读回数据不携带任何 secret 值
    const result = await register({
      tenantId,
      agentId: agent.id,
      protocol: PROTOCOL,
      contract: contract(),
      createdBy: identity.id,
    });
    const snapshot = await readSnapshot(mysqlAgentContractStore, tenantId, result.snapshotId);
    expect(JSON.stringify(snapshot)).not.toContain("super-secret-value");
  });

  it("子行冲突 → 单事务回滚，header 与全部子行零行", async () => {
    const { tenantId, identity, agent } = await seedAgent();
    // newChildId 注入真实子行主键冲突；由 MySQL PRIMARY KEY 触发并验证整事务回滚。
    const register = createRegisterAgentContract({
      store: mysqlAgentContractStore,
      now: () => NOW,
      newId: () => "rollback-header-id",
      newChildId: () => "rollback-child-id",
    });

    await expect(
      register({
        tenantId,
        agentId: agent.id,
        protocol: PROTOCOL,
        contract: contract(),
        createdBy: identity.id,
      }),
    ).rejects.toThrow();

    for (const table of CONTRACT_TABLES) {
      expect(await countRows(table)).toBe(0);
    }
  });

  it("重复显式登记：两个不可变快照 id，首个不变；digest 相同", async () => {
    const { tenantId, identity, agent } = await seedAgent();
    let seq = 0;
    const register = createRegisterAgentContract({
      store: mysqlAgentContractStore,
      now: () => NOW,
      newId: () => `contract-snapshot-${String(++seq).padStart(4, "0")}`,
    });

    const first = await register({
      tenantId,
      agentId: agent.id,
      protocol: PROTOCOL,
      contract: contract(),
      createdBy: identity.id,
    });
    const second = await register({
      tenantId,
      agentId: agent.id,
      protocol: PROTOCOL,
      contract: contract(), // 同一合同再次显式登记
      createdBy: identity.id,
    });

    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(second.contractDigest).toBe(first.contractDigest);

    // 首个快照一字不差
    const firstSnapshot = await readSnapshot(mysqlAgentContractStore, tenantId, first.snapshotId);
    expect(firstSnapshot!.header.id).toBe(first.snapshotId);
    expect(firstSnapshot!.capabilities).toHaveLength(4);
    expect(firstSnapshot!.contexts).toHaveLength(6);

    // list 最新优先，与 detail 一致
    const listed = await mysqlAgentContractStore.transaction((s) =>
      s.listContractSnapshotsByAgent(tenantId, agent.id),
    );
    expect(listed.map((h) => h.id)).toEqual([second.snapshotId, first.snapshotId]);
    for (const h of listed) {
      const detail = await readSnapshot(mysqlAgentContractStore, tenantId, h.id);
      expect(detail!.header.contractDigest).toBe(h.contractDigest);
      expect(detail!.header.publicAgentId).toBe(h.publicAgentId);
      expect(detail!.capabilities.map((c) => c.key)).toHaveLength(4);
    }
  });

  it("protocol 命令字段 fail-closed：缺失/null/空 type 或 revision 拒绝且零行", async () => {
    const { tenantId, identity, agent } = await seedAgent();
    const register = createRegisterAgentContract({
      store: mysqlAgentContractStore,
      now: () => NOW,
    });

    const invalidProtocols: Array<Record<string, unknown> | null | undefined> = [
      undefined, // 整个 protocol 字段缺失
      null,
      { type: null, contractRevision: "0.3.0" },
      { type: "", contractRevision: "0.3.0" },
      { type: "a2a", contractRevision: null },
      { type: "a2a", contractRevision: "" },
    ];

    for (const protocol of invalidProtocols) {
      const command: Record<string, unknown> = {
        tenantId,
        agentId: agent.id,
        contract: contract(),
        createdBy: identity.id,
      };
      if (protocol !== undefined) command.protocol = protocol;
      await expect(
        register(command as unknown as Parameters<typeof register>[0]),
      ).rejects.toThrow();
    }

    for (const table of CONTRACT_TABLES) {
      expect(await countRows(table)).toBe(0);
    }
  });

  it("身份不匹配：合同 agent.id ≠ 目标 Agent.agentKey 稳定报错且零行", async () => {
    const { tenantId, identity } = await seedAgent();
    // 同租户下另建一个 agentKey 不同的 Agent 作为错误登记目标
    const wrongTarget = await createAgent({
      tenantId,
      agentKey: "different-agent",
      displayName: "Different Agent",
      ownerUserId: identity.id,
    });
    const register = createRegisterAgentContract({
      store: mysqlAgentContractStore,
      now: () => NOW,
    });

    // 合同 agent.id = "hr-assistant"，目标 Agent.agentKey = "different-agent"
    await expect(
      register({
        tenantId,
        agentId: wrongTarget.id,
        protocol: PROTOCOL,
        contract: contract(),
        createdBy: identity.id,
      }),
    ).rejects.toThrow(AgentContractIdentityMismatchError);

    for (const table of CONTRACT_TABLES) {
      expect(await countRows(table)).toBe(0);
    }
  });

  it("租户边界：缺失/跨租户 Agent 稳定报错且零行", async () => {
    const { tenantId, identity, agent } = await seedAgent();
    const register = createRegisterAgentContract({
      store: mysqlAgentContractStore,
      now: () => NOW,
    });

    await expect(
      register({
        tenantId,
        agentId: "missing-agent-id",
        protocol: PROTOCOL,
        contract: contract(),
        createdBy: identity.id,
      }),
    ).rejects.toThrow(AgentContractAgentNotFoundError);

    await expect(
      register({
        tenantId: "other-tenant",
        agentId: agent.id, // 跨租户引用他人 Agent
        protocol: PROTOCOL,
        contract: contract(),
        createdBy: identity.id,
      }),
    ).rejects.toThrow(AgentContractAgentNotFoundError);

    for (const table of CONTRACT_TABLES) {
      expect(await countRows(table)).toBe(0);
    }
  });
});
