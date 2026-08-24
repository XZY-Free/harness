import { listSkillVersions, listSkills } from "@/lib/capability/skill-studio-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { tenant as tenantTable } from "@/lib/persistence/schema/identity";
import { skillTable, skillVersionTable } from "@/lib/persistence/schema/skill";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * 02-4：studio skill 只读查询单测（真实 MySQL）。
 *
 * 长期职责：这是 studio skill 只读查询的正式测试（真实 MySQL），
 * 由 db project singleFork 串行运行；unit project 明确 exclude，防重复 resetDatabase。
 *
 * 生产是 MySQL（mysql2 + drizzle），测试用 testcontainers 起真实 MySQL 8 容器，
 * beforeEach resetDatabase 清空所有表，用 db.insert 真实插数据满足外键后调真实查询函数。
 *
 * 外键链：tenant ← Skill ← SkillVersion；Skill.ownerUserId 逻辑外键（无 DB 级 FK）。
 */

const TENANT = "tenant-1";

// ─── 测试数据工厂 ─────────────────────────────────────────────

async function insertSkill(
  id: string,
  skillKey: string,
  opts: {
    tenantId?: string;
    lifecycleState?: "draft" | "enabled" | "disabled" | "retired";
    ownerUserId?: string;
    currentVersionId?: string | null;
    createdAt?: Date;
  } = {},
) {
  await db.insert(skillTable).values({
    id,
    tenantId: opts.tenantId ?? TENANT,
    skillKey,
    displayName: skillKey,
    ownerUserId: opts.ownerUserId ?? "u1",
    lifecycleState: opts.lifecycleState ?? "enabled",
    currentVersionId: opts.currentVersionId ?? null,
    createdAt: opts.createdAt ?? new Date(),
  });
}

async function insertSkillVersionRow(
  id: string,
  skillId: string,
  versionNo: number,
  opts: { createdAt?: Date } = {},
) {
  await db.insert(skillVersionTable).values({
    id,
    skillId,
    versionNo,
    contentRef: `sha-${id}`,
    contentHash: `sha256:${id}`,
    createdBy: "u1",
    createdAt: opts.createdAt ?? new Date(),
  });
}

// ─── listSkills ──────────────────────────────────────────────

describe("listSkills (真实 MySQL)", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    // resetDatabase TRUNCATE 全部表（含 Tenant），故须先补租户行满足 Skill_tenantId_Tenant_id_fk
    // 外键，再插 Skill/SkillVersion。本测试用到的租户：TENANT 与 tenant-2（隔离用例）。
    await db.insert(tenantTable).values({ id: TENANT, key: TENANT, name: TENANT });
    await db.insert(tenantTable).values({ id: "tenant-2", key: "tenant-2", name: "tenant-2" });
  });

  it("全量返回（admin 视角，含 currentVersionId），按 createdAt desc", async () => {
    const t0 = new Date("2026-01-01");
    const t1 = new Date("2026-02-01");
    await insertSkill("s-old", "old", { createdAt: t0 });
    await insertSkill("s-new", "new", { createdAt: t1, currentVersionId: "v1" });

    const rows = await listSkills(TENANT);
    expect(rows).toHaveLength(2);
    // createdAt desc：new 在前
    expect(rows[0]?.id).toBe("s-new");
    expect(rows[0]?.currentVersionId).toBe("v1");
    expect(rows[1]?.id).toBe("s-old");
    expect(rows[1]?.currentVersionId).toBeNull();
  });

  it("空集 → []", async () => {
    await expect(listSkills(TENANT)).resolves.toEqual([]);
  });

  it("tenant 隔离：只返回本租户 skill", async () => {
    await insertSkill("s-a", "a", { tenantId: TENANT });
    await insertSkill("s-other", "other", { tenantId: "tenant-2" });

    const rows = await listSkills(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("s-a");
  });

  it("activeOnly=true 仅返回 lifecycleState=enabled，过滤 disabled 软删", async () => {
    await insertSkill("s1", "active-skill", { lifecycleState: "enabled" });
    await insertSkill("s2", "disabled-skill", { lifecycleState: "disabled" });

    const rows = await listSkills(TENANT, undefined, { activeOnly: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("s1");
    expect(rows[0]?.lifecycleState).toBe("enabled");
  });

  it("activeOnly=false（默认）含 disabled", async () => {
    await insertSkill("s1", "a", { lifecycleState: "enabled" });
    await insertSkill("s2", "b", { lifecycleState: "disabled" });

    const rows = await listSkills(TENANT);
    expect(rows).toHaveLength(2);
  });

  it("owner filter 仅返回 ownerUserId 匹配的 skill", async () => {
    await insertSkill("s-mine", "mine", { ownerUserId: "u1" });
    await insertSkill("s-other", "other", { ownerUserId: "u2" });

    const rows = await listSkills(TENANT, { ownerUserId: "u1", includePublic: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("s-mine");
  });

  it("owner filter + includePublic=true 含公共 skill（ownerUserId null）", async () => {
    // 正式 skillTable.ownerUserId notNull，公共（null owner）skill 仅作兼容分支；
    // 实际返回 = owner 匹配 + 公共（此处公共集为空，故只返回 owner 匹配）。
    await insertSkill("s-mine", "mine", { ownerUserId: "u1" });
    await insertSkill("s-other", "other", { ownerUserId: "u2" });

    const rows = await listSkills(TENANT, { ownerUserId: "u1", includePublic: true });
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["s-mine"]);
  });

  it("activeOnly + owner filter 组合（两条件并存）", async () => {
    await insertSkill("s-mine-active", "ma", { ownerUserId: "u1", lifecycleState: "enabled" });
    await insertSkill("s-mine-disabled", "mr", { ownerUserId: "u1", lifecycleState: "disabled" });
    await insertSkill("s-other-active", "oa", { ownerUserId: "u2", lifecycleState: "enabled" });

    const rows = await listSkills(
      TENANT,
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
    // resetDatabase TRUNCATE 全部表（含 Tenant），故须先补租户行满足 Skill_tenantId_Tenant_id_fk
    // 外键，再插 Skill/SkillVersion。本测试用到的租户：TENANT 与 tenant-2（隔离用例）。
    await db.insert(tenantTable).values({ id: TENANT, key: TENANT, name: TENANT });
    await db.insert(tenantTable).values({ id: "tenant-2", key: "tenant-2", name: "tenant-2" });
  });

  it("返回某 skill 的版本列表，按 versionNo desc", async () => {
    await insertSkill("s1", "build-from-idea");
    await insertSkillVersionRow("v2", "s1", 2);
    await insertSkillVersionRow("v1", "s1", 1);

    const rows = await listSkillVersions(TENANT, "s1");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.versionNo).toBe(2);
    expect(rows[1]?.versionNo).toBe(1);
  });

  it("仅返回该 skill 的版本（不串到其他 skill）", async () => {
    await insertSkill("s1", "a");
    await insertSkill("s2", "b");
    await insertSkillVersionRow("v1", "s1", 1);
    await insertSkillVersionRow("v2", "s2", 1);

    const rows = await listSkillVersions(TENANT, "s1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skillId).toBe("s1");
  });

  it("无版本 → []", async () => {
    await insertSkill("s1", "a");
    await expect(listSkillVersions(TENANT, "s1")).resolves.toEqual([]);
  });
});
