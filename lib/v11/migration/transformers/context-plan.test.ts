/**
 * S13-C03 context_plan 域迁移转换器集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - ContextSummary 转换器：正常迁移、threadId 不存在异常、summaryText→summaryRedacted 映射
 * - ThreadPlan 转换器：正常迁移、threadId 不存在异常、status→goalState 映射
 * - ThreadPlanItem 转换器：正常迁移（V11Goal + V11ThreadItem）、planId 不存在异常、status 映射
 * - 端到端 context_plan 域迁移：ContextSummary/ThreadPlan/ThreadPlanItem 顺序执行
 * - 幂等性：二次运行跳过已迁移记录
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import {
  contextSummary as ContextSummary,
  thread as Thread,
  threadPlan as ThreadPlan,
  threadPlanItem as ThreadPlanItem,
  user as User,
} from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { createExecutionRunner } from "@/lib/v11/migration/migration-runner";
import type { MigrationTransformer } from "@/lib/v11/migration/migration-runner";
import { InMemoryMigrationStateStore } from "@/lib/v11/migration/migration-state";
import { createContextPlanTransformers } from "@/lib/v11/migration/transformers/context-plan";
import { createConversationTransformers } from "@/lib/v11/migration/transformers/conversation";
import { createIdentityTransformers } from "@/lib/v11/migration/transformers/identity";
import { getV11TableRegistry } from "@/lib/v11/migration/v11-table-registry";
import { contextCheckpoint as v11ContextCheckpoint } from "@/lib/v11/schema/context-checkpoint";
import { v11Goal, v11ThreadItem } from "@/lib/v11/schema/conversation";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/** 合并 identity + conversation + context_plan 转换器（Goal 迁移依赖 V11Thread 先迁）。 */
function createMergedTransformers(): ReadonlyMap<string, MigrationTransformer> {
  return new Map<string, MigrationTransformer>([
    ...createIdentityTransformers(),
    ...createConversationTransformers(),
    ...createContextPlanTransformers(),
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

/** 插入 Thread 并迁移 conversation 域，创建 V11Thread（Goal FK 依赖）。 */
async function setupThread(threadId: string, userId: string, title = "测试会话"): Promise<void> {
  await db.insert(Thread).values({
    id: threadId,
    title,
    userId,
    status: "idle",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  });
  // 迁移 conversation 域创建 V11Thread（V11Goal.threadId 是 DB FK）
  const store = new InMemoryMigrationStateStore();
  const runner = createExecutionRunner(
    store,
    new Map<string, MigrationTransformer>([
      ...createIdentityTransformers(),
      ...createConversationTransformers(),
    ]),
    100,
    false,
    getV11TableRegistry(),
  );
  await runner.runDomain("conversation");
}

// ═══════════════════════════════════════════════════════════
// 1. ContextSummary 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 ContextSummary 转换器", () => {
  it("正常 ContextSummary 迁移为 V11ContextCheckpoint", async () => {
    const userId = "user-cs-001";
    await setupUser(userId, "ext-cs-001");
    await setupThread("thread-cs-001", userId);

    const scope = { messageIds: ["msg-001", "msg-002"] };
    await db.insert(ContextSummary).values({
      id: "cs-001",
      threadId: "thread-cs-001",
      type: "turn",
      scope,
      summaryText: "这是摘要正文",
      checksum: "abc123",
      tokenEstimate: 100,
      originalTokenEstimate: 500,
      protectedRefs: [],
      createdAt: new Date("2024-02-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("context_plan");

    const csTable = result.tables.find((t) => t.sourceTable === "ContextSummary");
    expect(csTable?.sourceCount).toBe(1);
    expect(csTable?.targetCount).toBe(1);
    expect(csTable?.anomalyCount).toBe(0);

    // 验证 V11ContextCheckpoint 写入
    const [row] = await db
      .select()
      .from(v11ContextCheckpoint)
      .where(eq(v11ContextCheckpoint.id, "cs-001"))
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(row?.checkpointType).toBe("compression");
    expect(row?.summaryRedacted).toBe("这是摘要正文");
    expect(row?.summaryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row?.summaryRef).toBeNull();
    expect(row?.inputTokens).toBe(500);
    expect(row?.retainedTokens).toBe(100);
    expect(row?.compressedTokens).toBe(400);
    expect(row?.sourceRangesHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("threadId 不存在时入异常队列", async () => {
    // FK 约束阻止直接插入孤儿 ContextSummary，直接调用转换器验证防御逻辑
    const transformers = createContextPlanTransformers();
    const transformer = transformers.get("ContextSummary");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "cs-orphan",
      threadId: "nonexistent-thread",
      type: "turn",
      scope: { messageIds: [] },
      summaryText: "孤儿摘要",
      checksum: "abc",
      tokenEstimate: 0,
      originalTokenEstimate: 0,
      protectedRefs: [],
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("Thread nonexistent-thread 不存在");
  });

  it("supersededById 保留至 sourceRanges", async () => {
    const userId = "user-cs-002";
    await setupUser(userId, "ext-cs-002");
    await setupThread("thread-cs-002", userId);

    await db.insert(ContextSummary).values({
      id: "cs-002",
      threadId: "thread-cs-002",
      type: "turn",
      scope: { messageIds: ["msg-001"] },
      summaryText: "旧摘要",
      checksum: "abc123",
      tokenEstimate: 50,
      originalTokenEstimate: 200,
      protectedRefs: [],
      supersededById: "cs-003",
      createdAt: new Date("2024-02-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("context_plan");

    const [row] = await db
      .select()
      .from(v11ContextCheckpoint)
      .where(eq(v11ContextCheckpoint.id, "cs-002"))
      .limit(1);
    expect(row).toBeDefined();
    // sourceRangesJson 应包含 memory 类型 range，含 source id 和 supersededById
    const sourceRanges = row?.sourceRangesJson as Array<{ type: string; resourceIds?: string[] }>;
    const memoryRange = sourceRanges.find((r) => r.type === "memory");
    expect(memoryRange).toBeDefined();
    expect(memoryRange?.resourceIds).toContain("cs-002");
    expect(memoryRange?.resourceIds).toContain("cs-003");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. ThreadPlan 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 ThreadPlan 转换器", () => {
  it("正常 ThreadPlan 迁移为 V11Goal", async () => {
    const userId = "user-tp-001";
    await setupUser(userId, "ext-tp-001");
    await setupThread("thread-tp-001", userId);

    await db.insert(ThreadPlan).values({
      id: "tp-001",
      threadId: "thread-tp-001",
      title: "测试计划",
      status: "active",
      source: "agent",
      createdAt: new Date("2024-03-01T00:00:00Z"),
      updatedAt: new Date("2024-03-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("context_plan");

    const tpTable = result.tables.find((t) => t.sourceTable === "ThreadPlan");
    expect(tpTable?.sourceCount).toBe(1);
    expect(tpTable?.targetCount).toBe(1);
    expect(tpTable?.anomalyCount).toBe(0);

    const [goal] = await db.select().from(v11Goal).where(eq(v11Goal.id, "tp-001")).limit(1);
    expect(goal).toBeDefined();
    expect(goal?.threadId).toBe("thread-tp-001");
    expect(goal?.objective).toBe("测试计划");
    expect(goal?.goalState).toBe("active");
    // source 保留至 currentStateJson
    expect(goal?.currentStateJson).toEqual({ legacySource: "agent" });
    expect(goal?.completedAt).toBeNull();
  });

  it("threadId 不存在时入异常队列", async () => {
    // FK 约束阻止直接插入孤儿 ThreadPlan，直接调用转换器验证防御逻辑
    const transformers = createContextPlanTransformers();
    const transformer = transformers.get("ThreadPlan");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "tp-orphan",
      threadId: "nonexistent-thread",
      title: "孤儿计划",
      status: "active",
      source: "system",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("Thread nonexistent-thread 不存在");
  });

  it("status=completed 映射为 goalState=completed 且填 completedAt", async () => {
    const userId = "user-tp-002";
    await setupUser(userId, "ext-tp-002");
    await setupThread("thread-tp-002", userId);

    const updatedAt = new Date("2024-03-02T00:00:00Z");
    await db.insert(ThreadPlan).values({
      id: "tp-002",
      threadId: "thread-tp-002",
      title: "已完成计划",
      status: "completed",
      source: "user",
      createdAt: new Date("2024-03-01T00:00:00Z"),
      updatedAt,
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("context_plan");

    const [goal] = await db.select().from(v11Goal).where(eq(v11Goal.id, "tp-002")).limit(1);
    expect(goal?.goalState).toBe("completed");
    expect(goal?.completedAt).toEqual(updatedAt);
  });

  it("status=abandoned 映射为 goalState=cancelled", async () => {
    const userId = "user-tp-003";
    await setupUser(userId, "ext-tp-003");
    await setupThread("thread-tp-003", userId);

    await db.insert(ThreadPlan).values({
      id: "tp-003",
      threadId: "thread-tp-003",
      title: "已放弃计划",
      status: "abandoned",
      source: "system",
      createdAt: new Date("2024-03-01T00:00:00Z"),
      updatedAt: new Date("2024-03-02T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("context_plan");

    const [goal] = await db.select().from(v11Goal).where(eq(v11Goal.id, "tp-003")).limit(1);
    expect(goal?.goalState).toBe("cancelled");
    expect(goal?.completedAt).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. ThreadPlanItem 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 ThreadPlanItem 转换器", () => {
  it("正常 ThreadPlanItem 迁移为 V11Goal + V11ThreadItem", async () => {
    const userId = "user-tpi-001";
    await setupUser(userId, "ext-tpi-001");
    await setupThread("thread-tpi-001", userId);

    // 先插入 ThreadPlan（planId FK 依赖）
    await db.insert(ThreadPlan).values({
      id: "tpi-plan-001",
      threadId: "thread-tpi-001",
      title: "父计划",
      status: "active",
      source: "agent",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-01T00:00:00Z"),
    });

    await db.insert(ThreadPlanItem).values({
      id: "tpi-001",
      planId: "tpi-plan-001",
      threadId: "thread-tpi-001",
      position: 1,
      title: "第一个任务",
      status: "pending",
      evidence: { toolRunIds: ["tr-001"] },
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("context_plan");

    const tpiTable = result.tables.find((t) => t.sourceTable === "ThreadPlanItem");
    expect(tpiTable?.sourceCount).toBe(1);
    expect(tpiTable?.targetCount).toBe(2); // V11Goal + V11ThreadItem
    expect(tpiTable?.anomalyCount).toBe(0);

    // 验证 V11Goal
    const [goal] = await db.select().from(v11Goal).where(eq(v11Goal.id, "tpi-001")).limit(1);
    expect(goal).toBeDefined();
    expect(goal?.threadId).toBe("thread-tpi-001");
    expect(goal?.objective).toBe("第一个任务");
    expect(goal?.goalState).toBe("active");

    // 验证 V11ThreadItem
    const [item] = await db
      .select()
      .from(v11ThreadItem)
      .where(eq(v11ThreadItem.id, "tpi-001"))
      .limit(1);
    expect(item).toBeDefined();
    expect(item?.threadId).toBe("thread-tpi-001");
    expect(item?.itemType).toBe("user_guidance");
    expect(item?.itemState).toBe("pending");
    expect(item?.authorType).toBe("system");
    // contentJson 不含 evidence
    const content = item?.contentJson as Record<string, unknown>;
    expect(content.title).toBe("第一个任务");
    expect(content.planId).toBe("tpi-plan-001");
    expect(content.position).toBe(1);
    expect(content).not.toHaveProperty("evidence");
  });

  it("planId 不存在时入异常队列", async () => {
    // FK 约束阻止直接插入孤儿 ThreadPlanItem，直接调用转换器验证防御逻辑
    const transformers = createContextPlanTransformers();
    const transformer = transformers.get("ThreadPlanItem");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "tpi-orphan",
      planId: "nonexistent-plan",
      threadId: "nonexistent-thread",
      position: 1,
      title: "孤儿条目",
      status: "pending",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("ThreadPlan nonexistent-plan 不存在");
  });

  it("status=completed 映射为 itemState=completed + goalState=completed", async () => {
    const userId = "user-tpi-002";
    await setupUser(userId, "ext-tpi-002");
    await setupThread("thread-tpi-002", userId);

    await db.insert(ThreadPlan).values({
      id: "tpi-plan-002",
      threadId: "thread-tpi-002",
      title: "父计划2",
      status: "active",
      source: "agent",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-01T00:00:00Z"),
    });

    await db.insert(ThreadPlanItem).values({
      id: "tpi-002",
      planId: "tpi-plan-002",
      threadId: "thread-tpi-002",
      position: 1,
      title: "已完成任务",
      status: "completed",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-02T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("context_plan");

    const [goal] = await db.select().from(v11Goal).where(eq(v11Goal.id, "tpi-002")).limit(1);
    expect(goal?.goalState).toBe("completed");
    expect(goal?.completedAt).not.toBeNull();

    const [item] = await db
      .select()
      .from(v11ThreadItem)
      .where(eq(v11ThreadItem.id, "tpi-002"))
      .limit(1);
    expect(item?.itemState).toBe("completed");
  });

  it("status=failed 映射为 itemState=failed + goalState=blocked", async () => {
    const userId = "user-tpi-003";
    await setupUser(userId, "ext-tpi-003");
    await setupThread("thread-tpi-003", userId);

    await db.insert(ThreadPlan).values({
      id: "tpi-plan-003",
      threadId: "thread-tpi-003",
      title: "父计划3",
      status: "active",
      source: "agent",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-01T00:00:00Z"),
    });

    await db.insert(ThreadPlanItem).values({
      id: "tpi-003",
      planId: "tpi-plan-003",
      threadId: "thread-tpi-003",
      position: 1,
      title: "失败任务",
      status: "failed",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-02T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("context_plan");

    const [goal] = await db.select().from(v11Goal).where(eq(v11Goal.id, "tpi-003")).limit(1);
    expect(goal?.goalState).toBe("blocked");

    const [item] = await db
      .select()
      .from(v11ThreadItem)
      .where(eq(v11ThreadItem.id, "tpi-003"))
      .limit(1);
    expect(item?.itemState).toBe("failed");
  });

  it("status=cancelled 映射为 itemState=cancelled + goalState=cancelled", async () => {
    const userId = "user-tpi-004";
    await setupUser(userId, "ext-tpi-004");
    await setupThread("thread-tpi-004", userId);

    await db.insert(ThreadPlan).values({
      id: "tpi-plan-004",
      threadId: "thread-tpi-004",
      title: "父计划4",
      status: "active",
      source: "agent",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-01T00:00:00Z"),
    });

    await db.insert(ThreadPlanItem).values({
      id: "tpi-004",
      planId: "tpi-plan-004",
      threadId: "thread-tpi-004",
      position: 1,
      title: "取消任务",
      status: "cancelled",
      createdAt: new Date("2024-04-01T00:00:00Z"),
      updatedAt: new Date("2024-04-02T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("context_plan");

    const [goal] = await db.select().from(v11Goal).where(eq(v11Goal.id, "tpi-004")).limit(1);
    expect(goal?.goalState).toBe("cancelled");

    const [item] = await db
      .select()
      .from(v11ThreadItem)
      .where(eq(v11ThreadItem.id, "tpi-004"))
      .limit(1);
    expect(item?.itemState).toBe("cancelled");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. 端到端 context_plan 域迁移
// ═══════════════════════════════════════════════════════════

describe("S13-C03 context_plan 域端到端迁移", () => {
  it("完整 context_plan 域迁移：ContextSummary/ThreadPlan/ThreadPlanItem 顺序执行", async () => {
    const userId = "user-e2e-cp-001";
    await setupUser(userId, "ext-e2e-cp-001");
    await setupThread("thread-e2e-cp-001", userId, "端到端会话");

    // 插入 ContextSummary
    await db.insert(ContextSummary).values({
      id: "cs-e2e-001",
      threadId: "thread-e2e-cp-001",
      type: "turn",
      scope: { messageIds: ["msg-e2e-001"] },
      summaryText: "端到端摘要",
      checksum: "e2e-checksum-1",
      tokenEstimate: 80,
      originalTokenEstimate: 300,
      protectedRefs: [],
      createdAt: new Date("2024-05-01T00:00:00Z"),
    });

    // 插入 ThreadPlan
    await db.insert(ThreadPlan).values({
      id: "tp-e2e-001",
      threadId: "thread-e2e-cp-001",
      title: "端到端计划",
      status: "active",
      source: "agent",
      createdAt: new Date("2024-05-01T00:00:00Z"),
      updatedAt: new Date("2024-05-01T00:00:00Z"),
    });

    // 插入 ThreadPlanItem
    await db.insert(ThreadPlanItem).values({
      id: "tpi-e2e-001",
      planId: "tp-e2e-001",
      threadId: "thread-e2e-cp-001",
      position: 1,
      title: "端到端任务",
      status: "in_progress",
      createdAt: new Date("2024-05-01T00:00:00Z"),
      updatedAt: new Date("2024-05-01T00:00:00Z"),
    });
    await db.insert(ThreadPlanItem).values({
      id: "tpi-e2e-002",
      planId: "tp-e2e-001",
      threadId: "thread-e2e-cp-001",
      position: 2,
      title: "端到端任务2",
      status: "completed",
      createdAt: new Date("2024-05-01T00:00:00Z"),
      updatedAt: new Date("2024-05-02T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMergedTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("context_plan");

    // 汇总验证
    expect(result.totalSourceCount).toBe(4); // 1 CS + 1 TP + 2 TPI
    expect(result.totalAnomalyCount).toBe(0);

    // ContextSummary: 1 目标
    const csTable = result.tables.find((t) => t.sourceTable === "ContextSummary");
    expect(csTable?.targetCount).toBe(1);

    // ThreadPlan: 1 目标
    const tpTable = result.tables.find((t) => t.sourceTable === "ThreadPlan");
    expect(tpTable?.targetCount).toBe(1);

    // ThreadPlanItem: 4 目标（2 items × (V11Goal + V11ThreadItem)）
    const tpiTable = result.tables.find((t) => t.sourceTable === "ThreadPlanItem");
    expect(tpiTable?.targetCount).toBe(4);

    // 验证 V11 表实际写入
    const checkpoints = await db.select().from(v11ContextCheckpoint);
    expect(checkpoints.length).toBe(1);

    const goals = await db.select().from(v11Goal);
    // 1 (ThreadPlan) + 2 (ThreadPlanItem) = 3 goals
    expect(goals.length).toBe(3);

    const items = await db.select().from(v11ThreadItem);
    expect(items.length).toBe(2);
    // itemSequence 应为 1 和 2（在 Thread 内递增）
    const sequences = items.map((i) => i.itemSequence).sort();
    expect(sequences).toEqual([1, 2]);
  });

  it("幂等性：二次运行跳过所有已迁移记录", async () => {
    const userId = "user-idem-cp-001";
    await setupUser(userId, "ext-idem-cp-001");
    await setupThread("thread-idem-cp-001", userId);

    await db.insert(ThreadPlan).values({
      id: "tp-idem-001",
      threadId: "thread-idem-cp-001",
      title: "幂等计划",
      status: "active",
      source: "agent",
      createdAt: new Date("2024-06-01T00:00:00Z"),
      updatedAt: new Date("2024-06-01T00:00:00Z"),
    });
    await db.insert(ThreadPlanItem).values({
      id: "tpi-idem-001",
      planId: "tp-idem-001",
      threadId: "thread-idem-cp-001",
      position: 1,
      title: "幂等任务",
      status: "pending",
      createdAt: new Date("2024-06-01T00:00:00Z"),
      updatedAt: new Date("2024-06-01T00:00:00Z"),
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMergedTransformers();

    // 第一次运行
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result1 = await runner1.runDomain("context_plan");
    expect(result1.totalTargetCount).toBeGreaterThan(0);

    // 记录第一次的 V11 表行数
    const goalCount1 = (await db.select().from(v11Goal)).length;
    const itemCount1 = (await db.select().from(v11ThreadItem)).length;

    // 第二次运行：应全部跳过，不产生新目标
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runDomain("context_plan");

    expect(result2.totalTargetCount).toBe(0);
    expect(result2.totalSkipCount).toBe(2); // 2 条源记录全部跳过

    // V11 表行数不变
    const goalCount2 = (await db.select().from(v11Goal)).length;
    const itemCount2 = (await db.select().from(v11ThreadItem)).length;
    expect(goalCount2).toBe(goalCount1);
    expect(itemCount2).toBe(itemCount1);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. createContextPlanTransformers 工厂
// ═══════════════════════════════════════════════════════════

describe("S13-C03 createContextPlanTransformers 工厂", () => {
  it("返回 3 个转换器", () => {
    const transformers = createContextPlanTransformers();
    expect(transformers.size).toBe(3);
    expect(transformers.has("ContextSummary")).toBe(true);
    expect(transformers.has("ThreadPlan")).toBe(true);
    expect(transformers.has("ThreadPlanItem")).toBe(true);
  });

  it("每个转换器是函数类型", () => {
    const transformers = createContextPlanTransformers();
    for (const [, transformer] of transformers) {
      expect(typeof transformer).toBe("function");
    }
  });

  it("工厂每次调用返回独立 Map 实例", () => {
    const t1 = createContextPlanTransformers();
    const t2 = createContextPlanTransformers();
    expect(t1).not.toBe(t2);
    expect(t1.size).toBe(t2.size);
  });
});
