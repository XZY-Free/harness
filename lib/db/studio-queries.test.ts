import { db } from "@/lib/db/client";
import { skill, skillVersion, thread, threadEvent, toolRun, user } from "@/lib/db/schema";
import {
  listArtifactsForThread,
  listEventsForThread,
  listRecentArtifactsForUser,
  listSkillVersions,
  listSkills,
  listThreadsForUser,
  listToolRunsForThread,
} from "@/lib/db/studio-queries";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./test/mysql-harness";

/**
 * Phase 4-4 studio-queries 只读查询单测（S1 08 同构：真实 MySQL）。
 *
 * 生产是 MySQL（mysql2 + drizzle），测试用 testcontainers 起真实 MySQL 8 容器，
 * beforeEach resetDatabase 清空所有表，用 db.insert 真实插数据满足外键后调真实查询函数，
 * 断言真实结果（含 where/orderBy/limit/join 语义，不再用 fake-db 透传）。
 *
 * 外键链：User ← Thread ← (ThreadEvent / ToolRun)；Skill ← SkillVersion；
 * Skill.ownerUserId 逻辑外键（无 DB 级 FK）；Thread.activeSkillId 逻辑外键。
 */

// ─── 测试数据工厂 ─────────────────────────────────────────────

async function insertUser(id: string, name: string | null = null, email?: string) {
  await db.insert(user).values({ id, externalId: id, email: email ?? `${id}@x`, name });
}

async function insertSkill(
  id: string,
  name: string,
  opts: {
    status?: "active" | "archived";
    ownerUserId?: string | null;
    currentVersionId?: string | null;
    createdAt?: Date;
  } = {},
) {
  await db.insert(skill).values({
    id,
    name,
    status: opts.status ?? "active",
    ownerUserId: opts.ownerUserId ?? null,
    currentVersionId: opts.currentVersionId ?? null,
    createdAt: opts.createdAt ?? new Date(),
  });
}

async function insertSkillVersionRow(
  id: string,
  skillId: string,
  version: number,
  opts: { promptTemplate?: string; createdAt?: Date } = {},
) {
  await db.insert(skillVersion).values({
    id,
    skillId,
    version,
    promptTemplate: opts.promptTemplate ?? null,
    createdAt: opts.createdAt ?? new Date(),
  });
}

async function insertThread(
  id: string,
  userId: string,
  opts: {
    title?: string;
    status?: string;
    activeSkillId?: string | null;
    updatedAt?: Date;
    createdAt?: Date;
  } = {},
) {
  const now = new Date();
  await db.insert(thread).values({
    id,
    userId,
    title: opts.title ?? `thread-${id}`,
    status: (opts.status as never) ?? "idle",
    activeSkillId: opts.activeSkillId ?? null,
    createdAt: opts.createdAt ?? now,
    updatedAt: opts.updatedAt ?? now,
  });
}

async function insertToolRunRow(
  id: string,
  threadId: string,
  opts: { toolName?: string; status?: string; startedAt?: Date } = {},
) {
  await db.insert(toolRun).values({
    id,
    threadId,
    toolName: opts.toolName ?? "writeFile",
    status: (opts.status as never) ?? "succeeded",
    input: {},
    startedAt: opts.startedAt ?? new Date(),
  });
}

async function insertEvent(
  id: string,
  threadId: string,
  sequence: number,
  type: string,
  opts: { payload?: unknown; createdAt?: Date } = {},
) {
  await db.insert(threadEvent).values({
    id,
    threadId,
    sequence,
    type,
    payload: (opts.payload ?? {}) as never,
    createdAt: opts.createdAt ?? new Date(),
  });
}

// ─── listSkills ──────────────────────────────────────────────

describe("listSkills (真实 MySQL)", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("全量返回（admin 视角，含 currentVersionId），按 createdAt desc", async () => {
    const t0 = new Date("2026-01-01");
    const t1 = new Date("2026-02-01");
    await insertSkill("s-old", "old", { createdAt: t0 });
    await insertSkill("s-new", "new", { createdAt: t1, currentVersionId: "v1" });

    const rows = await listSkills();
    expect(rows).toHaveLength(2);
    // createdAt desc：new 在前
    expect(rows[0]?.id).toBe("s-new");
    expect(rows[0]?.currentVersionId).toBe("v1");
    expect(rows[1]?.id).toBe("s-old");
    expect(rows[1]?.currentVersionId).toBeNull();
  });

  it("空集 → []", async () => {
    await expect(listSkills()).resolves.toEqual([]);
  });

  it("activeOnly=true 仅返回 status=active，过滤 archived 软删", async () => {
    await insertSkill("s1", "active-skill", { status: "active" });
    await insertSkill("s2", "archived-skill", { status: "archived" });

    const rows = await listSkills(undefined, { activeOnly: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("s1");
    expect(rows[0]?.status).toBe("active");
  });

  it("activeOnly=false（默认）含 archived", async () => {
    await insertSkill("s1", "a", { status: "active" });
    await insertSkill("s2", "b", { status: "archived" });

    const rows = await listSkills();
    expect(rows).toHaveLength(2);
  });

  it("owner filter（includePublic=false）仅返回 ownerUserId 匹配的 skill", async () => {
    await insertSkill("s-mine", "mine", { ownerUserId: "u1" });
    await insertSkill("s-other", "other", { ownerUserId: "u2" });
    await insertSkill("s-public", "public", { ownerUserId: null });

    const rows = await listSkills({ ownerUserId: "u1", includePublic: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("s-mine");
  });

  it("owner filter + includePublic=true 含公共 skill（ownerUserId null）", async () => {
    await insertSkill("s-mine", "mine", { ownerUserId: "u1" });
    await insertSkill("s-other", "other", { ownerUserId: "u2" });
    await insertSkill("s-public", "public", { ownerUserId: null });

    const rows = await listSkills({ ownerUserId: "u1", includePublic: true });
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["s-mine", "s-public"]);
  });

  it("activeOnly + owner filter 组合（两条件并存）", async () => {
    await insertSkill("s-mine-active", "ma", { ownerUserId: "u1", status: "active" });
    await insertSkill("s-mine-archived", "mr", { ownerUserId: "u1", status: "archived" });
    await insertSkill("s-other-active", "oa", { ownerUserId: "u2", status: "active" });
    await insertSkill("s-public-active", "pa", { ownerUserId: null, status: "active" });

    const rows = await listSkills(
      { ownerUserId: "u1", includePublic: false },
      { activeOnly: true },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("s-mine-active");
  });
});

// ─── listSkillVersions ───────────────────────────────────────

describe("listSkillVersions (真实 MySQL)", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("返回某 skill 的版本列表，按 version asc", async () => {
    await insertSkill("s1", "build-from-idea");
    await insertSkillVersionRow("v2", "s1", 2, { promptTemplate: "p2" });
    await insertSkillVersionRow("v1", "s1", 1, { promptTemplate: "p1" });

    const rows = await listSkillVersions("s1");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.promptTemplate).toBe("p1");
    expect(rows[1]?.version).toBe(2);
    expect(rows[1]?.promptTemplate).toBe("p2");
  });

  it("仅返回该 skill 的版本（不串到其他 skill）", async () => {
    await insertSkill("s1", "a");
    await insertSkill("s2", "b");
    await insertSkillVersionRow("v1", "s1", 1);
    await insertSkillVersionRow("v2", "s2", 1);

    const rows = await listSkillVersions("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skillId).toBe("s1");
  });

  it("无版本 → []", async () => {
    await insertSkill("s1", "a");
    await expect(listSkillVersions("s1")).resolves.toEqual([]);
  });
});

// ─── thread 只读查询 ─────────────────────────────────────────

describe("thread 只读查询 (真实 MySQL)", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("listThreadsForUser 仅返回该 user 的 thread，按 updatedAt desc，含 ownerName join", async () => {
    await insertUser("u1", "Alice", "alice@x");
    await insertUser("u2", "Bob", "bob@x");
    const early = new Date("2026-01-01");
    const late = new Date("2026-02-01");
    await insertThread("t-old", "u1", { title: "old", updatedAt: early });
    await insertThread("t-new", "u1", { title: "new", updatedAt: late });
    await insertThread("t-other", "u2", { title: "other" });

    const rows = await listThreadsForUser("u1");
    expect(rows).toHaveLength(2);
    // updatedAt desc：new 在前
    expect(rows[0]?.id).toBe("t-new");
    expect(rows[1]?.id).toBe("t-old");
    // join 字段：owner 来自 u1
    expect(rows[1]?.ownerName).toBe("Alice");
    expect(rows[1]?.ownerEmail).toBe("alice@x");
  });

  it("listThreadsForUser 隔离他人 thread（owner 隔离）", async () => {
    await insertUser("u1");
    await insertUser("u2");
    await insertThread("t1", "u1");
    await insertThread("t2", "u2");

    const rows = await listThreadsForUser("u1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("t1");
  });

  it("listToolRunsForThread 仅返回该 thread 的 tool run，按 startedAt asc", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    const early = new Date("2026-01-01");
    const late = new Date("2026-02-01");
    await insertToolRunRow("r2", "t1", { toolName: "readFile", startedAt: late });
    await insertToolRunRow("r1", "t1", { toolName: "writeFile", startedAt: early });

    const rows = await listToolRunsForThread("t1");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe("r1");
    expect(rows[0]?.toolName).toBe("writeFile");
    expect(rows[1]?.id).toBe("r2");
  });

  it("listToolRunsForThread 隔离其他 thread", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertThread("t2", "u1");
    await insertToolRunRow("r1", "t1");
    await insertToolRunRow("r2", "t2");

    const rows = await listToolRunsForThread("t1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.threadId).toBe("t1");
  });

  it("listEventsForThread 按 sequence asc", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertEvent("e2", "t1", 2, "agent.finished");
    await insertEvent("e1", "t1", 1, "agent.started");

    const rows = await listEventsForThread("t1");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.sequence).toBe(1);
    expect(rows[0]?.type).toBe("agent.started");
    expect(rows[1]?.sequence).toBe(2);
  });

  it("listArtifactsForThread 仅返回 artifact.* 类型事件，按 sequence asc", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertEvent("e1", "t1", 1, "agent.started");
    await insertEvent("e2", "t1", 5, "artifact.created", { payload: { type: "preview" } });
    await insertEvent("e3", "t1", 8, "artifact.updated");
    await insertEvent("e4", "t1", 9, "agent.finished");

    const rows = await listArtifactsForThread("t1");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.sequence).toBe(5);
    expect(rows[0]?.type).toBe("artifact.created");
    expect(rows[1]?.sequence).toBe(8);
    expect(rows[1]?.type).toBe("artifact.updated");
  });

  it("listArtifactsForThread 隔离其他 thread 的 artifact 事件", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    await insertThread("t2", "u1");
    await insertEvent("e1", "t1", 1, "artifact.created");
    await insertEvent("e2", "t2", 1, "artifact.created");

    const rows = await listArtifactsForThread("t1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.threadId).toBe("t1");
  });

  it("空集 → []", async () => {
    await insertUser("u1");
    await expect(listThreadsForUser("u1")).resolves.toEqual([]);
    await expect(listToolRunsForThread("nope")).resolves.toEqual([]);
    await expect(listEventsForThread("nope")).resolves.toEqual([]);
    await expect(listArtifactsForThread("nope")).resolves.toEqual([]);
  });
});

// ─── listRecentArtifactsForUser ──────────────────────────────

describe("listRecentArtifactsForUser (owner-scoped 聚合, 真实 MySQL)", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("admin(canAll=true) → 全表聚合所有 user 的 artifact，按 createdAt desc，含 threadTitle", async () => {
    await insertUser("u1", "Alice");
    await insertUser("u2", "Bob");
    await insertThread("t1", "u1", { title: "alice-thread" });
    await insertThread("t2", "u2", { title: "bob-thread" });
    const c0 = new Date("2026-01-01");
    const c1 = new Date("2026-02-01");
    await insertEvent("a1", "t1", 1, "artifact.created", { createdAt: c0 });
    await insertEvent("a2", "t2", 1, "artifact.updated", { createdAt: c1 });
    // 非 artifact 事件应被过滤
    await insertEvent("a3", "t1", 2, "agent.started", { createdAt: c1 });

    const rows = await listRecentArtifactsForUser("u1", true, 50);
    expect(rows).toHaveLength(2);
    // createdAt desc：a2(c1) 在前
    expect(rows[0]?.id).toBe("a2");
    expect(rows[0]?.threadTitle).toBe("bob-thread");
    expect(rows[1]?.id).toBe("a1");
    expect(rows[1]?.threadTitle).toBe("alice-thread");
  });

  it("member(canAll=false) → innerJoin thread 按 userId 限定，仅返回自己的 artifact", async () => {
    await insertUser("u1", "Alice");
    await insertUser("u2", "Bob");
    await insertThread("t1", "u1", { title: "alice-thread" });
    await insertThread("t2", "u2", { title: "bob-thread" });
    const c0 = new Date("2026-01-01");
    const c1 = new Date("2026-02-01");
    await insertEvent("a1", "t1", 1, "artifact.created", { createdAt: c0 });
    await insertEvent("a2", "t2", 1, "artifact.created", { createdAt: c1 });

    const rows = await listRecentArtifactsForUser("u1", false, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("a1");
    expect(rows[0]?.threadId).toBe("t1");
    expect(rows[0]?.threadTitle).toBe("alice-thread");
  });

  it("member 路径不泄露他人 thread 的 artifact（owner 隔离强校验）", async () => {
    await insertUser("u1");
    await insertUser("u2");
    await insertThread("t-u1", "u1");
    await insertThread("t-u2", "u2");
    await insertEvent("a1", "t-u1", 1, "artifact.created");
    await insertEvent("a2", "t-u2", 1, "artifact.created");
    await insertEvent("a3", "t-u2", 2, "artifact.updated");

    const rows = await listRecentArtifactsForUser("u1", false, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("a1");
  });

  it("无匹配 → []", async () => {
    await insertUser("u1");
    await expect(listRecentArtifactsForUser("u1", false, 50)).resolves.toEqual([]);
    await expect(listRecentArtifactsForUser("u1", true, 50)).resolves.toEqual([]);
  });

  it("limit 截断（admin 路径）", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    // 插 3 条 artifact，limit=2 应只返回 2 条（createdAt 最新的两条）
    const c0 = new Date("2026-01-01");
    const c1 = new Date("2026-01-02");
    const c2 = new Date("2026-01-03");
    await insertEvent("a1", "t1", 1, "artifact.created", { createdAt: c0 });
    await insertEvent("a2", "t1", 2, "artifact.created", { createdAt: c1 });
    await insertEvent("a3", "t1", 3, "artifact.created", { createdAt: c2 });

    const rows = await listRecentArtifactsForUser("u1", true, 2);
    expect(rows).toHaveLength(2);
    // createdAt desc：最新的两条
    expect(rows[0]?.id).toBe("a3");
    expect(rows[1]?.id).toBe("a2");
  });

  it("limit 截断（member 路径）", async () => {
    await insertUser("u1");
    await insertThread("t1", "u1");
    const c0 = new Date("2026-01-01");
    const c1 = new Date("2026-01-02");
    const c2 = new Date("2026-01-03");
    await insertEvent("a1", "t1", 1, "artifact.created", { createdAt: c0 });
    await insertEvent("a2", "t1", 2, "artifact.created", { createdAt: c1 });
    await insertEvent("a3", "t1", 3, "artifact.created", { createdAt: c2 });

    const rows = await listRecentArtifactsForUser("u1", false, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe("a3");
  });

  it("admin 路径 leftJoin 带出 threadTitle（thread 存在）", async () => {
    // 注：ThreadEvent.threadId → Thread.id 是真实 FK 约束，无法插孤儿事件制造 threadTitle=null。
    // leftJoin null 分支在生产中只会出现在 thread 被物理删除而事件残留时——
    // 但本 schema 用软删（thread.deletedAt），不物理删除，故该分支实际不可达，
    // 此处只校验正常数据的 leftJoin 字段正确性。
    await insertUser("u1");
    await insertThread("t1", "u1", { title: "live" });
    await insertEvent("a1", "t1", 1, "artifact.created");

    const rows = await listRecentArtifactsForUser("u1", true, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.threadTitle).toBe("live");
  });
});
