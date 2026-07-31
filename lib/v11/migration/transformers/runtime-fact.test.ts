/**
 * S13-C03 runtime_fact 域迁移转换器集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - ToolRun 转换器：正常迁移、runId 不存在异常、status→callState 映射、unmigratable 字段不迁移
 * - RunTranscriptChunk 转换器：正常迁移、runId 不存在异常、kind→candidateType 映射、payloadHash 计算
 * - ThreadRunSkill 转换器：正常迁移、skillId 不在迁移映射异常、supporting 角色 skip
 * - ContextSnapshot 转换器：正常迁移、runId 不存在异常、unmigratable 字段不迁移
 * - 端到端 runtime_fact 域迁移：4 张表顺序执行
 * - 幂等性：二次运行跳过已迁移记录
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import {
  agent as Agent,
  contextSnapshot as ContextSnapshot,
  runTranscriptChunk as RunTranscriptChunk,
  skill as Skill,
  thread as Thread,
  threadRun as ThreadRun,
  threadRunSkill as ThreadRunSkill,
  toolRun as ToolRun,
  user as User,
} from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { createExecutionRunner } from "@/lib/v11/migration/migration-runner";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import { InMemoryMigrationStateStore } from "@/lib/v11/migration/migration-state";
import { createAgentSkillTransformers } from "@/lib/v11/migration/transformers/agent-skill";
import { createConversationTransformers } from "@/lib/v11/migration/transformers/conversation";
import { createIdentityTransformers } from "@/lib/v11/migration/transformers/identity";
import { createRuntimeFactTransformers } from "@/lib/v11/migration/transformers/runtime-fact";
import { getV11TableRegistry } from "@/lib/v11/migration/v11-table-registry";
import { contextCheckpoint as v11ContextCheckpoint } from "@/lib/v11/schema/context-checkpoint";
import {
  v11ExecutionBinding,
  v11Invocation,
  v11RuntimeEventIngress,
} from "@/lib/v11/schema/runtime";
import { v11ToolCall } from "@/lib/v11/schema/tool-call";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/** 合并 identity + agent_skill + conversation + runtime_fact 转换器。 */
function createMergedTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ...createIdentityTransformers(),
    ...createAgentSkillTransformers(),
    ...createConversationTransformers(),
    ...createRuntimeFactTransformers(),
  ]);
}

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

/**
 * 完整前置迁移：identity + agent_skill + conversation 域。
 *
 * runtime_fact 域依赖：
 * - conversation 域 ThreadRun → V11Invocation（runId 外键）
 * - agent_skill 域 Agent → V11Agent + V11AgentRevision（skillId → agentRevisionId 映射）
 */
async function migratePrerequisites(
  store: InMemoryMigrationStateStore,
  transformers: ReadonlyMap<string, MigrationTransformer>,
): Promise<void> {
  const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
  await runner.runDomain("identity");
  await runner.runDomain("agent_skill");
  await runner.runDomain("conversation");
}

/** 插入 User 并通过前置迁移生成 UserIdentity。 */
async function setupUser(userId: string, externalId: string): Promise<void> {
  await db.insert(User).values({
    id: userId,
    externalId,
    email: `${externalId}@example.com`,
    name: externalId,
  });
}

/** 插入 Skill + Agent（Agent.skillId 关联 Skill），用于 ThreadRunSkill 映射。 */
async function setupSkillAndAgent(skillId: string, agentId: string, model: string): Promise<void> {
  await db.insert(Skill).values({
    id: skillId,
    name: `skill-${skillId}`,
    status: "active",
    source: "local",
    visibility: "public",
  });
  await db.insert(Agent).values({
    id: agentId,
    name: `agent-${agentId}`,
    model,
    skillId,
    config: {},
  });
}

// ═══════════════════════════════════════════════════════════
// 1. ToolRun 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 ToolRun 转换器", () => {
  it("正常 ToolRun 迁移为 V11ToolCall", async () => {
    const userId = "user-tr-001";
    await setupUser(userId, "ext-tr-001");

    await db.insert(Thread).values({
      id: "thread-tr-001",
      title: "ToolRun 测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(ThreadRun).values({
      id: "run-tr-001",
      threadId: "thread-tr-001",
      status: "completed",
      triggerType: "user_message",
      model: "doubao-1.5-pro",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    const input = { path: "/tmp/test.txt", content: "hello" };
    const output = { success: true };
    await db.insert(ToolRun).values({
      id: "toolrun-001",
      threadId: "thread-tr-001",
      toolName: "writeFile",
      status: "succeeded",
      input,
      output,
      runId: "run-tr-001",
      startedAt: new Date("2024-06-01T00:00:00Z"),
      finishedAt: new Date("2024-06-01T00:01:00Z"),
    });

    // 迁移 runtime_fact 域
    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result = await runner.runDomain("runtime_fact");

    const toolRunTable = result.tables.find((t) => t.sourceTable === "ToolRun");
    expect(toolRunTable?.sourceCount).toBe(1);
    expect(toolRunTable?.targetCount).toBe(1);
    expect(toolRunTable?.anomalyCount).toBe(0);

    const [v11ToolCallRow] = await db
      .select()
      .from(v11ToolCall)
      .where(eq(v11ToolCall.id, "toolrun-001"))
      .limit(1);
    expect(v11ToolCallRow).toBeDefined();
    expect(v11ToolCallRow?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(v11ToolCallRow?.invocationId).toBe("run-tr-001");
    expect(v11ToolCallRow?.threadId).toBe("thread-tr-001");
    expect(v11ToolCallRow?.callState).toBe("succeeded");
    expect(v11ToolCallRow?.toolId).toBe("writeFile");
    expect(v11ToolCallRow?.operationId).toBe("toolrun-001");
    expect(v11ToolCallRow?.argumentsRedactedJson).toEqual(input);
    expect(v11ToolCallRow?.resultSummaryJson).toEqual(output);
    expect(v11ToolCallRow?.argumentsHash).toMatch(/^sha256:[a-f0-9]+$/);
    expect(v11ToolCallRow?.callSequence).toBe(1);
  });

  it("runId 对应的 V11Invocation 不存在时入异常队列", async () => {
    const userId = "user-tr-002";
    await setupUser(userId, "ext-tr-002");

    await db.insert(Thread).values({
      id: "thread-tr-002",
      title: "无 Invocation",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 插入 ToolRun，runId 指向不存在的 ThreadRun（ToolRun.runId 无 DB FK 约束）
    await db.insert(ToolRun).values({
      id: "toolrun-002",
      threadId: "thread-tr-002",
      toolName: "writeFile",
      status: "running",
      input: {},
      runId: "nonexistent-run",
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result = await runner.runDomain("runtime_fact");

    const toolRunTable = result.tables.find((t) => t.sourceTable === "ToolRun");
    expect(toolRunTable?.anomalyCount).toBe(1);
    expect(toolRunTable?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("ToolRun");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toContain("V11Invocation 不存在");
  });

  it("status 映射：running→running, succeeded→succeeded, failed→failed, awaiting_approval→paused", async () => {
    const userId = "user-tr-003";
    await setupUser(userId, "ext-tr-003");

    await db.insert(Thread).values({
      id: "thread-tr-003",
      title: "状态映射测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(ThreadRun).values({
      id: "run-tr-003",
      threadId: "thread-tr-003",
      status: "running",
      triggerType: "user_message",
      model: "test-model",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    const statuses = [
      { id: "tr-running", status: "running", expected: "running" },
      { id: "tr-succeeded", status: "succeeded", expected: "succeeded" },
      { id: "tr-failed", status: "failed", expected: "failed" },
      { id: "tr-paused", status: "awaiting_approval", expected: "paused" },
    ];

    for (const s of statuses) {
      await db.insert(ToolRun).values({
        id: s.id,
        threadId: "thread-tr-003",
        toolName: "testTool",
        status: s.status as "running" | "succeeded" | "failed" | "awaiting_approval",
        input: {},
        runId: "run-tr-003",
      });
    }

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    await runner.runDomain("runtime_fact");

    for (const s of statuses) {
      const [row] = await db.select().from(v11ToolCall).where(eq(v11ToolCall.id, s.id)).limit(1);
      expect(row?.callState).toBe(s.expected);
    }
  });

  it("failed 状态时填充 errorCode 和 errorSummary", async () => {
    const userId = "user-tr-004";
    await setupUser(userId, "ext-tr-004");

    await db.insert(Thread).values({
      id: "thread-tr-004",
      title: "失败测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(ThreadRun).values({
      id: "run-tr-004",
      threadId: "thread-tr-004",
      status: "running",
      triggerType: "user_message",
      model: "test-model",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    await db.insert(ToolRun).values({
      id: "toolrun-failed",
      threadId: "thread-tr-004",
      toolName: "writeFile",
      status: "failed",
      input: {},
      error: "文件权限不足",
      runId: "run-tr-004",
    });

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    await runner.runDomain("runtime_fact");

    const [row] = await db
      .select()
      .from(v11ToolCall)
      .where(eq(v11ToolCall.id, "toolrun-failed"))
      .limit(1);
    expect(row?.errorCode).toBe("legacy_failed");
    expect(row?.errorSummary).toBe("文件权限不足");
  });

  it("threadId 为空时入异常队列", async () => {
    // ToolRun.threadId 有 DB FK 约束，直接调用转换器验证防御逻辑
    const transformers = createRuntimeFactTransformers();
    const transformer = transformers.get("ToolRun");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "toolrun-no-thread",
      threadId: "",
      toolName: "writeFile",
      status: "running",
      input: {},
      runId: "some-run",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("threadId 为空");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. RunTranscriptChunk 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 RunTranscriptChunk 转换器", () => {
  it("正常 RunTranscriptChunk 迁移为 V11RuntimeEventIngress", async () => {
    const userId = "user-rtc-001";
    await setupUser(userId, "ext-rtc-001");

    await db.insert(Thread).values({
      id: "thread-rtc-001",
      title: "Transcript 测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(ThreadRun).values({
      id: "run-rtc-001",
      threadId: "thread-rtc-001",
      status: "running",
      triggerType: "user_message",
      model: "test-model",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    const payload = { text: "流式文本块", seq: 1 };
    await db.insert(RunTranscriptChunk).values({
      id: "chunk-001",
      threadId: "thread-rtc-001",
      runId: "run-rtc-001",
      sequence: 1,
      kind: "ui_message_chunk",
      payload,
      createdAt: new Date("2024-07-01T00:00:00Z"),
    });

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result = await runner.runDomain("runtime_fact");

    const rtcTable = result.tables.find((t) => t.sourceTable === "RunTranscriptChunk");
    expect(rtcTable?.sourceCount).toBe(1);
    expect(rtcTable?.targetCount).toBe(1);
    expect(rtcTable?.anomalyCount).toBe(0);

    const [ingress] = await db
      .select()
      .from(v11RuntimeEventIngress)
      .where(eq(v11RuntimeEventIngress.id, "chunk-001"))
      .limit(1);
    expect(ingress).toBeDefined();
    expect(ingress?.invocationId).toBe("run-rtc-001");
    expect(ingress?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(ingress?.producerEventId).toBe("chunk-001");
    expect(ingress?.producerSequence).toBe(1);
    expect(ingress?.candidateType).toBe("ui_message_chunk");
    expect(ingress?.payloadJson).toEqual(payload);
    expect(ingress?.payloadHash).toMatch(/^sha256:[a-f0-9]+$/);
    expect(ingress?.ingressState).toBe("accepted");
  });

  it("runId 对应的 V11Invocation 不存在时入异常队列", async () => {
    const userId = "user-rtc-002";
    await setupUser(userId, "ext-rtc-002");

    await db.insert(Thread).values({
      id: "thread-rtc-002",
      title: "无 Invocation Transcript",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // 插入 ThreadRun 但不迁移 conversation 域（V11Invocation 不存在）
    await db.insert(ThreadRun).values({
      id: "run-rtc-orphan",
      threadId: "thread-rtc-002",
      status: "running",
      triggerType: "user_message",
      model: "test-model",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(RunTranscriptChunk).values({
      id: "chunk-orphan",
      threadId: "thread-rtc-002",
      runId: "run-rtc-orphan",
      sequence: 1,
      kind: "ui_message_chunk",
      payload: {},
    });

    // 只迁移 identity 域（不迁移 conversation），V11Invocation 不存在
    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    await runner.runDomain("identity");
    // 不迁移 conversation 域
    const result = await runner.runDomain("runtime_fact");

    const rtcTable = result.tables.find((t) => t.sourceTable === "RunTranscriptChunk");
    expect(rtcTable?.anomalyCount).toBe(1);

    const anomalies = store.getAnomalies("RunTranscriptChunk");
    expect(anomalies[0]?.reason).toContain("V11Invocation 不存在");
  });

  it("kind 映射保留原始值到 candidateType", async () => {
    const userId = "user-rtc-003";
    await setupUser(userId, "ext-rtc-003");

    await db.insert(Thread).values({
      id: "thread-rtc-003",
      title: "kind 映射测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(ThreadRun).values({
      id: "run-rtc-003",
      threadId: "thread-rtc-003",
      status: "running",
      triggerType: "user_message",
      model: "test-model",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    const kinds = ["ui_message_chunk", "artifact", "error", "done"];
    for (const [i, kind] of kinds.entries()) {
      await db.insert(RunTranscriptChunk).values({
        id: `chunk-kind-${i}`,
        threadId: "thread-rtc-003",
        runId: "run-rtc-003",
        sequence: i + 1,
        kind,
        payload: { kind },
      });
    }

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    await runner.runDomain("runtime_fact");

    for (const [i, kind] of kinds.entries()) {
      const [row] = await db
        .select()
        .from(v11RuntimeEventIngress)
        .where(eq(v11RuntimeEventIngress.id, `chunk-kind-${i}`))
        .limit(1);
      expect(row?.candidateType).toBe(kind);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 3. ThreadRunSkill 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 ThreadRunSkill 转换器", () => {
  it("正常 ThreadRunSkill 迁移为 V11ExecutionBinding", async () => {
    const userId = "user-trs-001";
    await setupUser(userId, "ext-trs-001");
    await setupSkillAndAgent("skill-trs-001", "agent-trs-001", "doubao-1.5-pro");

    await db.insert(Thread).values({
      id: "thread-trs-001",
      title: "ThreadRunSkill 测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(ThreadRun).values({
      id: "run-trs-001",
      threadId: "thread-trs-001",
      status: "running",
      triggerType: "user_message",
      model: "doubao-1.5-pro",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    await db.insert(ThreadRunSkill).values({
      id: "trs-001",
      runId: "run-trs-001",
      threadId: "thread-trs-001",
      skillId: "skill-trs-001",
      skillVersionId: "sv-trs-001",
      role: "primary",
      source: "resolver",
    });

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result = await runner.runDomain("runtime_fact");

    const trsTable = result.tables.find((t) => t.sourceTable === "ThreadRunSkill");
    expect(trsTable?.sourceCount).toBe(1);
    expect(trsTable?.targetCount).toBe(1);
    expect(trsTable?.anomalyCount).toBe(0);

    const [binding] = await db
      .select()
      .from(v11ExecutionBinding)
      .where(eq(v11ExecutionBinding.invocationId, "run-trs-001"))
      .limit(1);
    expect(binding).toBeDefined();
    expect(binding?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(binding?.agentRevisionId).toBeDefined();
    expect(binding?.modelProvider).toBe("doubao");
    expect(binding?.modelId).toBe("doubao-1.5-pro");
    expect(binding?.configHash).toMatch(/^sha256:[a-f0-9]+$/);
  });

  it("skillId 不在迁移映射时入异常队列", async () => {
    const userId = "user-trs-002";
    await setupUser(userId, "ext-trs-002");

    await db.insert(Thread).values({
      id: "thread-trs-002",
      title: "无 Agent 映射",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(ThreadRun).values({
      id: "run-trs-002",
      threadId: "thread-trs-002",
      status: "running",
      triggerType: "user_message",
      model: "test-model",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    // skillId 不存在于任何 Agent（ThreadRunSkill.skillId 无 DB FK 约束）
    await db.insert(ThreadRunSkill).values({
      id: "trs-002",
      runId: "run-trs-002",
      threadId: "thread-trs-002",
      skillId: "nonexistent-skill",
      skillVersionId: "sv-nonexistent",
      role: "primary",
      source: "resolver",
    });

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result = await runner.runDomain("runtime_fact");

    const trsTable = result.tables.find((t) => t.sourceTable === "ThreadRunSkill");
    expect(trsTable?.anomalyCount).toBe(1);
    expect(trsTable?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("ThreadRunSkill");
    expect(anomalies[0]?.reason).toContain("不在迁移映射");
  });

  it("supporting 角色跳过不迁移", async () => {
    const userId = "user-trs-003";
    await setupUser(userId, "ext-trs-003");
    await setupSkillAndAgent("skill-trs-003", "agent-trs-003", "test-model");

    await db.insert(Thread).values({
      id: "thread-trs-003",
      title: "supporting 测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(ThreadRun).values({
      id: "run-trs-003",
      threadId: "thread-trs-003",
      status: "running",
      triggerType: "user_message",
      model: "test-model",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    await db.insert(ThreadRunSkill).values({
      id: "trs-supporting",
      runId: "run-trs-003",
      threadId: "thread-trs-003",
      skillId: "skill-trs-003",
      skillVersionId: "sv-trs-003",
      role: "supporting",
      source: "resolver",
    });

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result = await runner.runDomain("runtime_fact");

    const trsTable = result.tables.find((t) => t.sourceTable === "ThreadRunSkill");
    // supporting 跳过：不计入 anomaly 也不计入 target
    expect(trsTable?.skipCount).toBe(1);
    expect(trsTable?.targetCount).toBe(0);
    expect(trsTable?.anomalyCount).toBe(0);

    // 不应写入 V11ExecutionBinding
    const bindings = await db
      .select()
      .from(v11ExecutionBinding)
      .where(eq(v11ExecutionBinding.invocationId, "run-trs-003"));
    expect(bindings.length).toBe(0);
  });

  it("同一 run 多个 primary skill 只迁第一个", async () => {
    const userId = "user-trs-004";
    await setupUser(userId, "ext-trs-004");
    await setupSkillAndAgent("skill-trs-004a", "agent-trs-004a", "test-model");
    await setupSkillAndAgent("skill-trs-004b", "agent-trs-004b", "test-model");

    await db.insert(Thread).values({
      id: "thread-trs-004",
      title: "多 primary 测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(ThreadRun).values({
      id: "run-trs-004",
      threadId: "thread-trs-004",
      status: "running",
      triggerType: "user_message",
      model: "test-model",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    await db.insert(ThreadRunSkill).values({
      id: "trs-004a",
      runId: "run-trs-004",
      threadId: "thread-trs-004",
      skillId: "skill-trs-004a",
      skillVersionId: "sv-004a",
      role: "primary",
      source: "resolver",
    });
    await db.insert(ThreadRunSkill).values({
      id: "trs-004b",
      runId: "run-trs-004",
      threadId: "thread-trs-004",
      skillId: "skill-trs-004b",
      skillVersionId: "sv-004b",
      role: "primary",
      source: "resolver",
    });

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result = await runner.runDomain("runtime_fact");

    const trsTable = result.tables.find((t) => t.sourceTable === "ThreadRunSkill");
    // 一个迁移，一个跳过
    expect(trsTable?.targetCount).toBe(1);
    expect(trsTable?.skipCount).toBe(1);

    // 只有一条 V11ExecutionBinding
    const bindings = await db
      .select()
      .from(v11ExecutionBinding)
      .where(eq(v11ExecutionBinding.invocationId, "run-trs-004"));
    expect(bindings.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. ContextSnapshot 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 ContextSnapshot 转换器", () => {
  it("正常 ContextSnapshot 迁移为 V11ContextCheckpoint", async () => {
    const userId = "user-cs-001";
    await setupUser(userId, "ext-cs-001");

    await db.insert(Thread).values({
      id: "thread-cs-001",
      title: "ContextSnapshot 测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(ThreadRun).values({
      id: "run-cs-001",
      threadId: "thread-cs-001",
      status: "running",
      triggerType: "user_message",
      model: "test-model",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    const layers = [{ type: "message", id: "msg-1" }];
    const checksums = { layer1: "abc123" };
    await db.insert(ContextSnapshot).values({
      id: "snapshot-001",
      threadId: "thread-cs-001",
      trigger: "chat.user_message",
      model: "test-model",
      toolNames: ["writeFile"],
      layers,
      protectedRefs: [],
      excludedCandidates: [],
      checksums,
      estimatedTokens: 1000,
      compressed: false,
      runId: "run-cs-001",
      createdAt: new Date("2024-08-01T00:00:00Z"),
    });

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result = await runner.runDomain("runtime_fact");

    const csTable = result.tables.find((t) => t.sourceTable === "ContextSnapshot");
    expect(csTable?.sourceCount).toBe(1);
    expect(csTable?.targetCount).toBe(1);
    expect(csTable?.anomalyCount).toBe(0);

    const [checkpoint] = await db
      .select()
      .from(v11ContextCheckpoint)
      .where(eq(v11ContextCheckpoint.id, "snapshot-001"))
      .limit(1);
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(checkpoint?.invocationId).toBe("run-cs-001");
    expect(checkpoint?.checkpointType).toBe("assembly");
    expect(checkpoint?.sourceRangesJson).toEqual(layers);
    expect(checkpoint?.sourceRangesHash).toMatch(/^sha256:[a-f0-9]+$/);
    expect(checkpoint?.summaryRef).toBe("legacy:context-snapshot:snapshot-001");
    expect(checkpoint?.summaryHash).toMatch(/^sha256:[a-f0-9]+$/);
    expect(checkpoint?.inputTokens).toBe(1000);
    expect(checkpoint?.retainedTokens).toBe(1000);
    expect(checkpoint?.compressedTokens).toBe(0);
  });

  it("runId 对应的 V11Invocation 不存在时入异常队列", async () => {
    const userId = "user-cs-002";
    await setupUser(userId, "ext-cs-002");

    await db.insert(Thread).values({
      id: "thread-cs-002",
      title: "无 Invocation Snapshot",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // ContextSnapshot.runId 无 DB FK 约束，可插入不存在的 runId
    await db.insert(ContextSnapshot).values({
      id: "snapshot-orphan",
      threadId: "thread-cs-002",
      trigger: "chat.user_message",
      model: "test-model",
      toolNames: [],
      layers: [],
      protectedRefs: [],
      excludedCandidates: [],
      checksums: {},
      estimatedTokens: 0,
      runId: "nonexistent-run",
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result = await runner.runDomain("runtime_fact");

    const csTable = result.tables.find((t) => t.sourceTable === "ContextSnapshot");
    expect(csTable?.anomalyCount).toBe(1);
    expect(csTable?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("ContextSnapshot");
    expect(anomalies[0]?.reason).toContain("V11Invocation 不存在");
  });

  it("unmigratable 字段 skillResolverInput/skillResolverOutput 不迁移", async () => {
    const userId = "user-cs-003";
    await setupUser(userId, "ext-cs-003");

    await db.insert(Thread).values({
      id: "thread-cs-003",
      title: "不可迁字段测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(ThreadRun).values({
      id: "run-cs-003",
      threadId: "thread-cs-003",
      status: "running",
      triggerType: "user_message",
      model: "test-model",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    await db.insert(ContextSnapshot).values({
      id: "snapshot-unmig-001",
      threadId: "thread-cs-003",
      trigger: "chat.user_message",
      model: "test-model",
      toolNames: [],
      layers: [],
      protectedRefs: [],
      excludedCandidates: [],
      checksums: {},
      estimatedTokens: 500,
      compressed: true,
      afterTokens: 300,
      skillResolverInput: { availableSkillCount: 5 },
      skillResolverOutput: { selectedSkillVersions: ["sv-1"] },
      runId: "run-cs-003",
    });

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    await runner.runDomain("runtime_fact");

    const [checkpoint] = await db
      .select()
      .from(v11ContextCheckpoint)
      .where(eq(v11ContextCheckpoint.id, "snapshot-unmig-001"))
      .limit(1);
    expect(checkpoint).toBeDefined();
    // V11ContextCheckpoint 无 skillResolverInput/skillResolverOutput 字段，验证不报错且正常写入
    expect(checkpoint?.inputTokens).toBe(500);
    expect(checkpoint?.retainedTokens).toBe(300);
    expect(checkpoint?.compressedTokens).toBe(200); // 500 - 300
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 端到端 runtime_fact 域迁移
// ═══════════════════════════════════════════════════════════

describe("S13-C03 runtime_fact 域端到端迁移", () => {
  it("完整 runtime_fact 域迁移：4 张表顺序执行", async () => {
    const userId = "user-e2e-rf-001";
    await setupUser(userId, "ext-e2e-rf-001");
    await setupSkillAndAgent("skill-e2e-rf", "agent-e2e-rf", "doubao-1.5-pro");

    await db.insert(Thread).values({
      id: "thread-e2e-rf",
      title: "端到端 runtime_fact",
      userId,
      status: "idle",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T01:00:00Z"),
    });
    await db.insert(ThreadRun).values({
      id: "run-e2e-rf",
      threadId: "thread-e2e-rf",
      status: "completed",
      triggerType: "user_message",
      model: "doubao-1.5-pro",
      startedAt: new Date("2024-01-01T00:10:00Z"),
      finishedAt: new Date("2024-01-01T00:11:00Z"),
      createdAt: new Date("2024-01-01T00:10:00Z"),
      updatedAt: new Date("2024-01-01T00:11:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    // 插入 runtime_fact 4 张源表数据
    await db.insert(ToolRun).values({
      id: "toolrun-e2e",
      threadId: "thread-e2e-rf",
      toolName: "writeFile",
      status: "succeeded",
      input: { path: "/tmp/test.txt" },
      output: { success: true },
      runId: "run-e2e-rf",
      startedAt: new Date("2024-01-01T00:10:30Z"),
      finishedAt: new Date("2024-01-01T00:10:35Z"),
    });
    await db.insert(RunTranscriptChunk).values({
      id: "chunk-e2e",
      threadId: "thread-e2e-rf",
      runId: "run-e2e-rf",
      sequence: 1,
      kind: "ui_message_chunk",
      payload: { text: "端到端块" },
      createdAt: new Date("2024-01-01T00:10:20Z"),
    });
    await db.insert(ThreadRunSkill).values({
      id: "trs-e2e",
      runId: "run-e2e-rf",
      threadId: "thread-e2e-rf",
      skillId: "skill-e2e-rf",
      skillVersionId: "sv-e2e-rf",
      role: "primary",
      source: "resolver",
    });
    await db.insert(ContextSnapshot).values({
      id: "snapshot-e2e",
      threadId: "thread-e2e-rf",
      trigger: "chat.user_message",
      model: "doubao-1.5-pro",
      toolNames: ["writeFile"],
      layers: [{ type: "message", id: "msg-e2e" }],
      protectedRefs: [],
      excludedCandidates: [],
      checksums: { layer1: "hash1" },
      estimatedTokens: 800,
      runId: "run-e2e-rf",
      createdAt: new Date("2024-01-01T00:10:10Z"),
    });

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result = await runner.runDomain("runtime_fact");

    // 汇总验证
    expect(result.totalSourceCount).toBe(4);
    expect(result.totalAnomalyCount).toBe(0);
    expect(result.totalTargetCount).toBe(4);

    // 验证各表目标数
    const toolRunTable = result.tables.find((t) => t.sourceTable === "ToolRun");
    expect(toolRunTable?.targetCount).toBe(1);

    const rtcTable = result.tables.find((t) => t.sourceTable === "RunTranscriptChunk");
    expect(rtcTable?.targetCount).toBe(1);

    const trsTable = result.tables.find((t) => t.sourceTable === "ThreadRunSkill");
    expect(trsTable?.targetCount).toBe(1);

    const csTable = result.tables.find((t) => t.sourceTable === "ContextSnapshot");
    expect(csTable?.targetCount).toBe(1);

    // 验证 V11 表实际写入
    const toolCalls = await db.select().from(v11ToolCall);
    expect(toolCalls.length).toBe(1);

    const ingresses = await db.select().from(v11RuntimeEventIngress);
    expect(ingresses.length).toBe(1);

    const bindings = await db.select().from(v11ExecutionBinding);
    expect(bindings.length).toBe(1);

    const checkpoints = await db.select().from(v11ContextCheckpoint);
    expect(checkpoints.length).toBe(1);
  });

  it("幂等性：二次运行跳过所有已迁移记录", async () => {
    const userId = "user-idem-rf-001";
    await setupUser(userId, "ext-idem-rf-001");

    await db.insert(Thread).values({
      id: "thread-idem-rf",
      title: "幂等测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(ThreadRun).values({
      id: "run-idem-rf",
      threadId: "thread-idem-rf",
      status: "running",
      triggerType: "user_message",
      model: "test-model",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();
    await migratePrerequisites(store, transformers);

    await db.insert(ToolRun).values({
      id: "toolrun-idem",
      threadId: "thread-idem-rf",
      toolName: "writeFile",
      status: "succeeded",
      input: {},
      runId: "run-idem-rf",
    });
    await db.insert(RunTranscriptChunk).values({
      id: "chunk-idem",
      threadId: "thread-idem-rf",
      runId: "run-idem-rf",
      sequence: 1,
      kind: "done",
      payload: {},
    });

    // 第一次运行
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result1 = await runner1.runDomain("runtime_fact");
    expect(result1.totalTargetCount).toBe(2);

    // 记录第一次的 V11 表行数
    const toolCallCount1 = (await db.select().from(v11ToolCall)).length;
    const ingressCount1 = (await db.select().from(v11RuntimeEventIngress)).length;

    // 第二次运行：应全部跳过
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runDomain("runtime_fact");

    expect(result2.totalTargetCount).toBe(0);
    expect(result2.totalSkipCount).toBe(2);

    // V11 表行数不变
    const toolCallCount2 = (await db.select().from(v11ToolCall)).length;
    const ingressCount2 = (await db.select().from(v11RuntimeEventIngress)).length;
    expect(toolCallCount2).toBe(toolCallCount1);
    expect(ingressCount2).toBe(ingressCount1);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. createRuntimeFactTransformers 工厂
// ═══════════════════════════════════════════════════════════

describe("S13-C03 createRuntimeFactTransformers 工厂", () => {
  it("返回 4 个转换器", () => {
    const transformers = createRuntimeFactTransformers();
    expect(transformers.size).toBe(4);
    expect(transformers.has("ToolRun")).toBe(true);
    expect(transformers.has("RunTranscriptChunk")).toBe(true);
    expect(transformers.has("ThreadRunSkill")).toBe(true);
    expect(transformers.has("ContextSnapshot")).toBe(true);
  });

  it("每个转换器是函数类型", () => {
    const transformers = createRuntimeFactTransformers();
    for (const [, transformer] of transformers) {
      expect(typeof transformer).toBe("function");
    }
  });

  it("工厂每次调用返回独立 Map 实例", () => {
    const t1 = createRuntimeFactTransformers();
    const t2 = createRuntimeFactTransformers();
    expect(t1).not.toBe(t2);
    expect(t1.size).toBe(t2.size);
  });
});
