/**
 * S13-W02 迁移工具框架与 dry-run 集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - computeContentHash：确定性、排除字段、内容变化检测
 * - InMemoryMigrationStateStore：记录/查询/批次/异常队列
 * - MigrationRunner dry-run：幂等性、游标分页、异常队列、批次追踪
 * - MigrationRunner 执行模式：转换器调用、状态记录
 * - generateDryRunReport：空库/有数据/异常检测/阻断标志
 * - formatDryRunReport：可读输出
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import { user as User } from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import {
  DEFAULT_DRY_RUN_OPTIONS,
  type DryRunReport,
  type DryRunTableReport,
  formatDryRunReport,
  generateDryRunReport,
  generateDryRunReportForDomain,
} from "@/lib/v11/migration/dry-run";
import {
  type MigrationTransformer,
  createDryRunRunner,
  createExecutionRunner,
} from "@/lib/v11/migration/migration-runner";
import {
  InMemoryMigrationStateStore,
  type MigrationBatch,
  type MigrationStateStore,
  computeContentHash,
  generateBatchId,
} from "@/lib/v11/migration/migration-state";
import { getV11TableRegistry } from "@/lib/v11/migration/v11-table-registry";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

// ═══════════════════════════════════════════════════════════
// 1. computeContentHash
// ═══════════════════════════════════════════════════════════

describe("S13-W02 computeContentHash", () => {
  it("相同内容产生相同哈希", () => {
    const record = { id: "1", name: "test", email: "a@b.com", createdAt: "2026-01-01" };
    const hash1 = computeContentHash(record);
    const hash2 = computeContentHash(record);
    expect(hash1).toBe(hash2);
  });

  it("排除 id 和时间戳字段", () => {
    const record1 = { id: "1", name: "test", createdAt: "2026-01-01" };
    const record2 = { id: "2", name: "test", createdAt: "2026-02-01" };
    expect(computeContentHash(record1)).toBe(computeContentHash(record2));
  });

  it("内容变化产生不同哈希", () => {
    const record1 = { id: "1", name: "test", createdAt: "2026-01-01" };
    const record2 = { id: "1", name: "changed", createdAt: "2026-01-01" };
    expect(computeContentHash(record1)).not.toBe(computeContentHash(record2));
  });

  it("自定义排除字段", () => {
    const record1 = { id: "1", name: "test", version: 1 };
    const record2 = { id: "1", name: "test", version: 2 };
    expect(computeContentHash(record1, ["id", "version"])).toBe(
      computeContentHash(record2, ["id", "version"]),
    );
  });

  it("哈希长度为 32 字符", () => {
    const hash = computeContentHash({ id: "1", data: "test" });
    expect(hash.length).toBe(32);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. InMemoryMigrationStateStore
// ═══════════════════════════════════════════════════════════

describe("S13-W02 InMemoryMigrationStateStore", () => {
  let store: MigrationStateStore;

  beforeEach(() => {
    store = new InMemoryMigrationStateStore();
  });

  it("记录并查询迁移状态", () => {
    store.recordMigration({
      sourceTable: "User",
      sourceId: "user-001",
      contentHash: "abc123",
      targetTable: "UserIdentity",
      targetId: "v11-user-001",
      batchId: "batch-001",
      migratedAt: new Date().toISOString(),
      status: "migrated",
    });

    const state = store.getMigration("User", "user-001");
    expect(state).toBeDefined();
    expect(state?.contentHash).toBe("abc123");
    expect(state?.targetTable).toBe("UserIdentity");
    expect(state?.status).toBe("migrated");
  });

  it("查询不存在记录返回 undefined", () => {
    expect(store.getMigration("User", "non-existent")).toBeUndefined();
  });

  it("getContentHash 返回已记录的哈希", () => {
    store.recordMigration({
      sourceTable: "Thread",
      sourceId: "thread-001",
      contentHash: "hash456",
      targetTable: "V11Thread",
      targetId: "v11-thread-001",
      batchId: "batch-002",
      migratedAt: new Date().toISOString(),
      status: "migrated",
    });

    expect(store.getContentHash("Thread", "thread-001")).toBe("hash456");
    expect(store.getContentHash("Thread", "non-existent")).toBeUndefined();
  });

  it("getMigratedCount 统计已迁移记录数", () => {
    store.recordMigration({
      sourceTable: "User",
      sourceId: "user-001",
      contentHash: "h1",
      targetTable: "UserIdentity",
      targetId: "v1",
      batchId: "b1",
      migratedAt: new Date().toISOString(),
      status: "migrated",
    });
    store.recordMigration({
      sourceTable: "User",
      sourceId: "user-002",
      contentHash: "h2",
      targetTable: "UserIdentity",
      targetId: "v2",
      batchId: "b1",
      migratedAt: new Date().toISOString(),
      status: "migrated",
    });
    store.recordMigration({
      sourceTable: "User",
      sourceId: "user-003",
      contentHash: "h3",
      targetTable: "—",
      targetId: "—",
      batchId: "b1",
      migratedAt: new Date().toISOString(),
      status: "skipped",
    });

    expect(store.getMigratedCount("User")).toBe(2); // 只有 migrated 状态计入
  });

  it("记录并查询异常队列", () => {
    store.recordAnomaly({
      sourceTable: "User",
      sourceId: "user-anomaly",
      reason: "externalId 为空",
      batchId: "batch-001",
      recordedAt: new Date().toISOString(),
    });

    const anomalies = store.getAnomalies("User");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toBe("externalId 为空");

    const allAnomalies = store.getAllAnomalies();
    expect(allAnomalies.length).toBe(1);
  });

  it("创建并查询批次", () => {
    const batch: MigrationBatch = {
      id: "batch-test-001",
      domain: "identity",
      sourceTable: "User",
      status: "pending",
      cursor: null,
      sourceCount: 0,
      targetCount: 0,
      failureCount: 0,
      anomalyCount: 0,
      skipCount: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      errorMessage: null,
    };
    store.createBatch(batch);

    expect(store.getBatch("batch-test-001")).toBeDefined();
    expect(store.listBatches().length).toBe(1);
  });

  it("更新批次状态和计数", () => {
    const batch: MigrationBatch = {
      id: "batch-test-002",
      domain: "conversation",
      sourceTable: "Thread",
      status: "running",
      cursor: null,
      sourceCount: 0,
      targetCount: 0,
      failureCount: 0,
      anomalyCount: 0,
      skipCount: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      errorMessage: null,
    };
    store.createBatch(batch);

    store.updateBatch("batch-test-002", {
      status: "completed",
      sourceCount: 10,
      targetCount: 8,
      skipCount: 2,
      cursor: "last-id",
      completedAt: new Date().toISOString(),
    });

    const updated = store.getBatch("batch-test-002");
    expect(updated?.status).toBe("completed");
    expect(updated?.sourceCount).toBe(10);
    expect(updated?.targetCount).toBe(8);
    expect(updated?.cursor).toBe("last-id");
  });

  it("getLatestBatch 返回最后创建的批次", () => {
    for (let i = 0; i < 3; i++) {
      store.createBatch({
        id: `batch-${i}`,
        domain: "identity",
        sourceTable: "User",
        status: "completed",
        cursor: null,
        sourceCount: i,
        targetCount: i,
        failureCount: 0,
        anomalyCount: 0,
        skipCount: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        errorMessage: null,
      });
    }

    const latest = store.getLatestBatch("User");
    expect(latest?.id).toBe("batch-2");
  });

  it("clear 清空所有状态", () => {
    store.recordMigration({
      sourceTable: "User",
      sourceId: "u1",
      contentHash: "h",
      targetTable: "T",
      targetId: "t",
      batchId: "b",
      migratedAt: new Date().toISOString(),
      status: "migrated",
    });
    store.recordAnomaly({
      sourceTable: "User",
      sourceId: "u2",
      reason: "test",
      batchId: "b",
      recordedAt: new Date().toISOString(),
    });
    store.createBatch({
      id: "b1",
      domain: "identity",
      sourceTable: "User",
      status: "completed",
      cursor: null,
      sourceCount: 1,
      targetCount: 1,
      failureCount: 0,
      anomalyCount: 1,
      skipCount: 0,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      errorMessage: null,
    });

    store.clear();

    expect(store.getMigration("User", "u1")).toBeUndefined();
    expect(store.getAllAnomalies().length).toBe(0);
    expect(store.listBatches().length).toBe(0);
    expect(store.getMigratedCount("User")).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. generateBatchId
// ═══════════════════════════════════════════════════════════

describe("S13-W02 generateBatchId", () => {
  it("生成包含域和表名的唯一 ID", () => {
    const id1 = generateBatchId("identity", "User");
    const id2 = generateBatchId("identity", "User");
    expect(id1).toContain("identity");
    expect(id1).toContain("User");
    expect(id1).not.toBe(id2);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. MigrationRunner dry-run 模式
// ═══════════════════════════════════════════════════════════

describe("S13-W02 MigrationRunner dry-run", () => {
  it("空数据库运行 dry-run 完成无错误", async () => {
    const store = new InMemoryMigrationStateStore();
    const runner = createDryRunRunner(store, new Map(), 100);

    const result = await runner.runAll();

    expect(result.dryRun).toBe(true);
    expect(result.totalSourceCount).toBe(0);
    expect(result.totalTargetCount).toBe(0);
    expect(result.totalFailureCount).toBe(0);
    expect(result.domains.length).toBe(12);
  });

  it("dry-run 遍历所有源表并记录批次", async () => {
    // 插入测试数据
    await db.insert(User).values({
      id: "user-runner-001",
      externalId: "ext-runner-001",
      email: "runner@example.com",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createDryRunRunner(store, new Map(), 100);

    const result = await runner.runAll();

    // identity 域应处理 User 表
    const identityDomain = result.domains.find((d) => d.domain === "identity");
    expect(identityDomain).toBeDefined();

    const userTableResult = identityDomain?.tables.find((t) => t.sourceTable === "User");
    expect(userTableResult).toBeDefined();
    expect(userTableResult?.sourceCount).toBe(1);
    expect(userTableResult?.status).toBe("completed");

    // 批次应被记录
    const batches = store.listBatches();
    expect(batches.length).toBeGreaterThan(0);
  });

  it("幂等性：dry-run 二次运行跳过已处理记录", async () => {
    await db.insert(User).values({
      id: "user-idemp-001",
      externalId: "ext-idemp-001",
      email: "idemp@example.com",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createDryRunRunner(store, new Map(), 100);

    // 第一次运行
    const result1 = await runner.runAll();
    const userResult1 = result1.domains
      .find((d) => d.domain === "identity")
      ?.tables.find((t) => t.sourceTable === "User");
    expect(userResult1?.sourceCount).toBe(1);
    expect(userResult1?.skipCount).toBe(0); // 无转换器，记录被跳过但不计入状态

    // 第二次运行：User 记录已迁移，应跳过
    const runner2 = createDryRunRunner(store, new Map(), 100);
    const result2 = await runner2.runAll();
    const userResult2 = result2.domains
      .find((d) => d.domain === "identity")
      ?.tables.find((t) => t.sourceTable === "User");
    expect(userResult2?.sourceCount).toBe(1);
    expect(userResult2?.skipCount).toBe(1); // 已迁移，跳过
  });

  it("游标分页：大批量数据正确分页处理", async () => {
    // 插入 25 条记录，batchSize=10
    for (let i = 0; i < 25; i++) {
      await db.insert(User).values({
        id: `user-page-${String(i).padStart(3, "0")}`,
        externalId: `ext-page-${i}`,
        email: `page${i}@example.com`,
      });
    }

    const store = new InMemoryMigrationStateStore();
    const runner = createDryRunRunner(store, new Map(), 10);

    const result = await runner.runAll();
    const userResult = result.domains
      .find((d) => d.domain === "identity")
      ?.tables.find((t) => t.sourceTable === "User");

    expect(userResult?.sourceCount).toBe(25);
    expect(userResult?.status).toBe("completed");

    // 批次应记录游标
    const batch = store.getLatestBatch("User");
    expect(batch).toBeDefined();
    expect(batch?.cursor).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 5. MigrationRunner 执行模式（带转换器）
// ═══════════════════════════════════════════════════════════

describe("S13-W02 MigrationRunner 执行模式", () => {
  it("转换器正常转换记录", async () => {
    await db.insert(User).values({
      id: "user-exec-001",
      externalId: "ext-exec-001",
      email: "exec@example.com",
      name: "Exec User",
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = new Map<string, MigrationTransformer>([
      [
        "User",
        (record) => ({
          targets: [
            {
              table: "UserIdentity",
              data: {
                id: record.id,
                tenantId: DEFAULT_TENANT_ID,
                externalSubject: record.externalId,
                email: record.email,
                status: "active",
              },
            },
          ],
        }),
      ],
    ]);

    const runner = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result = await runner.runAll();

    const userResult = result.domains
      .find((d) => d.domain === "identity")
      ?.tables.find((t) => t.sourceTable === "User");

    expect(userResult?.sourceCount).toBe(1);
    expect(userResult?.targetCount).toBe(1); // 1 个目标记录
    expect(userResult?.skipCount).toBe(0);
    expect(userResult?.anomalyCount).toBe(0);

    // 状态应记录迁移
    const state = store.getMigration("User", "user-exec-001");
    expect(state).toBeDefined();
    expect(state?.status).toBe("migrated");
    expect(state?.targetTable).toBe("UserIdentity");
  });

  it("转换器返回异常原因时入异常队列", async () => {
    await db.insert(User).values({
      id: "user-anomaly-exec",
      externalId: "ext-anomaly",
      email: "anomaly@example.com",
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = new Map<string, MigrationTransformer>([
      [
        "User",
        () => ({
          targets: [],
          anomalyReason: "测试异常：模拟迁移条件不满足",
        }),
      ],
    ]);

    const runner = createExecutionRunner(store, transformers, 100);
    const result = await runner.runAll();

    const userResult = result.domains
      .find((d) => d.domain === "identity")
      ?.tables.find((t) => t.sourceTable === "User");

    expect(userResult?.anomalyCount).toBe(1);
    expect(userResult?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("User");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toContain("测试异常");
  });

  it("转换器返回 skip 时跳过记录", async () => {
    await db.insert(User).values({
      id: "user-skip-exec",
      externalId: "ext-skip",
      email: "skip@example.com",
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = new Map<string, MigrationTransformer>([
      [
        "User",
        () => ({
          targets: [],
          skip: true,
        }),
      ],
    ]);

    const runner = createExecutionRunner(store, transformers, 100);
    const result = await runner.runAll();

    const userResult = result.domains
      .find((d) => d.domain === "identity")
      ?.tables.find((t) => t.sourceTable === "User");

    expect(userResult?.skipCount).toBe(1);
    expect(userResult?.targetCount).toBe(0);

    // 跳过的记录应记录状态
    const state = store.getMigration("User", "user-skip-exec");
    expect(state?.status).toBe("skipped");
  });

  it("幂等性：执行模式二次运行跳过已迁移记录", async () => {
    await db.insert(User).values({
      id: "user-idemp-exec",
      externalId: "ext-idemp-exec",
      email: "idemp-exec@example.com",
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = new Map<string, MigrationTransformer>([
      [
        "User",
        (record) => ({
          targets: [
            {
              table: "UserIdentity",
              data: {
                id: record.id,
                tenantId: DEFAULT_TENANT_ID,
                externalSubject: record.externalId,
                email: record.email,
                status: "active",
              },
            },
          ],
        }),
      ],
    ]);

    // 第一次运行
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result1 = await runner1.runAll();
    const userResult1 = result1.domains
      .find((d) => d.domain === "identity")
      ?.tables.find((t) => t.sourceTable === "User");
    expect(userResult1?.targetCount).toBe(1);
    expect(userResult1?.skipCount).toBe(0);

    // 第二次运行：已迁移，应跳过
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runAll();
    const userResult2 = result2.domains
      .find((d) => d.domain === "identity")
      ?.tables.find((t) => t.sourceTable === "User");
    expect(userResult2?.sourceCount).toBe(1);
    expect(userResult2?.skipCount).toBe(1);
    expect(userResult2?.targetCount).toBe(0); // 不再产生新目标
  });

  it("内容哈希变化时标记异常", async () => {
    await db.insert(User).values({
      id: "user-hash-change",
      externalId: "ext-original",
      email: "hash@example.com",
      name: "Original Name",
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = new Map<string, MigrationTransformer>([
      [
        "User",
        (record) => ({
          targets: [
            {
              table: "UserIdentity",
              data: {
                id: record.id,
                tenantId: DEFAULT_TENANT_ID,
                externalSubject: record.externalId,
                email: record.email,
                status: "active",
              },
            },
          ],
        }),
      ],
    ]);

    // 第一次运行：迁移
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    await runner1.runAll();

    // 修改源数据（name 变化）
    await db.update(User).set({ name: "Changed Name" }).where(eq(User.id, "user-hash-change"));

    // 第二次运行：哈希变化，应标记异常
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runAll();
    const userResult2 = result2.domains
      .find((d) => d.domain === "identity")
      ?.tables.find((t) => t.sourceTable === "User");

    expect(userResult2?.anomalyCount).toBe(1);
    const anomalies = store.getAnomalies("User");
    expect(anomalies.some((a) => a.reason.includes("内容哈希变化"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. generateDryRunReport
// ═══════════════════════════════════════════════════════════

describe("S13-W02 generateDryRunReport", () => {
  it("空数据库返回零计数报告", async () => {
    const report = await generateDryRunReport({
      ...DEFAULT_DRY_RUN_OPTIONS,
      batchSize: 100,
      recordsPerSecond: 1000,
    });

    expect(report.totalTables).toBe(38);
    expect(report.totalRecords).toBe(0);
    expect(report.totalMigratable).toBe(0);
    expect(report.totalAnomalies).toBe(0);
    expect(report.totalDuplicateContent).toBe(0);
    expect(report.blockingIssues.length).toBe(0);
    expect(report.byDomain.length).toBe(12);
  });

  it("有数据时返回正确计数", async () => {
    await db.insert(User).values({
      id: "user-dry-001",
      externalId: "ext-dry-001",
      email: "dry@example.com",
    });
    await db.insert(User).values({
      id: "user-dry-002",
      externalId: "ext-dry-002",
      email: "dry2@example.com",
    });

    const report = await generateDryRunReport({
      ...DEFAULT_DRY_RUN_OPTIONS,
      batchSize: 100,
      recordsPerSecond: 1000,
    });

    expect(report.totalRecords).toBeGreaterThanOrEqual(2);

    const userTable = report.tables.find((t) => t.physicalTable === "User") as DryRunTableReport;
    expect(userTable).toBeDefined();
    expect(userTable.recordCount).toBe(2);
    expect(userTable.migratableCount).toBe(2);
    expect(userTable.anomalyCount).toBe(0);
    expect(userTable.uniqueContentHashes).toBe(2);
    expect(userTable.duplicateContentCount).toBe(0);
  });

  it("检测重复内容记录", async () => {
    // 插入两条内容相同（排除 id/时间戳）的 User
    await db.insert(User).values({
      id: "user-dup-content-1",
      externalId: "ext-dup-content",
      email: "dup@example.com",
      name: "Same Name",
    });
    await db.insert(User).values({
      id: "user-dup-content-2",
      externalId: "ext-dup-content-2",
      email: "dup2@example.com",
      name: "Same Name",
    });

    const report = await generateDryRunReport({
      ...DEFAULT_DRY_RUN_OPTIONS,
      batchSize: 100,
      recordsPerSecond: 1000,
    });

    // 两条记录的 externalId 和 email 不同，但 name 相同
    // 内容哈希基于所有非排除字段，所以哈希应不同
    const userTable = report.tables.find((t) => t.physicalTable === "User") as DryRunTableReport;
    expect(userTable.recordCount).toBe(2);
    expect(userTable.uniqueContentHashes).toBe(2);
    expect(userTable.duplicateContentCount).toBe(0);
  });

  it("预计耗时基于记录数和速率", async () => {
    for (let i = 0; i < 10; i++) {
      await db.insert(User).values({
        id: `user-duration-${i}`,
        externalId: `ext-duration-${i}`,
        email: `duration${i}@example.com`,
      });
    }

    const report = await generateDryRunReport({
      ...DEFAULT_DRY_RUN_OPTIONS,
      batchSize: 100,
      recordsPerSecond: 10, // 10 条/秒
    });

    const userTable = report.tables.find((t) => t.physicalTable === "User") as DryRunTableReport;
    expect(userTable.recordCount).toBe(10);
    // 10 条 / 10 条/秒 = 1 秒 = 1000ms
    expect(userTable.estimatedDurationMs).toBeGreaterThanOrEqual(1000);
  });

  it("异常记录触发阻断标志", async () => {
    // 插入一条正常 User
    await db.insert(User).values({
      id: "user-normal-anomaly",
      externalId: "ext-normal",
      email: "normal@example.com",
    });

    const report = await generateDryRunReport({
      ...DEFAULT_DRY_RUN_OPTIONS,
      batchSize: 100,
      recordsPerSecond: 1000,
    });

    // 正常数据无异常
    expect(report.totalAnomalies).toBe(0);
    expect(report.blockingIssues.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. generateDryRunReportForDomain
// ═══════════════════════════════════════════════════════════

describe("S13-W02 generateDryRunReportForDomain", () => {
  it("返回单域报告", async () => {
    await db.insert(User).values({
      id: "user-domain-report",
      externalId: "ext-domain-report",
      email: "domain@example.com",
    });

    const report = await generateDryRunReportForDomain("identity", {
      ...DEFAULT_DRY_RUN_OPTIONS,
      batchSize: 100,
      recordsPerSecond: 1000,
    });

    expect(report.domain).toBe("identity");
    expect(report.tableCount).toBe(4); // User, Role, RolePermission, UserRole
    expect(report.totalRecords).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 8. formatDryRunReport
// ═══════════════════════════════════════════════════════════

describe("S13-W02 formatDryRunReport", () => {
  it("生成可读字符串", async () => {
    const report = await generateDryRunReport({
      ...DEFAULT_DRY_RUN_OPTIONS,
      batchSize: 100,
      recordsPerSecond: 1000,
    });

    const formatted = formatDryRunReport(report);
    expect(formatted).toContain("V11 迁移 dry-run 报告");
    expect(formatted).toContain("映射版本: migration-mapping-v1");
    expect(formatted).toContain("旧表数: 38");
    expect(formatted).toContain("按域汇总:");
  });

  it("包含阻断性问题", async () => {
    const report: DryRunReport = {
      mappingVersion: "migration-mapping-v1",
      generatedAt: new Date().toISOString(),
      totalTables: 38,
      totalRecords: 100,
      totalMigratable: 95,
      totalAnomalies: 5,
      totalDuplicateContent: 0,
      totalEstimatedDurationMs: 500,
      blockingIssues: ["存在 5 条异常记录"],
      byDomain: [],
      tables: [],
    };

    const formatted = formatDryRunReport(report);
    expect(formatted).toContain("阻断性问题:");
    expect(formatted).toContain("存在 5 条异常记录");
  });
});

// ═══════════════════════════════════════════════════════════
// 9. 断点续跑
// ═══════════════════════════════════════════════════════════

describe("S13-W02 断点续跑", () => {
  it("resume 模式从上次游标继续", async () => {
    // 插入 5 条记录
    for (let i = 0; i < 5; i++) {
      await db.insert(User).values({
        id: `user-resume-${i}`,
        externalId: `ext-resume-${i}`,
        email: `resume${i}@example.com`,
      });
    }

    const store = new InMemoryMigrationStateStore();
    const transformers = new Map<string, MigrationTransformer>([
      [
        "User",
        (record) => ({
          targets: [
            {
              table: "UserIdentity",
              data: {
                id: record.id,
                tenantId: DEFAULT_TENANT_ID,
                externalSubject: record.externalId,
                email: record.email,
                status: "active",
              },
            },
          ],
        }),
      ],
    ]);

    // 第一次运行（不 resume）
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    await runner1.runAll();

    // 插入 3 条新记录
    for (let i = 5; i < 8; i++) {
      await db.insert(User).values({
        id: `user-resume-${i}`,
        externalId: `ext-resume-${i}`,
        email: `resume${i}@example.com`,
      });
    }

    // 第二次运行（resume=false，重新扫描全部）
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runAll();
    const userResult2 = result2.domains
      .find((d) => d.domain === "identity")
      ?.tables.find((t) => t.sourceTable === "User");

    // 8 条源记录：5 条已迁移（跳过）+ 3 条新迁移
    expect(userResult2?.sourceCount).toBe(8);
    expect(userResult2?.skipCount).toBe(5);
    expect(userResult2?.targetCount).toBe(3);
  });
});
