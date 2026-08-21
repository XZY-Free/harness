import { db } from "@/lib/db/client";
import { skill, skillVersion } from "@/lib/db/schema";
import { listSkillVersions, listSkills } from "@/lib/db/studio-queries";
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
