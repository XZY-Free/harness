import { DEFAULT_USER_ID } from "@/lib/constants";
/**
 * S13-C03 agent_skill 域迁移转换器集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - Skill 转换器：正常迁移、name 为空异常、状态映射（active→enabled/archived→retired）、
 *   source 映射（local→local/capability-market→capability_market）
 * - SkillVersion 转换器：正常迁移、commitSha 为空异常、状态映射（draft/active/archived）
 * - SkillSyncMapping 转换器：正常迁移、localSkillId 不存在异常、syncState 映射
 * - Agent 转换器：正常迁移（V11Agent + V11AgentRevision）、name 为空异常
 * - SubagentDefinition 转换器：正常迁移、无 Agent 引用异常、V11Agent 未迁移异常
 * - ProviderProfile 转换器：正常迁移（V11Connection + V11CredentialRef）、name 为空异常
 * - 端到端 agent_skill 域迁移：6 张表顺序执行
 * - 幂等性：二次运行跳过已迁移记录
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import {
  agent as Agent,
  providerProfile as ProviderProfile,
  skill as Skill,
  skillSyncMapping as SkillSyncMapping,
  skillVersion as SkillVersion,
  subagentDefinition as SubagentDefinition,
} from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { createExecutionRunner } from "@/lib/v11/migration/migration-runner";
import { InMemoryMigrationStateStore } from "@/lib/v11/migration/migration-state";
import { createAgentSkillTransformers } from "@/lib/v11/migration/transformers/agent-skill";
import { getV11TableRegistry } from "@/lib/v11/migration/v11-table-registry";
import { v11Agent, v11AgentRevision } from "@/lib/v11/schema/agent";
import { v11Skill, v11SkillVersion } from "@/lib/v11/schema/skill";
import { v11Connection, v11CredentialRef } from "@/lib/v11/schema/tool";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

// ═══════════════════════════════════════════════════════════
// 1. Skill 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 Skill 转换器", () => {
  it("正常 Skill 迁移为 V11Skill", async () => {
    await db.insert(Skill).values({
      id: "skill-t-001",
      name: "build-from-idea",
      description: "从想法构建项目",
      status: "active",
      source: "local",
      visibility: "public",
      ownerUserId: "user-t-001",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("agent_skill");

    const skillTable = result.tables.find((t) => t.sourceTable === "Skill");
    expect(skillTable?.sourceCount).toBe(1);
    expect(skillTable?.targetCount).toBe(1);
    expect(skillTable?.anomalyCount).toBe(0);

    const [v11SkillRow] = await db
      .select()
      .from(v11Skill)
      .where(eq(v11Skill.id, "skill-t-001"))
      .limit(1);
    expect(v11SkillRow).toBeDefined();
    expect(v11SkillRow?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(v11SkillRow?.skillKey).toBe("build-from-idea");
    expect(v11SkillRow?.displayName).toBe("build-from-idea");
    expect(v11SkillRow?.description).toBe("从想法构建项目");
    expect(v11SkillRow?.ownerUserId).toBe("user-t-001");
    expect(v11SkillRow?.lifecycleState).toBe("enabled");
    expect(v11SkillRow?.visibilityScope).toBe("tenant");
    expect(v11SkillRow?.sourceType).toBe("local");
  });

  it("name 为空时入异常队列", async () => {
    await db.insert(Skill).values({
      id: "skill-t-002",
      name: "",
      status: "active",
      source: "local",
      visibility: "public",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("agent_skill");

    const skillTable = result.tables.find((t) => t.sourceTable === "Skill");
    expect(skillTable?.anomalyCount).toBe(1);
    expect(skillTable?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("Skill");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toContain("Skill.name 为空");
  });

  it("状态映射：active→enabled，archived→retired", async () => {
    await db.insert(Skill).values({
      id: "skill-t-003",
      name: "active-skill",
      status: "active",
      source: "local",
      visibility: "public",
    });
    await db.insert(Skill).values({
      id: "skill-t-004",
      name: "archived-skill",
      status: "archived",
      source: "local",
      visibility: "public",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("agent_skill");

    const [active] = await db
      .select()
      .from(v11Skill)
      .where(eq(v11Skill.id, "skill-t-003"))
      .limit(1);
    expect(active?.lifecycleState).toBe("enabled");

    const [archived] = await db
      .select()
      .from(v11Skill)
      .where(eq(v11Skill.id, "skill-t-004"))
      .limit(1);
    expect(archived?.lifecycleState).toBe("retired");
  });

  it("来源映射：capability-market→capability_market", async () => {
    await db.insert(Skill).values({
      id: "skill-t-005",
      name: "market-skill",
      status: "active",
      source: "capability-market",
      visibility: "internal",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("agent_skill");

    const [row] = await db.select().from(v11Skill).where(eq(v11Skill.id, "skill-t-005")).limit(1);
    expect(row?.sourceType).toBe("capability_market");
    expect(row?.visibilityScope).toBe("internal");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. SkillVersion 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 SkillVersion 转换器", () => {
  it("正常 SkillVersion 迁移为 V11SkillVersion", async () => {
    await db.insert(Skill).values({
      id: "skill-sv-001",
      name: "skill-for-version",
      status: "active",
      source: "local",
      visibility: "public",
    });
    await db.insert(SkillVersion).values({
      id: "sv-t-001",
      skillId: "skill-sv-001",
      version: 1,
      promptTemplate: "You are a helpful assistant",
      commitSha: "abc123def456",
      status: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("agent_skill");

    const svTable = result.tables.find((t) => t.sourceTable === "SkillVersion");
    expect(svTable?.sourceCount).toBe(1);
    expect(svTable?.targetCount).toBe(1);
    expect(svTable?.anomalyCount).toBe(0);

    const [v11Sv] = await db
      .select()
      .from(v11SkillVersion)
      .where(eq(v11SkillVersion.id, "sv-t-001"))
      .limit(1);
    expect(v11Sv).toBeDefined();
    expect(v11Sv?.skillId).toBe("skill-sv-001");
    expect(v11Sv?.versionNo).toBe(1);
    expect(v11Sv?.contentRef).toBe("abc123def456");
    expect(v11Sv?.contentHash).toMatch(/^sha256:[a-f0-9]+$/);
    expect(v11Sv?.revisionState).toBe("published");
    expect(v11Sv?.sourceType).toBe("local");
    expect(v11Sv?.manifestJson).toBeDefined();
  });

  it("commitSha 为空时入异常队列", async () => {
    await db.insert(Skill).values({
      id: "skill-sv-002",
      name: "skill-no-sha",
      status: "active",
      source: "local",
      visibility: "public",
    });
    await db.insert(SkillVersion).values({
      id: "sv-t-002",
      skillId: "skill-sv-002",
      version: 1,
      promptTemplate: "Some prompt",
      commitSha: "",
      status: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("agent_skill");

    const svTable = result.tables.find((t) => t.sourceTable === "SkillVersion");
    expect(svTable?.anomalyCount).toBe(1);

    const anomalies = store.getAnomalies("SkillVersion");
    expect(anomalies[0]?.reason).toContain("commitSha 为空");
  });

  it("状态映射：draft→draft，active→published，archived→withdrawn", async () => {
    await db.insert(Skill).values({
      id: "skill-sv-003",
      name: "skill-status-map",
      status: "active",
      source: "local",
      visibility: "public",
    });
    await db.insert(SkillVersion).values({
      id: "sv-draft",
      skillId: "skill-sv-003",
      version: 1,
      commitSha: "sha-draft",
      status: "draft",
    });
    await db.insert(SkillVersion).values({
      id: "sv-active",
      skillId: "skill-sv-003",
      version: 2,
      commitSha: "sha-active",
      status: "active",
    });
    await db.insert(SkillVersion).values({
      id: "sv-archived",
      skillId: "skill-sv-003",
      version: 3,
      commitSha: "sha-archived",
      status: "archived",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("agent_skill");

    const [draft] = await db
      .select()
      .from(v11SkillVersion)
      .where(eq(v11SkillVersion.id, "sv-draft"))
      .limit(1);
    expect(draft?.revisionState).toBe("draft");

    const [active] = await db
      .select()
      .from(v11SkillVersion)
      .where(eq(v11SkillVersion.id, "sv-active"))
      .limit(1);
    expect(active?.revisionState).toBe("published");

    const [archived] = await db
      .select()
      .from(v11SkillVersion)
      .where(eq(v11SkillVersion.id, "sv-archived"))
      .limit(1);
    expect(archived?.revisionState).toBe("withdrawn");
  });
});

// ═══════════════════════════════════════════════════════════
// 3. SkillSyncMapping 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 SkillSyncMapping 转换器", () => {
  it("正常 SkillSyncMapping 迁移为 V11SkillVersion (capability_market)", async () => {
    await db.insert(Skill).values({
      id: "skill-sync-001",
      name: "synced-skill",
      status: "active",
      source: "capability-market",
      visibility: "public",
    });
    await db.insert(SkillSyncMapping).values({
      id: "ssm-t-001",
      source: "capability-market",
      remoteAssetId: "asset-001",
      remoteName: "remote-skill",
      remoteDisplayName: "Remote Skill",
      remoteVersion: "1.0",
      localSkillId: "skill-sync-001",
      localName: "synced-skill",
      syncState: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("agent_skill");

    const ssmTable = result.tables.find((t) => t.sourceTable === "SkillSyncMapping");
    expect(ssmTable?.sourceCount).toBe(1);
    expect(ssmTable?.targetCount).toBe(1);
    expect(ssmTable?.anomalyCount).toBe(0);

    const versions = await db
      .select()
      .from(v11SkillVersion)
      .where(eq(v11SkillVersion.skillId, "skill-sync-001"));
    const syncVersion = versions.find((v) => v.sourceType === "capability_market");
    expect(syncVersion).toBeDefined();
    expect(syncVersion?.sourceRef).toBe("asset-001");
    expect(syncVersion?.contentRef).toBe("asset-001");
    expect(syncVersion?.revisionState).toBe("published");
    expect(syncVersion?.sourceType).toBe("capability_market");
    expect(syncVersion?.contentHash).toMatch(/^sha256:[a-f0-9]+$/);
  });

  it("localSkillId 不存在时入异常队列", async () => {
    // 插入 name 为空的 Skill（不会迁移到 V11Skill），作为 SkillSyncMapping 的 localSkillId
    // SkillSyncMapping.localSkillId 有 FK 约束指向 Skill.id，故必须在旧表存在；
    // 但 name 为空导致 Skill 转换器入异常队列，V11Skill 不会被创建。
    await db.insert(Skill).values({
      id: "skill-empty-name",
      name: "",
      status: "active",
      source: "local",
      visibility: "public",
    });
    await db.insert(SkillSyncMapping).values({
      id: "ssm-t-002",
      source: "capability-market",
      remoteAssetId: "asset-002",
      localSkillId: "skill-empty-name",
      syncState: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("agent_skill");

    const ssmTable = result.tables.find((t) => t.sourceTable === "SkillSyncMapping");
    expect(ssmTable?.anomalyCount).toBe(1);

    const anomalies = store.getAnomalies("SkillSyncMapping");
    expect(anomalies[0]?.reason).toContain("skill-empty-name 不存在");
  });

  it("syncState 映射：active→published，blocked→withdrawn，error→draft", async () => {
    await db.insert(Skill).values({
      id: "skill-sync-003",
      name: "sync-state-skill",
      status: "active",
      source: "capability-market",
      visibility: "public",
    });

    const states = [
      { id: "ssm-active", state: "active", expected: "published" },
      { id: "ssm-blocked", state: "blocked", expected: "withdrawn" },
      { id: "ssm-error", state: "error", expected: "draft" },
    ];

    for (const s of states) {
      await db.insert(SkillSyncMapping).values({
        id: s.id,
        source: "capability-market",
        remoteAssetId: `asset-${s.id}`,
        localSkillId: "skill-sync-003",
        syncState: s.state as "active" | "blocked" | "error",
      });
    }

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("agent_skill");

    const versions = await db
      .select()
      .from(v11SkillVersion)
      .where(eq(v11SkillVersion.skillId, "skill-sync-003"));

    const syncVersions = versions.filter((v) => v.sourceType === "capability_market");
    expect(syncVersions.length).toBe(3);

    const activeV = syncVersions.find((v) => v.sourceRef === "asset-ssm-active");
    expect(activeV?.revisionState).toBe("published");
    const blockedV = syncVersions.find((v) => v.sourceRef === "asset-ssm-blocked");
    expect(blockedV?.revisionState).toBe("withdrawn");
    const errorV = syncVersions.find((v) => v.sourceRef === "asset-ssm-error");
    expect(errorV?.revisionState).toBe("draft");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Agent 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 Agent 转换器", () => {
  it("正常 Agent 迁移为 V11Agent + V11AgentRevision", async () => {
    await db.insert(Agent).values({
      id: "agent-t-001",
      name: "finance-agent",
      description: "财务助手",
      model: "gpt-4",
      config: {},
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("agent_skill");

    const agentTable = result.tables.find((t) => t.sourceTable === "Agent");
    expect(agentTable?.sourceCount).toBe(1);
    expect(agentTable?.targetCount).toBe(2); // V11Agent + V11AgentRevision
    expect(agentTable?.anomalyCount).toBe(0);

    const [v11AgentRow] = await db
      .select()
      .from(v11Agent)
      .where(eq(v11Agent.id, "agent-t-001"))
      .limit(1);
    expect(v11AgentRow).toBeDefined();
    expect(v11AgentRow?.agentKey).toBe("finance-agent");
    expect(v11AgentRow?.displayName).toBe("finance-agent");
    expect(v11AgentRow?.description).toBe("财务助手");
    expect(v11AgentRow?.ownerUserId).toBe(DEFAULT_USER_ID);
    expect(v11AgentRow?.lifecycleState).toBe("enabled");
    expect(v11AgentRow?.currentRevisionId).toBeTruthy();

    const [revision] = await db
      .select()
      .from(v11AgentRevision)
      .where(eq(v11AgentRevision.agentId, "agent-t-001"))
      .limit(1);
    expect(revision).toBeDefined();
    expect(revision?.revisionNo).toBe(1);
    expect(revision?.revisionState).toBe("published");
    expect(revision?.modelPolicyJson).toEqual({ model: "gpt-4", skillId: null });
    expect(revision?.delegationPolicyJson).toEqual({});
  });

  it("name 为空时入异常队列", async () => {
    await db.insert(Agent).values({
      id: "agent-t-002",
      name: "",
      model: "gpt-4",
      config: {},
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("agent_skill");

    const agentTable = result.tables.find((t) => t.sourceTable === "Agent");
    expect(agentTable?.anomalyCount).toBe(1);

    const anomalies = store.getAnomalies("Agent");
    expect(anomalies[0]?.reason).toContain("Agent.name 为空");
  });
});

// ═══════════════════════════════════════════════════════════
// 5. SubagentDefinition 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 SubagentDefinition 转换器", () => {
  it("正常 SubagentDefinition 迁移为 V11AgentRevision（delegationPolicyJson）", async () => {
    const definitionId = "subdef-t-001";
    await db.insert(Agent).values({
      id: "agent-sub-001",
      name: "parent-agent",
      model: "gpt-4",
      config: { definitionId },
    });
    await db.insert(SubagentDefinition).values({
      id: definitionId,
      name: "explorer-sub",
      role: "explore",
      allowedTools: ["read_file", "list_dir"],
      contextPolicy: { includeHistory: true },
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("agent_skill");

    const subTable = result.tables.find((t) => t.sourceTable === "SubagentDefinition");
    expect(subTable?.sourceCount).toBe(1);
    expect(subTable?.targetCount).toBe(1);
    expect(subTable?.anomalyCount).toBe(0);

    const revisions = await db
      .select()
      .from(v11AgentRevision)
      .where(eq(v11AgentRevision.agentId, "agent-sub-001"));
    // Agent 迁移创建 revision 1，SubagentDefinition 创建 revision 2
    expect(revisions.length).toBe(2);

    const subRevision = revisions.find((r) => r.revisionNo === 2);
    expect(subRevision).toBeDefined();
    expect(subRevision?.delegationPolicyJson).toEqual({
      policyJson: ["read_file", "list_dir"],
      source: "subagent_definition",
      definitionId,
      role: "explore",
    });
    expect(subRevision?.revisionState).toBe("draft");
  });

  it("无 Agent 引用时入异常队列", async () => {
    await db.insert(SubagentDefinition).values({
      id: "subdef-t-002",
      name: "orphan-sub",
      role: "researcher",
      allowedTools: ["search"],
      contextPolicy: {},
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("agent_skill");

    const subTable = result.tables.find((t) => t.sourceTable === "SubagentDefinition");
    expect(subTable?.anomalyCount).toBe(1);

    const anomalies = store.getAnomalies("SubagentDefinition");
    expect(anomalies[0]?.reason).toContain("无 Agent 引用");
  });

  it("V11Agent 未迁移时入异常队列", async () => {
    const definitionId = "subdef-t-003";
    // 插入 Agent 引用此 SubagentDefinition，但不迁移 Agent（直接调用转换器）
    await db.insert(Agent).values({
      id: "agent-sub-003",
      name: "unmigrated-agent",
      model: "gpt-4",
      config: { definitionId },
    });
    await db.insert(SubagentDefinition).values({
      id: definitionId,
      name: "sub-no-v11",
      role: "verifier",
      allowedTools: ["check"],
      contextPolicy: {},
    });

    // 直接调用转换器，不经过 Agent 迁移
    const transformers = createAgentSkillTransformers();
    const transformer = transformers.get("SubagentDefinition");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const transformResult = await transformer({
      id: definitionId,
      name: "sub-no-v11",
      role: "verifier",
      allowedTools: ["check"],
      contextPolicy: {},
    });

    expect(transformResult.targets).toEqual([]);
    expect(transformResult.anomalyReason).toContain("未迁移");
  });
});

// ═══════════════════════════════════════════════════════════
// 6. ProviderProfile 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 ProviderProfile 转换器", () => {
  it("正常 ProviderProfile 迁移为 V11Connection + V11CredentialRef", async () => {
    await db.insert(ProviderProfile).values({
      id: "pp-t-001",
      name: "openai-provider",
      baseUrl: "https://api.openai.com/v1",
      apiKeyRef: "OPENAI_API_KEY",
      isDefault: true,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("agent_skill");

    const ppTable = result.tables.find((t) => t.sourceTable === "ProviderProfile");
    expect(ppTable?.sourceCount).toBe(1);
    expect(ppTable?.targetCount).toBe(2); // V11Connection + V11CredentialRef
    expect(ppTable?.anomalyCount).toBe(0);

    const [conn] = await db
      .select()
      .from(v11Connection)
      .where(eq(v11Connection.id, "pp-t-001"))
      .limit(1);
    expect(conn).toBeDefined();
    expect(conn?.connectionKey).toBe("openai-provider");
    expect(conn?.connectionType).toBe("http");
    expect(conn?.endpointRef).toBe("https://api.openai.com/v1");
    expect(conn?.authMethod).toBe("api_key");
    expect(conn?.ownerUserId).toBe(DEFAULT_USER_ID);
    expect(conn?.lifecycleState).toBe("enabled");

    const [cred] = await db
      .select()
      .from(v11CredentialRef)
      .where(eq(v11CredentialRef.connectionId, "pp-t-001"))
      .limit(1);
    expect(cred).toBeDefined();
    expect(cred?.provider).toBe("env");
    expect(cred?.vaultRef).toBe("OPENAI_API_KEY");
    expect(cred?.fingerprint).toMatch(/^sha256:[a-f0-9]+$/);
    expect(cred?.lifecycleState).toBe("active");
  });

  it("name 为空时入异常队列", async () => {
    await db.insert(ProviderProfile).values({
      id: "pp-t-002",
      name: "",
      baseUrl: "https://api.example.com",
      apiKeyRef: "API_KEY",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("agent_skill");

    const ppTable = result.tables.find((t) => t.sourceTable === "ProviderProfile");
    expect(ppTable?.anomalyCount).toBe(1);

    const anomalies = store.getAnomalies("ProviderProfile");
    expect(anomalies[0]?.reason).toContain("ProviderProfile.name 为空");
  });
});

// ═══════════════════════════════════════════════════════════
// 7. 端到端 agent_skill 域迁移
// ═══════════════════════════════════════════════════════════

describe("S13-C03 agent_skill 域端到端迁移", () => {
  it("完整 agent_skill 域迁移：6 张表顺序执行", async () => {
    // 准备数据
    await db.insert(Skill).values({
      id: "skill-e2e",
      name: "e2e-skill",
      description: "端到端测试 Skill",
      status: "active",
      source: "local",
      visibility: "public",
      ownerUserId: DEFAULT_USER_ID,
    });
    await db.insert(SkillVersion).values({
      id: "sv-e2e",
      skillId: "skill-e2e",
      version: 1,
      promptTemplate: "E2E prompt",
      commitSha: "e2e-commit-sha",
      status: "active",
    });
    await db.insert(SkillSyncMapping).values({
      id: "ssm-e2e",
      source: "capability-market",
      remoteAssetId: "e2e-asset",
      localSkillId: "skill-e2e",
      syncState: "active",
    });
    await db.insert(Agent).values({
      id: "agent-e2e",
      name: "e2e-agent",
      description: "端到端测试 Agent",
      model: "gpt-4",
      config: { definitionId: "subdef-e2e" },
    });
    await db.insert(SubagentDefinition).values({
      id: "subdef-e2e",
      name: "e2e-sub",
      role: "explore",
      allowedTools: ["tool-a"],
      contextPolicy: {},
    });
    await db.insert(ProviderProfile).values({
      id: "pp-e2e",
      name: "e2e-provider",
      baseUrl: "https://e2e.example.com",
      apiKeyRef: "E2E_API_KEY",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createAgentSkillTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("agent_skill");

    expect(result.totalAnomalyCount).toBe(0);

    // Skill: 1 目标
    const skillTable = result.tables.find((t) => t.sourceTable === "Skill");
    expect(skillTable?.targetCount).toBe(1);

    // SkillVersion: 1 目标
    const svTable = result.tables.find((t) => t.sourceTable === "SkillVersion");
    expect(svTable?.targetCount).toBe(1);

    // SkillSyncMapping: 1 目标
    const ssmTable = result.tables.find((t) => t.sourceTable === "SkillSyncMapping");
    expect(ssmTable?.targetCount).toBe(1);

    // Agent: 2 目标（V11Agent + V11AgentRevision）
    const agentTable = result.tables.find((t) => t.sourceTable === "Agent");
    expect(agentTable?.targetCount).toBe(2);

    // SubagentDefinition: 1 目标（V11AgentRevision.delegationPolicyJson）
    const subTable = result.tables.find((t) => t.sourceTable === "SubagentDefinition");
    expect(subTable?.targetCount).toBe(1);
    expect(subTable?.anomalyCount).toBe(0);

    // ProviderProfile: 2 目标（V11Connection + V11CredentialRef）
    const ppTable = result.tables.find((t) => t.sourceTable === "ProviderProfile");
    expect(ppTable?.targetCount).toBe(2);

    // 验证 V11 表实际写入
    const skills = await db.select().from(v11Skill);
    expect(skills.length).toBe(1);

    const skillVersions = await db.select().from(v11SkillVersion);
    // 1 来自 SkillVersion + 1 来自 SkillSyncMapping = 2
    expect(skillVersions.length).toBe(2);

    const agents = await db.select().from(v11Agent);
    expect(agents.length).toBe(1);

    const agentRevisions = await db.select().from(v11AgentRevision);
    // 1 来自 Agent + 1 来自 SubagentDefinition = 2
    expect(agentRevisions.length).toBe(2);

    const connections = await db.select().from(v11Connection);
    expect(connections.length).toBe(1);

    const credentials = await db.select().from(v11CredentialRef);
    expect(credentials.length).toBe(1);
  });

  it("幂等性：二次运行跳过所有已迁移记录", async () => {
    await db.insert(Skill).values({
      id: "skill-idem",
      name: "idem-skill",
      status: "active",
      source: "local",
      visibility: "public",
    });
    await db.insert(ProviderProfile).values({
      id: "pp-idem",
      name: "idem-provider",
      baseUrl: "https://idem.example.com",
      apiKeyRef: "IDEM_API_KEY",
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createAgentSkillTransformers();

    // 第一次运行
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result1 = await runner1.runDomain("agent_skill");
    expect(result1.totalTargetCount).toBeGreaterThan(0);

    const skillCount1 = (await db.select().from(v11Skill)).length;
    const connCount1 = (await db.select().from(v11Connection)).length;

    // 第二次运行：应全部跳过
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runDomain("agent_skill");

    expect(result2.totalTargetCount).toBe(0);
    expect(result2.totalSkipCount).toBe(2); // Skill + ProviderProfile

    // V11 表行数不变
    const skillCount2 = (await db.select().from(v11Skill)).length;
    const connCount2 = (await db.select().from(v11Connection)).length;
    expect(skillCount2).toBe(skillCount1);
    expect(connCount2).toBe(connCount1);
  });
});

// ═══════════════════════════════════════════════════════════
// 8. createAgentSkillTransformers 工厂
// ═══════════════════════════════════════════════════════════

describe("S13-C03 createAgentSkillTransformers 工厂", () => {
  it("返回 6 个转换器", () => {
    const transformers = createAgentSkillTransformers();
    expect(transformers.size).toBe(6);
    expect(transformers.has("Skill")).toBe(true);
    expect(transformers.has("SkillVersion")).toBe(true);
    expect(transformers.has("SkillSyncMapping")).toBe(true);
    expect(transformers.has("Agent")).toBe(true);
    expect(transformers.has("SubagentDefinition")).toBe(true);
    expect(transformers.has("ProviderProfile")).toBe(true);
  });

  it("每个转换器是函数类型", () => {
    const transformers = createAgentSkillTransformers();
    for (const [, transformer] of transformers) {
      expect(typeof transformer).toBe("function");
    }
  });

  it("工厂每次调用返回独立 Map 实例", () => {
    const t1 = createAgentSkillTransformers();
    const t2 = createAgentSkillTransformers();
    expect(t1).not.toBe(t2);
    expect(t1.size).toBe(t2.size);
  });
});
