/**
 * S13-C03 memory 域迁移转换器集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - MemoryEntry 转换器：正常迁移、scopeRef 为空异常、status 映射（active/revoked）
 * - MemoryEmbedding 转换器：正常迁移、memoryId 不存在异常
 * - 端到端 memory 域迁移：MemoryEntry → MemoryEmbedding 顺序执行
 * - createMemoryTransformers 工厂
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import { memoryEmbedding as MemoryEmbedding, memoryEntry as MemoryEntry } from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { createExecutionRunner } from "@/lib/v11/migration/migration-runner";
import { InMemoryMigrationStateStore } from "@/lib/v11/migration/migration-state";
import { createMemoryTransformers } from "@/lib/v11/migration/transformers/memory";
import { getV11TableRegistry } from "@/lib/v11/migration/v11-table-registry";
import {
  memoryCandidate as V11MemoryCandidate,
  memoryEntry as V11MemoryEntry,
  memoryIndex as V11MemoryIndex,
} from "@/lib/v11/schema/memory";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

// ═══════════════════════════════════════════════════════════
// 1. MemoryEntry 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 MemoryEntry 转换器", () => {
  it("正常 MemoryEntry 迁移为 V11MemoryEntry + V11MemoryCandidate", async () => {
    await db.insert(MemoryEntry).values({
      id: "mem-t-001",
      scope: "user",
      scopeRef: "user-t-001",
      kind: "preference",
      text: "用户偏好示例",
      textHash: "a".repeat(64),
      provenance: [{ kind: "user", refId: "user-t-001" }],
      status: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMemoryTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("memory");

    const entryTable = result.tables.find((t) => t.sourceTable === "MemoryEntry");
    expect(entryTable?.sourceCount).toBe(1);
    expect(entryTable?.targetCount).toBe(2); // V11MemoryEntry + V11MemoryCandidate
    expect(entryTable?.anomalyCount).toBe(0);
    expect(entryTable?.skipCount).toBe(0);

    // 验证 V11MemoryEntry 写入
    const [entry] = await db
      .select()
      .from(V11MemoryEntry)
      .where(eq(V11MemoryEntry.id, "mem-t-001"))
      .limit(1);
    expect(entry).toBeDefined();
    expect(entry?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(entry?.scopeType).toBe("user_preference");
    expect(entry?.scopeRef).toBe("user-t-001");
    expect(entry?.memoryType).toBe("preference");
    expect(entry?.contentRedacted).toBe("用户偏好示例");
    expect(entry?.contentHash).toBe(`sha256:${"a".repeat(64)}`);
    expect(entry?.sensitivityClass).toBe("internal");
    expect(entry?.memoryState).toBe("active");

    // 验证 V11MemoryCandidate 写入
    const [candidate] = await db
      .select()
      .from(V11MemoryCandidate)
      .where(eq(V11MemoryCandidate.resolvedMemoryEntryId, "mem-t-001"))
      .limit(1);
    expect(candidate).toBeDefined();
    expect(candidate?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(candidate?.proposedScopeType).toBe("user_preference");
    expect(candidate?.proposedScopeRef).toBe("user-t-001");
    expect(candidate?.memoryType).toBe("preference");
    expect(candidate?.candidateState).toBe("accepted");
    expect(candidate?.resolvedMemoryEntryId).toBe("mem-t-001");
    // sourceItemId = 源 id（保证 candidateKey 唯一）
    expect(candidate?.sourceItemId).toBe("mem-t-001");
    expect(candidate?.sourceJobId).toBeNull();
    expect(candidate?.sourceArtifactId).toBeNull();
  });

  it("scopeRef 为空时入异常队列", async () => {
    await db.insert(MemoryEntry).values({
      id: "mem-t-002",
      scope: "user",
      // scopeRef 不传，默认为 null
      kind: "preference",
      text: "无 scopeRef 的记忆",
      textHash: "b".repeat(64),
      provenance: [{ kind: "user", refId: "user-t-002" }],
      status: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMemoryTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("memory");

    const entryTable = result.tables.find((t) => t.sourceTable === "MemoryEntry");
    expect(entryTable?.anomalyCount).toBe(1);
    expect(entryTable?.targetCount).toBe(0);

    const anomalies = store.getAnomalies("MemoryEntry");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]?.reason).toContain("scopeRef 为空");
  });

  it("status=active 映射为 memoryState=active", async () => {
    await db.insert(MemoryEntry).values({
      id: "mem-t-active",
      scope: "thread",
      scopeRef: "thread-t-001",
      kind: "convention",
      text: "活跃记忆",
      textHash: "c".repeat(64),
      provenance: [{ kind: "message", refId: "msg-t-001" }],
      status: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMemoryTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("memory");

    const [entry] = await db
      .select()
      .from(V11MemoryEntry)
      .where(eq(V11MemoryEntry.id, "mem-t-active"))
      .limit(1);
    expect(entry?.memoryState).toBe("active");
  });

  it("status=revoked 映射为 memoryState=archived", async () => {
    await db.insert(MemoryEntry).values({
      id: "mem-t-revoked",
      scope: "thread",
      scopeRef: "thread-t-002",
      kind: "decision",
      text: "已撤销记忆",
      textHash: "d".repeat(64),
      provenance: [{ kind: "tool_run", refId: "tr-t-001" }],
      status: "revoked",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMemoryTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("memory");

    const [entry] = await db
      .select()
      .from(V11MemoryEntry)
      .where(eq(V11MemoryEntry.id, "mem-t-revoked"))
      .limit(1);
    expect(entry?.memoryState).toBe("archived");
  });

  it("scope 映射：user→user_preference / project→workspace / thread→thread / skill→agent", async () => {
    await db.insert(MemoryEntry).values({
      id: "mem-scope-user",
      scope: "user",
      scopeRef: "u1",
      kind: "preference",
      text: "user scope",
      textHash: "1".repeat(64),
      provenance: [{ kind: "user", refId: "u1" }],
    });
    await db.insert(MemoryEntry).values({
      id: "mem-scope-project",
      scope: "project",
      scopeRef: "p1",
      kind: "convention",
      text: "project scope",
      textHash: "2".repeat(64),
      provenance: [{ kind: "user", refId: "u1" }],
    });
    await db.insert(MemoryEntry).values({
      id: "mem-scope-thread",
      scope: "thread",
      scopeRef: "t1",
      kind: "decision",
      text: "thread scope",
      textHash: "3".repeat(64),
      provenance: [{ kind: "message", refId: "m1" }],
    });
    await db.insert(MemoryEntry).values({
      id: "mem-scope-skill",
      scope: "skill",
      scopeRef: "s1",
      kind: "command",
      text: "skill scope",
      textHash: "4".repeat(64),
      provenance: [{ kind: "tool_run", refId: "tr1" }],
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMemoryTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("memory");

    const [u] = await db
      .select()
      .from(V11MemoryEntry)
      .where(eq(V11MemoryEntry.id, "mem-scope-user"))
      .limit(1);
    expect(u?.scopeType).toBe("user_preference");

    const [p] = await db
      .select()
      .from(V11MemoryEntry)
      .where(eq(V11MemoryEntry.id, "mem-scope-project"))
      .limit(1);
    expect(p?.scopeType).toBe("workspace");

    const [t] = await db
      .select()
      .from(V11MemoryEntry)
      .where(eq(V11MemoryEntry.id, "mem-scope-thread"))
      .limit(1);
    expect(t?.scopeType).toBe("thread");

    const [s] = await db
      .select()
      .from(V11MemoryEntry)
      .where(eq(V11MemoryEntry.id, "mem-scope-skill"))
      .limit(1);
    expect(s?.scopeType).toBe("agent");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. MemoryEmbedding 转换器
// ═══════════════════════════════════════════════════════════

describe("S13-C03 MemoryEmbedding 转换器", () => {
  it("正常 MemoryEmbedding 迁移为 V11MemoryIndex", async () => {
    // 先插入并迁移 MemoryEntry
    await db.insert(MemoryEntry).values({
      id: "mem-emb-001",
      scope: "thread",
      scopeRef: "thread-emb-001",
      kind: "preference",
      text: "带嵌入的记忆",
      textHash: "e".repeat(64),
      provenance: [{ kind: "message", refId: "msg-emb-001" }],
      status: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMemoryTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    // 先迁移 MemoryEntry
    await runner.runDomain("memory");

    // 插入 MemoryEmbedding
    await db.insert(MemoryEmbedding).values({
      id: "emb-t-001",
      memoryId: "mem-emb-001",
      provider: "internal_vector",
      model: "text-embedding-3-small",
      vector: [0.1, 0.2, 0.3],
      dim: 3,
      status: "active",
    });

    // 单独运行 MemoryEmbedding 转换器
    const store2 = new InMemoryMigrationStateStore();
    const runner2 = createExecutionRunner(
      store2,
      createMemoryTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner2.runTable({
      legacyTable: "MemoryEmbedding",
      physicalTable: "MemoryEmbedding",
      v11Targets: ["V11MemoryIndex"],
      domain: "memory",
      order: 2,
      unmigratableFields: ["vector"],
      defaultHandling: "",
      anomalyConditions: "",
      coreEntity: true,
    });

    expect(result.sourceCount).toBe(1);
    expect(result.targetCount).toBe(1);
    expect(result.anomalyCount).toBe(0);

    // 验证 V11MemoryIndex 写入
    const [idx] = await db
      .select()
      .from(V11MemoryIndex)
      .where(eq(V11MemoryIndex.id, "emb-t-001"))
      .limit(1);
    expect(idx).toBeDefined();
    expect(idx?.memoryEntryId).toBe("mem-emb-001");
    expect(idx?.indexProvider).toBe("internal_vector");
    expect(idx?.embeddingModelRef).toBe("text-embedding-3-small");
    // indexRef 引用旧表行（vector 不迁移）
    expect(idx?.indexRef).toBe("legacy-vector://MemoryEmbedding/emb-t-001");
    // contentHash 与 V11MemoryEntry 一致
    expect(idx?.contentHash).toBe(`sha256:${"e".repeat(64)}`);
  });

  it("memoryId 对应的 V11MemoryEntry 不存在时入异常队列", async () => {
    // FK 约束阻止直接插入孤儿 MemoryEmbedding，直接调用转换器验证防御逻辑
    const transformers = createMemoryTransformers();
    const transformer = transformers.get("MemoryEmbedding");
    expect(transformer).toBeDefined();
    if (!transformer) return;

    const result = await transformer({
      id: "emb-t-002",
      memoryId: "nonexistent-mem",
      provider: "internal_vector",
      model: "text-embedding-3-small",
      vector: [0.1, 0.2],
      dim: 2,
      status: "active",
    });

    expect(result.targets).toEqual([]);
    expect(result.anomalyReason).toContain("V11MemoryEntry 不存在");
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 端到端 memory 域迁移
// ═══════════════════════════════════════════════════════════

describe("S13-C03 memory 域端到端迁移", () => {
  it("完整 memory 域迁移：MemoryEntry → MemoryEmbedding 顺序执行", async () => {
    // 准备数据：2 条 MemoryEntry + 1 条 MemoryEmbedding
    await db.insert(MemoryEntry).values({
      id: "mem-e2e-001",
      scope: "thread",
      scopeRef: "thread-e2e-001",
      kind: "preference",
      text: "端到端记忆 1",
      textHash: "f".repeat(64),
      provenance: [{ kind: "message", refId: "msg-e2e-001" }],
      status: "active",
    });
    await db.insert(MemoryEntry).values({
      id: "mem-e2e-002",
      scope: "user",
      scopeRef: "user-e2e-001",
      kind: "decision",
      text: "端到端记忆 2",
      textHash: "0".repeat(64),
      provenance: [{ kind: "user", refId: "user-e2e-001" }],
      status: "revoked",
    });
    await db.insert(MemoryEmbedding).values({
      id: "emb-e2e-001",
      memoryId: "mem-e2e-001",
      provider: "internal_vector",
      model: "text-embedding-3-small",
      vector: [0.1, 0.2, 0.3],
      dim: 3,
      status: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createMemoryTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    const result = await runner.runDomain("memory");

    // 汇总验证
    expect(result.totalSourceCount).toBe(3); // 2 MemoryEntry + 1 MemoryEmbedding
    expect(result.totalAnomalyCount).toBe(0);

    // MemoryEntry: 2 条 × 2 目标 = 4
    const entryTable = result.tables.find((t) => t.sourceTable === "MemoryEntry");
    expect(entryTable?.targetCount).toBe(4);

    // MemoryEmbedding: 1 条 × 1 目标 = 1
    const embTable = result.tables.find((t) => t.sourceTable === "MemoryEmbedding");
    expect(embTable?.targetCount).toBe(1);

    // 验证 V11 表实际写入
    const entries = await db.select().from(V11MemoryEntry);
    expect(entries.length).toBe(2);

    const candidates = await db.select().from(V11MemoryCandidate);
    expect(candidates.length).toBe(2);

    const indices = await db.select().from(V11MemoryIndex);
    expect(indices.length).toBe(1);
    expect(indices[0]?.memoryEntryId).toBe("mem-e2e-001");
  });

  it("幂等性：二次运行跳过所有已迁移记录", async () => {
    await db.insert(MemoryEntry).values({
      id: "mem-idem-001",
      scope: "thread",
      scopeRef: "thread-idem-001",
      kind: "preference",
      text: "幂等测试记忆",
      textHash: "9".repeat(64),
      provenance: [{ kind: "message", refId: "msg-idem-001" }],
      status: "active",
    });
    await db.insert(MemoryEmbedding).values({
      id: "emb-idem-001",
      memoryId: "mem-idem-001",
      provider: "internal_vector",
      model: "text-embedding-3-small",
      vector: [0.1, 0.2],
      dim: 2,
      status: "active",
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createMemoryTransformers();

    // 第一次运行
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result1 = await runner1.runDomain("memory");
    expect(result1.totalTargetCount).toBeGreaterThan(0);

    // 记录第一次的 V11 表行数
    const entryCount1 = (await db.select().from(V11MemoryEntry)).length;
    const candidateCount1 = (await db.select().from(V11MemoryCandidate)).length;
    const indexCount1 = (await db.select().from(V11MemoryIndex)).length;

    // 第二次运行：应全部跳过，不产生新目标
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    const result2 = await runner2.runDomain("memory");

    expect(result2.totalTargetCount).toBe(0);
    expect(result2.totalSkipCount).toBe(2); // 2 条源记录全部跳过

    // V11 表行数不变
    const entryCount2 = (await db.select().from(V11MemoryEntry)).length;
    const candidateCount2 = (await db.select().from(V11MemoryCandidate)).length;
    const indexCount2 = (await db.select().from(V11MemoryIndex)).length;
    expect(entryCount2).toBe(entryCount1);
    expect(candidateCount2).toBe(candidateCount1);
    expect(indexCount2).toBe(indexCount1);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. createMemoryTransformers 工厂
// ═══════════════════════════════════════════════════════════

describe("S13-C03 createMemoryTransformers 工厂", () => {
  it("返回 2 个转换器", () => {
    const transformers = createMemoryTransformers();
    expect(transformers.size).toBe(2);
    expect(transformers.has("MemoryEntry")).toBe(true);
    expect(transformers.has("MemoryEmbedding")).toBe(true);
  });

  it("每个转换器是函数类型", () => {
    const transformers = createMemoryTransformers();
    for (const [, transformer] of transformers) {
      expect(typeof transformer).toBe("function");
    }
  });

  it("工厂每次调用返回独立 Map 实例", () => {
    const t1 = createMemoryTransformers();
    const t2 = createMemoryTransformers();
    expect(t1).not.toBe(t2);
    expect(t1.size).toBe(t2.size);
  });
});
