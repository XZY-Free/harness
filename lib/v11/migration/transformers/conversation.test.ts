/**
 * S13-C03 conversation 域迁移转换器集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - Thread 转换器：正常迁移、status→lifecycleState 映射、deletedAt 软删除、userIdentityId 不存在异常
 * - Message 转换器：正常迁移、threadId 不存在异常、type/role→itemType 映射
 * - ThreadEvent 转换器：正常迁移、threadId 不存在异常
 * - ThreadRun 转换器：正常迁移（Invocation + InvocationAttempt）、threadId 不存在异常、status 映射
 * - 端到端 conversation 域迁移：Thread/Message/ThreadEvent/ThreadRun 顺序执行
 * - 幂等性：二次运行跳过已迁移记录
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import {
  message as Message,
  thread as Thread,
  threadEvent as ThreadEvent,
  threadRun as ThreadRun,
  user as User,
} from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { createExecutionRunner } from "@/lib/v11/migration/migration-runner";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import { InMemoryMigrationStateStore } from "@/lib/v11/migration/migration-state";
import { createConversationTransformers } from "@/lib/v11/migration/transformers/conversation";
import { createIdentityTransformers } from "@/lib/v11/migration/transformers/identity";
import { getV11TableRegistry } from "@/lib/v11/migration/v11-table-registry";
import { v11Thread, v11ThreadEvent, v11ThreadItem } from "@/lib/v11/schema/conversation";
import { userIdentity } from "@/lib/v11/schema/identity";
import { v11Invocation, v11InvocationAttempt } from "@/lib/v11/schema/runtime";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/** 合并 identity + conversation 转换器（Thread 迁移依赖 identity 域 User 先迁）。 */
function createMergedTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ...createIdentityTransformers(),
    ...createConversationTransformers(),
  ]);
}

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

/** 插入 User 并迁移 identity 域，返回 userId。 */
async function setupUser(userId: string, externalId: string): Promise<void> {
  await db.insert(User).values({
    id: userId,
    externalId,
    email: `${externalId}@example.com`,
    name: externalId,
  });
  const store = new InMemoryMigrationStateStore();
  const runner = createExecutionRunner(
    store,
    createIdentityTransformers(),
    100,
    false,
    getV11TableRegistry(),
  );
  await runner.runDomain("identity");
}

// ═══════════════════════════════════════════════════════════
// 1. Thread 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 Thread 转换器", () => {
  it("正常 Thread 迁移为 V11Thread", async () => {
    const userId = "user-conv-001";
    await setupUser(userId, "ext-conv-001");

    await db.insert(Thread).values({
      id: "thread-conv-001",
      title: "测试会话",
      userId,
      status: "idle",
      model: "test-model",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-02T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("conversation");

    const threadTable = result.tables.find((t) => t.sourceTable === "Thread");
    expect(threadTable?.sourceCount).toBe(1);
    expect(threadTable?.targetCount).toBe(1);
    expect(threadTable?.anomalyCount).toBe(0);

    // 验证 V11Thread 写入
    const [v11ThreadRow] = await db
      .select()
      .from(v11Thread)
      .where(eq(v11Thread.id, "thread-conv-001"))
      .limit(1);
    expect(v11ThreadRow).toBeDefined();
    expect(v11ThreadRow?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(v11ThreadRow?.ownerUserId).toBe(userId);
    expect(v11ThreadRow?.title).toBe("测试会话");
    expect(v11ThreadRow?.lifecycleState).toBe("active");
    expect(v11ThreadRow?.defaultModelRef).toBe("test-model");
    expect(v11ThreadRow?.deletedAt).toBeNull();
  });

  it("status=completed 映射为 lifecycleState=archived", async () => {
    const userId = "user-conv-002";
    await setupUser(userId, "ext-conv-002");

    await db.insert(Thread).values({
      id: "thread-conv-002",
      title: "已完成会话",
      userId,
      status: "completed",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("conversation");

    const [row] = await db
      .select()
      .from(v11Thread)
      .where(eq(v11Thread.id, "thread-conv-002"))
      .limit(1);
    expect(row?.lifecycleState).toBe("archived");
  });

  it("deletedAt 非空时映射为 lifecycleState=deleted 且保留 deletedAt", async () => {
    const userId = "user-conv-003";
    await setupUser(userId, "ext-conv-003");

    const deletedAt = new Date("2024-06-01T12:00:00Z");
    await db.insert(Thread).values({
      id: "thread-conv-003",
      title: "已删除会话",
      userId,
      status: "idle",
      deletedAt,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-06-01T12:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("conversation");

    const [row] = await db
      .select()
      .from(v11Thread)
      .where(eq(v11Thread.id, "thread-conv-003"))
      .limit(1);
    expect(row?.lifecycleState).toBe("deleted");
    expect(row?.deletedAt).toEqual(deletedAt);
  });

  it("userIdentityId 不存在时入异常队列", async () => {
    // 不迁移 identity 域，直接插入 Thread（FK 允许因为 User 存在但 UserIdentity 不存在）
    await db.insert(User).values({
      id: "user-conv-noidentity",
      externalId: "ext-noidentity",
      email: "noidentity@example.com",
    });

    await db.insert(Thread).values({
      id: "thread-conv-no-ui",
      title: "无 UserIdentity",
      userId: "user-conv-noidentity",
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("conversation");

    const threadTable = result.tables.find((t) => t.sourceTable === "Thread");
    expect(threadTable?.anomalyCount).toBe(1);
    expect(threadTable?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("Thread");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toContain("UserIdentity 不存在");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Message 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 Message 转换器", () => {
  it("正常 Message 迁移为 V11ThreadItem", async () => {
    const userId = "user-msg-001";
    await setupUser(userId, "ext-msg-001");

    await db.insert(Thread).values({
      id: "thread-msg-001",
      title: "消息测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const parts = [{ type: "text", text: "你好" }];
    await db.insert(Message).values({
      id: "msg-001",
      threadId: "thread-msg-001",
      role: "user",
      type: "user_input",
      parts,
      createdAt: new Date("2024-03-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("conversation");

    const messageTable = result.tables.find((t) => t.sourceTable === "Message");
    expect(messageTable?.sourceCount).toBe(1);
    expect(messageTable?.targetCount).toBe(1);
    expect(messageTable?.anomalyCount).toBe(0);

    const [item] = await db
      .select()
      .from(v11ThreadItem)
      .where(eq(v11ThreadItem.id, "msg-001"))
      .limit(1);
    expect(item).toBeDefined();
    expect(item?.threadId).toBe("thread-msg-001");
    expect(item?.itemType).toBe("user_message");
    expect(item?.authorType).toBe("user");
    expect(item?.itemSequence).toBe(1);
    expect(item?.contentJson).toEqual(parts);
    expect(item?.contentHash).toMatch(/^sha256:/);
  });

  it("threadId 不存在时入异常队列（孤儿消息）", async () => {
    // FK 约束阻止直接插入孤儿 Message，直接调用转换器验证防御逻辑
    const transformers = createConversationTransformers();
    const transformer = transformers.get("Message");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "msg-orphan",
      threadId: "nonexistent-thread",
      role: "user",
      type: "user_input",
      parts: [],
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("Thread nonexistent-thread 不存在");
  });

  it("assistant 消息映射为 agent_message", async () => {
    const userId = "user-msg-002";
    await setupUser(userId, "ext-msg-002");

    await db.insert(Thread).values({
      id: "thread-msg-002",
      title: "Agent 消息测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(Message).values({
      id: "msg-002",
      threadId: "thread-msg-002",
      role: "assistant",
      type: "assistant_text",
      parts: [{ type: "text", text: "我是 Agent 回答" }],
      createdAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("conversation");

    const [item] = await db
      .select()
      .from(v11ThreadItem)
      .where(eq(v11ThreadItem.id, "msg-002"))
      .limit(1);
    expect(item?.itemType).toBe("agent_message");
    expect(item?.authorType).toBe("agent");
  });

  it("runId 映射为 invocationId", async () => {
    const userId = "user-msg-003";
    await setupUser(userId, "ext-msg-003");

    await db.insert(Thread).values({
      id: "thread-msg-003",
      title: "runId 测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(Message).values({
      id: "msg-003",
      threadId: "thread-msg-003",
      role: "assistant",
      type: "assistant_text",
      parts: [{ type: "text", text: "带 runId 的消息" }],
      runId: "run-001",
      createdAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("conversation");

    const [item] = await db
      .select()
      .from(v11ThreadItem)
      .where(eq(v11ThreadItem.id, "msg-003"))
      .limit(1);
    expect(item?.invocationId).toBe("run-001");
  });
});

// ═══════════════════════════════════════════════════════════
// 3. ThreadEvent 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 ThreadEvent 转换器", () => {
  it("正常 ThreadEvent 迁移为 V11ThreadEvent", async () => {
    const userId = "user-evt-001";
    await setupUser(userId, "ext-evt-001");

    await db.insert(Thread).values({
      id: "thread-evt-001",
      title: "事件测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const payload = { detail: "事件详情" };
    await db.insert(ThreadEvent).values({
      id: "evt-001",
      threadId: "thread-evt-001",
      sequence: 1,
      type: "agent.started",
      payload,
      createdAt: new Date("2024-04-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("conversation");

    const evtTable = result.tables.find((t) => t.sourceTable === "ThreadEvent");
    expect(evtTable?.sourceCount).toBe(1);
    expect(evtTable?.targetCount).toBe(1);
    expect(evtTable?.anomalyCount).toBe(0);

    const [v11Evt] = await db
      .select()
      .from(v11ThreadEvent)
      .where(eq(v11ThreadEvent.id, "evt-001"))
      .limit(1);
    expect(v11Evt).toBeDefined();
    expect(v11Evt?.threadId).toBe("thread-evt-001");
    expect(v11Evt?.eventSequence).toBe(1);
    expect(v11Evt?.eventType).toBe("agent.started");
    expect(v11Evt?.payloadJson).toEqual(payload);
    expect(v11Evt?.actorType).toBe("system");
  });

  it("threadId 不存在时入异常队列", async () => {
    // FK 约束阻止直接插入孤儿 ThreadEvent，直接调用转换器验证防御逻辑
    const transformers = createConversationTransformers();
    const transformer = transformers.get("ThreadEvent");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "evt-orphan",
      threadId: "nonexistent-thread",
      sequence: 1,
      type: "agent.started",
      payload: {},
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("Thread nonexistent-thread 不存在");
  });

  it("runId 映射为 invocationId", async () => {
    const userId = "user-evt-002";
    await setupUser(userId, "ext-evt-002");

    await db.insert(Thread).values({
      id: "thread-evt-002",
      title: "runId 事件测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(ThreadEvent).values({
      id: "evt-002",
      threadId: "thread-evt-002",
      sequence: 2,
      type: "tool.called",
      payload: { tool: "writeFile" },
      runId: "run-evt-001",
      createdAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("conversation");

    const [v11Evt] = await db
      .select()
      .from(v11ThreadEvent)
      .where(eq(v11ThreadEvent.id, "evt-002"))
      .limit(1);
    expect(v11Evt?.invocationId).toBe("run-evt-001");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. ThreadRun 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 ThreadRun 转换器", () => {
  it("正常 ThreadRun 迁移为 V11Invocation + V11InvocationAttempt", async () => {
    const userId = "user-run-001";
    await setupUser(userId, "ext-run-001");

    await db.insert(Thread).values({
      id: "thread-run-001",
      title: "Run 测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(ThreadRun).values({
      id: "run-001",
      threadId: "thread-run-001",
      status: "completed",
      triggerType: "user_message",
      model: "test-model",
      startedAt: new Date("2024-05-01T00:00:00Z"),
      finishedAt: new Date("2024-05-01T00:01:00Z"),
      createdAt: new Date("2024-05-01T00:00:00Z"),
      updatedAt: new Date("2024-05-01T00:01:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("conversation");

    const runTable = result.tables.find((t) => t.sourceTable === "ThreadRun");
    expect(runTable?.sourceCount).toBe(1);
    expect(runTable?.targetCount).toBe(2); // V11Invocation + V11InvocationAttempt
    expect(runTable?.anomalyCount).toBe(0);

    // 验证 V11Invocation
    const [inv] = await db
      .select()
      .from(v11Invocation)
      .where(eq(v11Invocation.id, "run-001"))
      .limit(1);
    expect(inv).toBeDefined();
    expect(inv?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(inv?.threadId).toBe("thread-run-001");
    expect(inv?.executionState).toBe("completed");
    expect(inv?.invocationKind).toBe("initial");
    expect(inv?.invocationSequence).toBe(1);

    // 验证 V11InvocationAttempt
    const [attempt] = await db
      .select()
      .from(v11InvocationAttempt)
      .where(eq(v11InvocationAttempt.invocationId, "run-001"))
      .limit(1);
    expect(attempt).toBeDefined();
    expect(attempt?.attemptNo).toBe(1);
    expect(attempt?.attemptState).toBe("completed");
  });

  it("threadId 不存在时入异常队列", async () => {
    // FK 约束阻止直接插入孤儿 ThreadRun，直接调用转换器验证防御逻辑
    const transformers = createConversationTransformers();
    const transformer = transformers.get("ThreadRun");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "run-orphan",
      threadId: "nonexistent-thread",
      status: "queued",
      triggerType: "user_message",
      model: "test-model",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("Thread nonexistent-thread 不存在");
  });

  it("status=awaiting_approval 映射为 executionState=waiting_user", async () => {
    const userId = "user-run-002";
    await setupUser(userId, "ext-run-002");

    await db.insert(Thread).values({
      id: "thread-run-002",
      title: "审批测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(ThreadRun).values({
      id: "run-002",
      threadId: "thread-run-002",
      status: "awaiting_approval",
      triggerType: "user_message",
      model: "test-model",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("conversation");

    const [inv] = await db
      .select()
      .from(v11Invocation)
      .where(eq(v11Invocation.id, "run-002"))
      .limit(1);
    expect(inv?.executionState).toBe("waiting_user");

    // attemptState 无 waiting_user，映射为 running
    const [attempt] = await db
      .select()
      .from(v11InvocationAttempt)
      .where(eq(v11InvocationAttempt.invocationId, "run-002"))
      .limit(1);
    expect(attempt?.attemptState).toBe("running");
  });

  it("status=stale 映射为 executionState=lost", async () => {
    const userId = "user-run-003";
    await setupUser(userId, "ext-run-003");

    await db.insert(Thread).values({
      id: "thread-run-003",
      title: "失联测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(ThreadRun).values({
      id: "run-003",
      threadId: "thread-run-003",
      status: "stale",
      triggerType: "user_message",
      model: "test-model",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("conversation");

    const [inv] = await db
      .select()
      .from(v11Invocation)
      .where(eq(v11Invocation.id, "run-003"))
      .limit(1);
    expect(inv?.executionState).toBe("lost");
  });

  it("status=failed 时填充 errorCode 和 errorSummary", async () => {
    const userId = "user-run-004";
    await setupUser(userId, "ext-run-004");

    await db.insert(Thread).values({
      id: "thread-run-004",
      title: "失败测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(ThreadRun).values({
      id: "run-004",
      threadId: "thread-run-004",
      status: "failed",
      triggerType: "user_message",
      model: "test-model",
      error: "模型调用超时",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("conversation");

    const [inv] = await db
      .select()
      .from(v11Invocation)
      .where(eq(v11Invocation.id, "run-004"))
      .limit(1);
    expect(inv?.errorCode).toBe("legacy_failed");
    expect(inv?.errorSummary).toBe("模型调用超时");
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 端到端 conversation 域迁移
// ═══════════════════════════════════════════════════════════

describe("S13-C03 conversation 域端到端迁移", () => {
  it("完整 conversation 域迁移：Thread/Message/ThreadEvent/ThreadRun 顺序执行", async () => {
    const userId = "user-e2e-conv-001";
    await setupUser(userId, "ext-e2e-conv-001");

    // 插入 Thread
    await db.insert(Thread).values({
      id: "thread-e2e-001",
      title: "端到端会话",
      userId,
      status: "executing",
      model: "e2e-model",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T01:00:00Z"),
    });

    // 插入 Message
    await db.insert(Message).values({
      id: "msg-e2e-001",
      threadId: "thread-e2e-001",
      role: "user",
      type: "user_input",
      parts: [{ type: "text", text: "端到端用户消息" }],
      createdAt: new Date("2024-01-01T00:10:00Z"),
    });
    await db.insert(Message).values({
      id: "msg-e2e-002",
      threadId: "thread-e2e-001",
      role: "assistant",
      type: "assistant_text",
      parts: [{ type: "text", text: "端到端 Agent 回答" }],
      runId: "run-e2e-001",
      createdAt: new Date("2024-01-01T00:11:00Z"),
    });

    // 插入 ThreadEvent
    await db.insert(ThreadEvent).values({
      id: "evt-e2e-001",
      threadId: "thread-e2e-001",
      sequence: 1,
      type: "agent.started",
      payload: { runId: "run-e2e-001" },
      runId: "run-e2e-001",
      createdAt: new Date("2024-01-01T00:10:30Z"),
    });

    // 插入 ThreadRun
    await db.insert(ThreadRun).values({
      id: "run-e2e-001",
      threadId: "thread-e2e-001",
      status: "completed",
      triggerType: "user_message",
      triggerMessageId: "msg-e2e-001",
      model: "e2e-model",
      startedAt: new Date("2024-01-01T00:10:05Z"),
      finishedAt: new Date("2024-01-01T00:11:30Z"),
      createdAt: new Date("2024-01-01T00:10:05Z"),
      updatedAt: new Date("2024-01-01T00:11:30Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("conversation");

    // 汇总验证
    expect(result.totalSourceCount).toBe(5); // 1 Thread + 2 Message + 1 ThreadEvent + 1 ThreadRun
    expect(result.totalAnomalyCount).toBe(0);

    // Thread: 1 目标
    const threadTable = result.tables.find((t) => t.sourceTable === "Thread");
    expect(threadTable?.targetCount).toBe(1);

    // Message: 2 目标
    const messageTable = result.tables.find((t) => t.sourceTable === "Message");
    expect(messageTable?.targetCount).toBe(2);

    // ThreadEvent: 1 目标
    const evtTable = result.tables.find((t) => t.sourceTable === "ThreadEvent");
    expect(evtTable?.targetCount).toBe(1);

    // ThreadRun: 2 目标（Invocation + InvocationAttempt）
    const runTable = result.tables.find((t) => t.sourceTable === "ThreadRun");
    expect(runTable?.targetCount).toBe(2);

    // 验证 V11 表实际写入
    const threads = await db.select().from(v11Thread);
    expect(threads.length).toBe(1);

    const items = await db.select().from(v11ThreadItem);
    expect(items.length).toBe(2);
    // itemSequence 应为 1 和 2
    const sequences = items.map((i) => i.itemSequence).sort();
    expect(sequences).toEqual([1, 2]);

    const events = await db.select().from(v11ThreadEvent);
    expect(events.length).toBe(1);

    const invs = await db.select().from(v11Invocation);
    expect(invs.length).toBe(1);
    expect(invs[0]?.triggerItemId).toBe("msg-e2e-001");

    const attempts = await db.select().from(v11InvocationAttempt);
    expect(attempts.length).toBe(1);
  });

  it("幂等性：二次运行跳过所有已迁移记录", async () => {
    const userId = "user-idem-conv-001";
    await setupUser(userId, "ext-idem-conv-001");

    await db.insert(Thread).values({
      id: "thread-idem-001",
      title: "幂等测试",
      userId,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(Message).values({
      id: "msg-idem-001",
      threadId: "thread-idem-001",
      role: "user",
      type: "user_input",
      parts: [{ type: "text", text: "幂等消息" }],
      createdAt: new Date(),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();

    // 第一次运行
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result1 = await runner1.runDomain("conversation");
    expect(result1.totalTargetCount).toBeGreaterThan(0);

    // 记录第一次的 V11 表行数
    const threadCount1 = (await db.select().from(v11Thread)).length;
    const itemCount1 = (await db.select().from(v11ThreadItem)).length;

    // 第二次运行：应全部跳过，不产生新目标
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runDomain("conversation");

    expect(result2.totalTargetCount).toBe(0);
    expect(result2.totalSkipCount).toBe(2); // 2 条源记录全部跳过

    // V11 表行数不变
    const threadCount2 = (await db.select().from(v11Thread)).length;
    const itemCount2 = (await db.select().from(v11ThreadItem)).length;
    expect(threadCount2).toBe(threadCount1);
    expect(itemCount2).toBe(itemCount1);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. createConversationTransformers 工厂
// ═══════════════════════════════════════════════════════════

describe("S13-C03 createConversationTransformers 工厂", () => {
  it("返回 4 个转换器", () => {
    const transformers = createConversationTransformers();
    expect(transformers.size).toBe(4);
    expect(transformers.has("Thread")).toBe(true);
    expect(transformers.has("Message")).toBe(true);
    expect(transformers.has("ThreadEvent")).toBe(true);
    expect(transformers.has("ThreadRun")).toBe(true);
  });

  it("每个转换器是函数类型", () => {
    const transformers = createConversationTransformers();
    for (const [, transformer] of transformers) {
      expect(typeof transformer).toBe("function");
    }
  });

  it("工厂每次调用返回独立 Map 实例", () => {
    const t1 = createConversationTransformers();
    const t2 = createConversationTransformers();
    expect(t1).not.toBe(t2);
    expect(t1.size).toBe(t2.size);
  });
});
