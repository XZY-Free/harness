import { clearAnalyticsCache } from "@/lib/analytics/cache";
import { db } from "@/lib/db/client";
import {
  type ThreadStatus,
  skill,
  thread,
  threadEvent,
  threadRun,
  threadRunSkill,
  toolRun,
  user,
} from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Phase 4-2 Analytics 查询层测试（真实 MySQL 同构）。
 *
 * 生产是 MySQL(mysql2 + drizzle)，测试必须生产同构——不再用 fake-db mock 替代真实 DB。
 * 灌真实 thread / threadEvent / toolRun / skill 数据，断言聚合变换口径与 userId scope 隔离。
 */

import {
  avgCompletionMs,
  perSkillPerformance,
  previewSuccessRate,
  skillMatchStats,
  threadSuccessRate,
  toolFailureBreakdown,
} from "@/lib/analytics/queries";

const BASE = new Date("2026-06-01T12:00:00.000Z");
let eventSeq = 0;

async function seedUser(id: string): Promise<void> {
  await db.insert(user).values({
    id,
    externalId: id,
    email: `${id}@test`,
    name: id,
    createdAt: BASE,
  });
}

async function seedThread(
  id: string,
  userId: string,
  status: ThreadStatus,
  opts?: {
    createdAt?: Date;
    activeSkillId?: string | null;
    activeSkillVersionId?: string | null;
  },
): Promise<void> {
  const createdAt = opts?.createdAt ?? BASE;
  await db.insert(thread).values({
    id,
    userId,
    title: id,
    status,
    createdAt,
    updatedAt: createdAt,
    activeSkillId: opts?.activeSkillId ?? null,
    activeSkillVersionId: opts?.activeSkillVersionId ?? null,
  });
}

async function seedEvent(
  threadId: string,
  type: string,
  payload: Record<string, unknown>,
  createdAt?: Date,
): Promise<void> {
  eventSeq += 1;
  await db.insert(threadEvent).values({
    id: `ev-${threadId}-${eventSeq}`,
    threadId,
    sequence: eventSeq,
    type,
    payload,
    createdAt: createdAt ?? BASE,
  });
}

async function seedToolRun(
  id: string,
  threadId: string,
  toolName: string,
  status: (typeof toolRun.$inferInsert)["status"],
  startedAt?: Date,
): Promise<void> {
  await db.insert(toolRun).values({
    id,
    threadId,
    toolName,
    status,
    input: {},
    startedAt: startedAt ?? BASE,
  });
}

async function seedSkill(id: string, name: string): Promise<void> {
  await db.insert(skill).values({
    id,
    name,
    visibility: "public",
    status: "active",
    createdAt: BASE,
  });
}

/**
 * V8 阶段 7：为 thread 灌入一个 ThreadRun + ThreadRunSkill（primary role）。
 * 取代旧 seedThread 的 activeSkillId/activeSkillVersionId 选项——统计口径改用 ThreadRunSkill。
 */
async function seedRunWithSkill(
  threadId: string,
  skillId: string | null,
  skillVersionId: string | null,
  opts?: { createdAt?: Date },
): Promise<void> {
  const createdAt = opts?.createdAt ?? BASE;
  const runId = `run-${threadId}-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(threadRun).values({
    id: runId,
    threadId,
    status: "completed",
    triggerType: "chat.user_message",
    model: "test-model",
    createdAt,
  });
  if (skillId && skillVersionId) {
    await db.insert(threadRunSkill).values({
      runId,
      threadId,
      skillId,
      skillVersionId,
      role: "primary",
      source: "resolver",
    });
  }
}

beforeEach(async () => {
  await resetDatabase(db);
  clearAnalyticsCache();
  eventSeq = 0;
});

describe("threadSuccessRate (Stage A, 真实 MySQL)", () => {
  it("口径：ready/(ready+failed)，executing 不计分母，idle 单列", async () => {
    await seedUser("u1");
    const statuses: ThreadStatus[] = [
      ...Array.from({ length: 6 }, () => "ready_for_review" as const),
      ...Array.from({ length: 2 }, () => "failed" as const),
      ...Array.from({ length: 5 }, () => "executing" as const),
      ...Array.from({ length: 2 }, () => "idle" as const),
    ];
    for (let i = 0; i < statuses.length; i++) {
      await seedThread(`t-${i}`, "u1", statuses[i]!);
    }

    const m = await threadSuccessRate();
    expect(m.successRate).toBe(6 / 8);
    expect(m.readyForReview).toBe(6);
    expect(m.failed).toBe(2);
    expect(m.executing).toBe(5);
    expect(m.idle).toBe(2);
    expect(m.idleRate).toBe(2 / 10);
    expect(m.total).toBe(15);
  });

  it("无已结束 thread（分母 0）→ successRate null", async () => {
    await seedUser("u1");
    await seedThread("t1", "u1", "executing");

    const m = await threadSuccessRate();
    expect(m.successRate).toBeNull();
    expect(m.idleRate).toBeNull();
    expect(m.total).toBe(1);
  });

  it("完全空集 → 全 null 计数为 0", async () => {
    const m = await threadSuccessRate();
    expect(m.successRate).toBeNull();
    expect(m.total).toBe(0);
    expect(m.readyForReview).toBe(0);
  });

  it("传时间窗口 → 只聚合窗口内 thread；不传 → 全量", async () => {
    await seedUser("u1");
    await seedThread("t-in", "u1", "ready_for_review", {
      createdAt: new Date("2026-02-15T00:00:00Z"),
    });
    await seedThread("t-out", "u1", "ready_for_review", {
      createdAt: new Date("2026-04-15T00:00:00Z"),
    });

    const scoped = await threadSuccessRate({
      since: new Date("2026-02-01"),
      until: new Date("2026-02-28"),
    });
    expect(scoped.readyForReview).toBe(1);
    expect(scoped.total).toBe(1);

    const all = await threadSuccessRate();
    expect(all.readyForReview).toBe(2);
    expect(all.total).toBe(2);
  });
});

describe("previewSuccessRate (Stage A, 真实 MySQL)", () => {
  it("口径：succeeded/(succeeded+failed)，running 不计分母", async () => {
    await seedUser("u1");
    await seedThread("t1", "u1", "idle");
    await seedToolRun("r1", "t1", "reportReady", "succeeded");
    await seedToolRun("r2", "t1", "reportReady", "succeeded");
    await seedToolRun("r3", "t1", "reportReady", "succeeded");
    await seedToolRun("r4", "t1", "reportReady", "succeeded");
    await seedToolRun("r5", "t1", "reportReady", "failed");
    await seedToolRun("r6", "t1", "reportReady", "running");
    await seedToolRun("r7", "t1", "reportReady", "running");

    const m = await previewSuccessRate();
    expect(m.successRate).toBe(4 / 5);
    expect(m.succeeded).toBe(4);
    expect(m.failed).toBe(1);
    expect(m.running).toBe(2);
    expect(m.total).toBe(7);
  });

  it("无 reportReady 记录 → successRate null", async () => {
    const m = await previewSuccessRate();
    expect(m.successRate).toBeNull();
    expect(m.total).toBe(0);
  });
});

describe("avgCompletionMs (Stage B, 真实 MySQL)", () => {
  it("口径：终态 thread 的 (end-start) 均值", async () => {
    await seedUser("u1");
    await seedThread("t1", "u1", "ready_for_review", { createdAt: new Date(0) });
    await seedEvent("t1", "agent.started", {}, new Date(1_000));
    await seedEvent("t1", "agent.status_changed", { to: "ready_for_review" }, new Date(6_000));

    const m = await avgCompletionMs();
    expect(m.avgMs).toBe(5_000);
    expect(m.count).toBe(1);
  });

  it("缺 agent.started → 退回 thread.createdAt 作起点", async () => {
    await seedUser("u1");
    await seedThread("t1", "u1", "ready_for_review", { createdAt: new Date(2_000) });
    await seedEvent("t1", "agent.status_changed", { to: "ready_for_review" }, new Date(7_000));

    const m = await avgCompletionMs();
    expect(m.avgMs).toBe(5_000);
    expect(m.count).toBe(1);
  });

  it("缺终态（executing）→ fail-soft 跳过，不污染均值", async () => {
    await seedUser("u1");
    await seedThread("t1", "u1", "executing", { createdAt: new Date(0) });
    await seedEvent("t1", "agent.started", {}, new Date(1_000));

    const m = await avgCompletionMs();
    expect(m.avgMs).toBeNull();
    expect(m.count).toBe(0);
  });

  it("多 thread 求均值，异常时序（end<start）跳过", async () => {
    await seedUser("u1");
    const t0 = new Date("2026-06-01T12:00:00.000Z");
    await seedThread("t1", "u1", "ready_for_review", { createdAt: t0 });
    await seedThread("t2", "u1", "failed", { createdAt: t0 });
    await seedEvent("t1", "agent.started", {}, new Date("2026-06-01T12:00:01.000Z"));
    await seedEvent("t2", "agent.started", {}, new Date("2026-06-01T12:00:01.000Z"));
    await seedEvent(
      "t1",
      "agent.status_changed",
      { to: "ready_for_review" },
      new Date("2026-06-01T12:00:05.000Z"),
    );
    // 终态早于 agent.started（MySQL datetime 秒级,须差 ≥1s 才可判定）
    await seedEvent(
      "t2",
      "agent.status_changed",
      { to: "failed" },
      new Date("2026-06-01T12:00:00.000Z"),
    );

    const m = await avgCompletionMs();
    expect(m.count).toBe(1);
    expect(m.avgMs).toBe(4_000);
  });
});

describe("perSkillPerformance (Stage B, 真实 MySQL)", () => {
  it("按 (skillId, skillVersionId) 复合分组，各组成功率 + 时长（V8 改用 ThreadRunSkill）", async () => {
    await seedUser("u1");
    await seedSkill("skill-a", "skill-a-name");
    await seedSkill("skill-b", "skill-b-name");
    await seedThread("t1", "u1", "ready_for_review");
    await seedThread("t2", "u1", "failed");
    await seedThread("t3", "u1", "executing");
    // V8：Skill 统计改用 ThreadRunSkill（primary role），不再用 thread.activeSkillId
    await seedRunWithSkill("t1", "skill-a", "v1");
    await seedRunWithSkill("t2", "skill-a", "v1");
    await seedRunWithSkill("t3", "skill-b", "v9");
    await seedEvent("t1", "agent.started", {}, new Date(0));
    await seedEvent("t2", "agent.started", {}, new Date(0));
    await seedEvent("t1", "agent.status_changed", { to: "ready_for_review" }, new Date(3_000));
    await seedEvent("t2", "agent.status_changed", { to: "failed" }, new Date(5_000));

    const out = await perSkillPerformance();
    expect(out).toHaveLength(2);

    const a = out.find((r) => r.skillId === "skill-a");
    expect(a?.total).toBe(2);
    expect(a?.successRate).toBe(1 / 2);
    expect(a?.avgCompletionMs).toBe((3_000 + 5_000) / 2);
    expect(a?.completedCount).toBe(2);

    const b = out.find((r) => r.skillId === "skill-b");
    expect(b?.executing).toBe(1);
    expect(b?.successRate).toBeNull();
    expect(b?.avgCompletionMs).toBeNull();
  });

  it("无 skill 的 run → skillId 为 null（基础 agent，不归到默认 Skill）", async () => {
    await seedUser("u1");
    await seedThread("t1", "u1", "ready_for_review");
    // V8：有 run 但无 ThreadRunSkill 记录 → 基础 agent
    await seedRunWithSkill("t1", null, null);
    await seedEvent("t1", "agent.started", {}, new Date(0));
    await seedEvent("t1", "agent.status_changed", { to: "ready_for_review" }, new Date(2_000));

    const out = await perSkillPerformance();
    expect(out).toHaveLength(1);
    expect(out[0]?.skillId).toBeNull();
    expect(out[0]?.successRate).toBe(1);
  });
});

describe("toolFailureBreakdown (Stage C, 真实 MySQL)", () => {
  it("三类 failureKind 计数 + policy 拦截率（闭合 P4-1）", async () => {
    await seedUser("u1");
    await seedThread("t1", "u1", "idle");
    await seedToolRun("tr1", "t1", "writeFile", "failed");
    await seedToolRun("tr2", "t1", "writeFile", "failed");
    await seedToolRun("tr3", "t1", "writeFile", "failed");
    await seedToolRun("tr4", "t1", "runCommand", "failed");
    await seedEvent("t1", "tool.failed", { failureKind: "policy" });
    await seedEvent("t1", "tool.failed", { failureKind: "policy" });
    await seedEvent("t1", "tool.failed", { failureKind: "business" });
    await seedEvent("t1", "tool.failed", { failureKind: "crash" });

    const m = await toolFailureBreakdown();
    expect(m.byTool).toEqual(
      expect.arrayContaining([
        { toolName: "writeFile", status: "failed", count: 3 },
        { toolName: "runCommand", status: "failed", count: 1 },
      ]),
    );
    expect(m.byKind).toHaveLength(3);
    expect(m.totalFailures).toBe(4);
    expect(m.policyIntercepts).toBe(2);
    expect(m.policyInterceptRate).toBe(0.5);
  });

  it("无 tool.failed → 拦截率 null", async () => {
    const m = await toolFailureBreakdown();
    expect(m.totalFailures).toBe(0);
    expect(m.policyInterceptRate).toBeNull();
    expect(m.policyIntercepts).toBe(0);
  });

  it("全部 policy 拦截 → 拦截率 1", async () => {
    await seedUser("u1");
    await seedThread("t1", "u1", "idle");
    await seedToolRun("tr1", "t1", "writeFile", "failed");
    for (let i = 0; i < 5; i++) {
      await seedEvent("t1", "tool.failed", { failureKind: "policy" });
    }

    const m = await toolFailureBreakdown();
    expect(m.policyInterceptRate).toBe(1);
    expect(m.totalFailures).toBe(5);
  });

  it("缺失 failureKind 的 tool.failed 归 unknown", async () => {
    await seedUser("u1");
    await seedThread("t1", "u1", "idle");
    await seedEvent("t1", "tool.failed", {});

    const m = await toolFailureBreakdown();
    expect(m.byKind[0]?.failureKind).toBe("unknown");
    expect(m.totalFailures).toBe(1);
  });
});

describe("userId scope (Phase 4-3, 真实 MySQL)", () => {
  it("threadSuccessRate 带 userId → 只聚合该 user 的 thread", async () => {
    await seedUser("u1");
    await seedUser("u2");
    await seedThread("t1", "u1", "ready_for_review");
    await seedThread("t2", "u2", "ready_for_review");

    const m = await threadSuccessRate({ userId: "u1" });
    expect(m.readyForReview).toBe(1);
    expect(m.total).toBe(1);
  });

  it("previewSuccessRate 带 userId 且无 owned thread → 空指标", async () => {
    const m = await previewSuccessRate({ userId: "u1" });
    expect(m).toMatchObject({ successRate: null, total: 0, succeeded: 0 });
  });

  it("toolFailureBreakdown 带 userId 且无 owned thread → 空指标", async () => {
    const m = await toolFailureBreakdown({ userId: "u1" });
    expect(m).toMatchObject({
      totalFailures: 0,
      policyInterceptRate: null,
      byTool: [],
      byKind: [],
    });
  });

  it("avgCompletionMs 带 userId 且无 owned thread → count 0", async () => {
    const m = await avgCompletionMs({ userId: "u1" });
    expect(m).toMatchObject({ avgMs: null, count: 0 });
  });

  it("perSkillPerformance 带 userId 且无 owned thread → []", async () => {
    const out = await perSkillPerformance({ userId: "u1" });
    expect(out).toEqual([]);
  });

  it("previewSuccessRate 带 userId 且有 owned thread → 走 inArray 过滤", async () => {
    await seedUser("u1");
    await seedThread("t1", "u1", "idle");
    await seedToolRun("r1", "t1", "reportReady", "succeeded");
    await seedToolRun("r2", "t1", "reportReady", "succeeded");

    const m = await previewSuccessRate({ userId: "u1" });
    expect(m.succeeded).toBe(2);
    expect(m.total).toBe(2);
  });
});

describe("skillMatchStats (11-P2-2, 真实 MySQL)", () => {
  it("按 skillId 聚合命中次数 + 最近命中时间", async () => {
    await seedUser("u1");
    await seedThread("t1", "u1", "idle");
    await seedSkill("sk-a", "zfl-requirement");
    const lastDate = new Date("2026-06-20T00:00:00Z");
    await seedEvent(
      "t1",
      "skills.matched",
      { skillId: "sk-a", skillName: "zfl-requirement" },
      new Date("2026-06-01"),
    );
    await seedEvent(
      "t1",
      "skills.matched",
      { skillId: "sk-a", skillName: "zfl-requirement" },
      lastDate,
    );
    await seedEvent(
      "t1",
      "skills.matched",
      { skillId: "sk-b", skillName: "build-from-idea" },
      new Date("2026-06-10"),
    );
    await seedEvent(
      "t1",
      "skills.matched",
      { skillId: "sk-b", skillName: "build-from-idea" },
      new Date("2026-06-10"),
    );

    const out = await skillMatchStats();
    expect(out).toHaveLength(2);

    const a = out.find((r) => r.skillId === "sk-a");
    expect(a?.skillName).toBe("zfl-requirement");
    expect(a?.matchCount).toBe(2);
    expect(a?.lastMatchedAt).toEqual(lastDate);

    const b = out.find((r) => r.skillId === "sk-b");
    expect(b?.skillName).toBe("build-from-idea");
    expect(b?.matchCount).toBe(2);
  });

  it("无 skills.matched 事件 → 空数组", async () => {
    const out = await skillMatchStats();
    expect(out).toEqual([]);
  });

  it("带 userId 且无 owned thread → 空数组", async () => {
    const out = await skillMatchStats({ userId: "u1" });
    expect(out).toEqual([]);
  });

  it("带 userId 且有 owned thread → 走 inArray 过滤后聚合", async () => {
    await seedUser("u1");
    await seedThread("t1", "u1", "idle");
    await seedSkill("sk-a", "zfl-requirement");
    const lastDate = new Date("2026-06-15T00:00:00Z");
    for (let i = 0; i < 3; i++) {
      await seedEvent("t1", "skills.matched", { skillId: "sk-a", skillName: "zfl" }, lastDate);
    }

    const out = await skillMatchStats({ userId: "u1" });
    expect(out).toHaveLength(1);
    expect(out[0]?.skillId).toBe("sk-a");
    expect(out[0]?.matchCount).toBe(3);
    expect(out[0]?.lastMatchedAt).toEqual(lastDate);
    expect(out[0]?.skillName).toBe("zfl-requirement");
  });

  it("skill 已删档且 payload 无 skillName → skillName 退回 skillId", async () => {
    await seedUser("u1");
    await seedThread("t1", "u1", "idle");
    await seedEvent("t1", "skills.matched", { skillId: "sk-gone" });

    const out = await skillMatchStats();
    expect(out).toHaveLength(1);
    expect(out[0]?.skillName).toBe("sk-gone");
    expect(out[0]?.matchCount).toBe(1);
    expect(out[0]?.lastMatchedAt).toEqual(BASE);
  });
});
