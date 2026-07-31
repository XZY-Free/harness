import { db } from "@/lib/db/client";
import {
  contextSnapshot,
  contextSummary,
  thread,
  threadEvent,
  toolRun,
  user,
} from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./test/mysql-harness";

/**
 * P2(08 DB P2-4)：retention TTL 清理测试(真实 MySQL 同构)。
 *
 * 生产是 MySQL(mysql2 + drizzle),测试必须生产同构——不再用 fake-db mock 替代真实 DB。
 * 本测试用 testcontainers 起的真实 MySQL 8 容器(经 vitest globalSetup 注入 DATABASE_URL),
 * beforeEach resetDatabase TRUNCATE 所有表隔离,用 db.insert 灌真实数据,断言真实删除结果。
 *
 * 验证维度:
 * - retentionDays=0 → skipped,不执行任何 delete、不调 cleanupQaArtifacts
 * - 无超期 thread → skipped=false、purgedThreads=0、不调 cleanupQaArtifacts
 * - 有超期终态 thread → 4 张明细表行被真实删(count=0),purgedThreads 计数,cleanupQaArtifacts 每 threadId 一次
 * - 未超期 thread(同终态 + updatedAt 近期 / 活跃态 + updatedAt 超期)→ 明细保留(count>0)
 * - cleanupQaArtifacts 抛错 → best-effort 不阻塞清理
 */
const qaCleanup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// 05-P1-5：cleanupQaArtifacts 操作文件系统,mock 掉;断言终态 thread 清理时按 threadId 调用
vi.mock("@/lib/qa/artifact", () => ({
  cleanupQaArtifacts: qaCleanup,
}));

import { purgeExpiredThreadDetails } from "@/lib/db/retention";

/** 100 天前的 updatedAt(超 90 天保留期)。 */
const EXPIRED_AT = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
/** 当前时间(未超期)。 */
const RECENT_AT = new Date();

/** 灌一个 user,返回 id。所有 thread 都挂这个 user(外键约束)。 */
async function seedUser(id: string): Promise<void> {
  await db.insert(user).values({
    id,
    externalId: id,
    email: `${id}@test`,
    name: id,
    createdAt: RECENT_AT,
  });
}

/** 灌一个 thread(指定 status + updatedAt),返回插入的 id。 */
async function seedThread(
  id: string,
  userId: string,
  status: (typeof thread.$inferInsert)["status"],
  updatedAt: Date,
): Promise<void> {
  await db.insert(thread).values({
    id,
    userId,
    title: id,
    status,
    createdAt: updatedAt,
    updatedAt,
  });
}

/** 灌一行 ThreadEvent。 */
async function seedEvent(threadId: string, sequence: number): Promise<void> {
  await db.insert(threadEvent).values({
    threadId,
    sequence,
    type: "agent.started",
    payload: { seq: sequence },
    createdAt: RECENT_AT,
  });
}

/** 灌一行 ToolRun。 */
async function seedToolRun(threadId: string, name: string): Promise<void> {
  await db.insert(toolRun).values({
    threadId,
    toolName: name,
    status: "succeeded",
    input: { name },
    startedAt: RECENT_AT,
  });
}

/** 灌一行 ContextSnapshot。 */
async function seedSnapshot(threadId: string, tokens: number): Promise<void> {
  await db.insert(contextSnapshot).values({
    threadId,
    trigger: "chat.user_message",
    model: "test-model",
    toolNames: [],
    layers: [],
    protectedRefs: [],
    excludedCandidates: [],
    checksums: {},
    estimatedTokens: tokens,
    createdAt: RECENT_AT,
  });
}

/** 灌一行 ContextSummary。 */
async function seedSummary(threadId: string, idx: number): Promise<void> {
  await db.insert(contextSummary).values({
    threadId,
    type: "turn",
    scope: { idx },
    summaryText: `summary-${idx}`,
    checksum: `ck-${threadId}-${idx}`,
    tokenEstimate: 10,
    originalTokenEstimate: 100,
    protectedRefs: [],
    createdAt: RECENT_AT,
  });
}

/** 统计某表某 threadId 的行数(断言删除/保留)。 */
async function countByThreadId(
  table: typeof threadEvent | typeof toolRun | typeof contextSnapshot | typeof contextSummary,
  threadId: string,
): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(table)
    .where(eq(table.threadId, threadId));
  return Number(rows[0]?.c ?? 0);
}

beforeEach(async () => {
  await resetDatabase(db);
  qaCleanup.mockReset();
  qaCleanup.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("purgeExpiredThreadDetails", () => {
  it("retentionDays=0 → skipped,不执行任何 delete、不调 cleanupQaArtifacts", async () => {
    // 灌一个超期终态 thread,验证 retentionDays=0 短路不删
    await seedUser("u1");
    await seedThread("t-expired", "u1", "completed", EXPIRED_AT);
    await seedEvent("t-expired", 1);

    const r = await purgeExpiredThreadDetails(0);

    expect(r.skipped).toBe(true);
    expect(r.purgedThreads).toBe(0);
    expect(r.threadEvents).toBe(0);
    expect(r.toolRuns).toBe(0);
    expect(r.contextSnapshots).toBe(0);
    expect(r.contextSummaries).toBe(0);
    expect(r.hardDeletedThreads).toBe(0);
    expect(qaCleanup).not.toHaveBeenCalled();
    // 明细行仍在(retentionDays=0 短路,不删)
    expect(await countByThreadId(threadEvent, "t-expired")).toBe(1);
  });

  it("无超期 thread → skipped=false、purgedThreads=0、不调 cleanupQaArtifacts", async () => {
    await seedUser("u1");
    // 活跃态但 updatedAt 超期 —— 不在 TERMINAL_STATUSES,不算超期目标
    await seedThread("t-active", "u1", "executing", EXPIRED_AT);
    // 终态但 updatedAt 近期 —— 未超期
    await seedThread("t-recent", "u1", "completed", RECENT_AT);
    await seedEvent("t-active", 1);
    await seedEvent("t-recent", 1);

    const r = await purgeExpiredThreadDetails(90);

    expect(r.skipped).toBe(false);
    expect(r.purgedThreads).toBe(0);
    expect(qaCleanup).not.toHaveBeenCalled();
    // 两 thread 明细均保留
    expect(await countByThreadId(threadEvent, "t-active")).toBe(1);
    expect(await countByThreadId(threadEvent, "t-recent")).toBe(1);
  });

  it("有超期终态 thread → 真实删四张明细表、purgedThreads 计数、cleanupQaArtifacts 每 threadId 一次", async () => {
    await seedUser("u1");
    // 两个超期终态 thread,各灌 2 行明细
    await seedThread("t-exp1", "u1", "completed", EXPIRED_AT);
    await seedThread("t-exp2", "u1", "failed", EXPIRED_AT);
    for (const tid of ["t-exp1", "t-exp2"]) {
      await seedEvent(tid, 1);
      await seedEvent(tid, 2);
      await seedToolRun(tid, "writeFile");
      await seedToolRun(tid, "readFile");
      await seedSnapshot(tid, 100);
      await seedSnapshot(tid, 200);
      await seedSummary(tid, 0);
      await seedSummary(tid, 1);
    }

    const r = await purgeExpiredThreadDetails(90);

    expect(r.skipped).toBe(false);
    expect(r.purgedThreads).toBe(2);
    expect(r.threadEvents).toBe(4);
    expect(r.toolRuns).toBe(4);
    expect(r.contextSnapshots).toBe(4);
    expect(r.contextSummaries).toBe(4);
    expect(r.hardDeletedThreads).toBe(0); // hardDeleteRetentionDays 默认 0,不物理删主记录

    // 真实 DB 断言:超期 thread 明细已清空
    for (const tid of ["t-exp1", "t-exp2"]) {
      expect(await countByThreadId(threadEvent, tid)).toBe(0);
      expect(await countByThreadId(toolRun, tid)).toBe(0);
      expect(await countByThreadId(contextSnapshot, tid)).toBe(0);
      expect(await countByThreadId(contextSummary, tid)).toBe(0);
    }
    // 主记录仍在(retention 只清明细,不删 thread)
    const remaining = await db.select({ id: thread.id }).from(thread);
    expect(remaining.map((t) => t.id).sort()).toEqual(["t-exp1", "t-exp2"]);

    // cleanupQaArtifacts 对每个超期 threadId 调一次
    expect(qaCleanup).toHaveBeenCalledTimes(2);
    expect(qaCleanup).toHaveBeenCalledWith("t-exp1");
    expect(qaCleanup).toHaveBeenCalledWith("t-exp2");
  });

  it("未超期 thread 明细保留(终态近期 + 活跃态超期均不清)", async () => {
    await seedUser("u1");
    // t-keep1:终态但 updatedAt 近期(未超期)→ 保留
    await seedThread("t-keep1", "u1", "completed", RECENT_AT);
    // t-keep2:活跃态 + updatedAt 超期 → 绝不清(防误清运行中数据)
    await seedThread("t-keep2", "u1", "executing", EXPIRED_AT);
    // t-exp:超期终态 → 删
    await seedThread("t-exp", "u1", "cancelled", EXPIRED_AT);
    for (const tid of ["t-keep1", "t-keep2", "t-exp"]) {
      await seedEvent(tid, 1);
      await seedToolRun(tid, "writeFile");
      await seedSnapshot(tid, 50);
      await seedSummary(tid, 0);
    }

    const r = await purgeExpiredThreadDetails(90);

    expect(r.purgedThreads).toBe(1);
    // 未超期 thread 明细全保留
    for (const tid of ["t-keep1", "t-keep2"]) {
      expect(await countByThreadId(threadEvent, tid)).toBe(1);
      expect(await countByThreadId(toolRun, tid)).toBe(1);
      expect(await countByThreadId(contextSnapshot, tid)).toBe(1);
      expect(await countByThreadId(contextSummary, tid)).toBe(1);
    }
    // 超期 thread 明细已清
    expect(await countByThreadId(threadEvent, "t-exp")).toBe(0);
    // 只对超期 threadId 调 cleanupQaArtifacts
    expect(qaCleanup).toHaveBeenCalledTimes(1);
    expect(qaCleanup).toHaveBeenCalledWith("t-exp");
  });

  it("retentionDays=30 → 正常清理(配置透传,30 天 cutoff 命中超期 thread)", async () => {
    await seedUser("u1");
    // 100 天前更新 → 超 30 天保留期
    await seedThread("t-exp30", "u1", "idle", EXPIRED_AT);
    await seedEvent("t-exp30", 1);

    const r = await purgeExpiredThreadDetails(30);

    expect(r.skipped).toBe(false);
    expect(r.purgedThreads).toBe(1);
    expect(r.threadEvents).toBe(1);
    expect(await countByThreadId(threadEvent, "t-exp30")).toBe(0);
  });

  it("cleanupQaArtifacts 抛错 → best-effort 不阻塞清理(明细仍删、purgedThreads 仍计)", async () => {
    await seedUser("u1");
    await seedThread("t-exp", "u1", "completed", EXPIRED_AT);
    await seedEvent("t-exp", 1);
    await seedToolRun("t-exp", "writeFile");

    qaCleanup.mockRejectedValueOnce(new Error("fs error"));

    const r = await purgeExpiredThreadDetails(90);

    expect(r.skipped).toBe(false);
    expect(r.purgedThreads).toBe(1);
    expect(r.threadEvents).toBe(1);
    expect(r.toolRuns).toBe(1);
    // 明细已真实删除(cleanupQaArtifacts 抛错被 catch 吞掉,不影响 DB 删除)
    expect(await countByThreadId(threadEvent, "t-exp")).toBe(0);
    expect(await countByThreadId(toolRun, "t-exp")).toBe(0);
    expect(qaCleanup).toHaveBeenCalledTimes(1);
  });
});
