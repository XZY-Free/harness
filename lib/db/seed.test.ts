import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, getTableName, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * seed 真实 MySQL 同构测试。
 *
 * 生产是 MySQL（mysql2 + drizzle），测试用 testcontainers 起真实 MySQL 8 容器，
 * migration 用 PascalCase 表名,unique / 外键约束真实生效——这是验证 seed 幂等
 * 语义（unique 冲突被应用层逻辑处理、不重复插入）的关键。
 *
 * beforeEach resetDatabase 清空所有表，保证测试间隔离。seed 走真实 queries 层
 * 连真实 DB，不 mock db client。skill 目录仓库用 tmp 目录隔离（writeSkillFile +
 * commitSkillVersion 真跑 git）。
 *
 * ── 生产代码缺陷（已暴露,未修复） ──────────────────────────
 * seedDefaultSkill 在 "skill 行存在但 currentVersionId 损坏(为 null 或指向已删
 * version)" 场景下不幂等:若 SKILL.md 内容与 git HEAD 一致(skill 已发布过,工作副本
 * 未改动),commitSkillVersion 因 git status.staged 为空抛 SkillRepoError("无改动"),
 * 无法重建 version 行。原 fake-db 测试 mock commitSkillVersion 掩盖了此问题。
 * 真实修复方向:commitSkillVersion 对"无改动但需建 version"场景用 HEAD sha 兜底,
 * 或 seedDefaultSkill 检测到 skill 存在且 git HEAD 已有 SKILL.md 时直接用 HEAD sha
 * 建 version 而不调 commitSkillVersion。
 */

import { db } from "@/lib/db/client";
import {
  agent,
  policyConfig,
  providerProfile,
  role,
  rolePermission,
  skill,
  skillVersion,
  user,
  userRole,
} from "@/lib/db/schema";
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_PROVIDER_NAME,
  DEFAULT_SKILL_NAME,
  DEFAULT_SKILL_TOOLS,
  SEED_VERSION,
  seedDefaultAgents,
  seedDefaultPolicy,
  seedDefaultProviders,
  seedDefaultRoles,
  seedDefaultSkill,
} from "@/lib/db/seed";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ADMIN_PERMISSIONS, MEMBER_PERMISSIONS } from "@/lib/rbac";

let skillRepoDir: string;

beforeEach(async () => {
  await resetDatabase(db);
  // seed 真跑 skill git repo（writeSkillFile + commitSkillVersion），用 tmp 目录隔离
  skillRepoDir = await mkdtemp(join(tmpdir(), "seed-skill-"));
  process.env.SNOW_SKILLS_DIR = skillRepoDir;
});

afterEach(async () => {
  Reflect.deleteProperty(process.env, "SNOW_SKILLS_DIR");
  await rm(skillRepoDir, { recursive: true, force: true });
});

/** COUNT(*) 助手：drizzle mysql execute 返回 [rows, fields]，取第一行第一列。 */
async function countRows(table: Parameters<typeof getTableName>[0]): Promise<number> {
  const tableName = getTableName(table);
  const [rows] = (await db.execute(
    sql`SELECT COUNT(*) AS c FROM ${sql.identifier(tableName)}`,
  )) as unknown as [Array<{ c: number }>];
  return Number(rows[0]?.c ?? 0);
}

// ─── 常量断言 ───────────────────────────────────────────────

describe("DEFAULT_SKILL_TOOLS", () => {
  it("含全部 6 个工具且含 reportReady（§4.4 预览闸门依赖）", () => {
    expect(DEFAULT_SKILL_TOOLS).toEqual([
      "writeFile",
      "readFile",
      "listFiles",
      "runCommand",
      "runTests",
      "reportReady",
    ]);
    expect(DEFAULT_SKILL_TOOLS).toContain("reportReady");
  });
});

// ─── seedDefaultSkill ───────────────────────────────────────

describe("seedDefaultSkill", () => {
  it("首次：skill 不存在 → 建 skill + v1 + 回填 currentVersionId", async () => {
    const r = await seedDefaultSkill();

    expect(r.created).toBe(true);
    expect(r.skillId).toEqual(expect.any(String));
    expect(r.versionId).toEqual(expect.any(String));

    // skill 表落 1 行,属性符合预期
    const [sk] = await db.select().from(skill).where(eq(skill.id, r.skillId)).limit(1);
    expect(sk).toBeDefined();
    expect(sk?.name).toBe(DEFAULT_SKILL_NAME);
    expect(sk?.category).toBe("fullstack");
    expect(sk?.status).toBe("active");
    expect(sk?.currentVersionId).toBe(r.versionId);

    // skill_versions 落 1 行,allowedTools 含 reportReady
    const [ver] = await db
      .select()
      .from(skillVersion)
      .where(eq(skillVersion.id, r.versionId))
      .limit(1);
    expect(ver).toBeDefined();
    expect(ver?.skillId).toBe(r.skillId);
    expect(ver?.version).toBe(1);
    expect(ver?.reviewMode).toBe("auto");
    expect(ver?.status).toBe("active");
    expect(ver?.allowedTools).toEqual([...DEFAULT_SKILL_TOOLS]);
    expect(ver?.commitSha).toEqual(expect.any(String));
    expect(ver?.commitSha?.length).toBeGreaterThan(0);
  });

  it("幂等：skill 已有 active 版本 → no-op，不重复建版本、不重复建 skill", async () => {
    const first = await seedDefaultSkill();
    const second = await seedDefaultSkill();

    expect(second.created).toBe(false);
    expect(second.skillId).toBe(first.skillId);
    expect(second.versionId).toBe(first.versionId);

    // skill 表仍 1 行,skill_versions 仍 1 行
    expect(await countRows(skill)).toBe(1);
    expect(await countRows(skillVersion)).toBe(1);
  });

  // 已知生产 bug,见文件顶部"生产代码缺陷"注释。用 it.fails 标记:期望测试失败(抛错)。
  // bug 修复后(幂等恢复 version),断言会通过 → it.fails 失败 → 提醒修复者改回 it。
  it.fails(
    "skill 存在但无 active 版本 → 补建 v1 + 回填 currentVersionId（已知 bug:SKILL.md 未变时 git 无改动抛错）",
    async () => {
      // 先正常 seed 一次拿到 skill
      const first = await seedDefaultSkill();
      // 手动清掉 currentVersionId + 删 version,模拟"skill 存在但 version 损坏"
      // (真实运维场景:DB 备份恢复后 version 表丢失但 skill 表保留,或人工误删 version 行)
      await db.update(skill).set({ currentVersionId: null }).where(eq(skill.id, first.skillId));
      await db.delete(skillVersion).where(eq(skillVersion.id, first.versionId));

      // SKILL.md 内容与 git HEAD 一致(skill 已发布过,工作副本未改动)——
      // commitSkillVersion 因 git status.staged 为空抛 SkillRepoError,无法重建 version。
      const r = await seedDefaultSkill();

      expect(r.created).toBe(true);
      expect(r.skillId).toBe(first.skillId);
      expect(r.versionId).not.toBe(first.versionId);
      expect(await countRows(skillVersion)).toBe(1);
      const [sk] = await db.select().from(skill).where(eq(skill.id, first.skillId)).limit(1);
      expect(sk?.currentVersionId).toBe(r.versionId);
    },
  );
});

// ─── seedDefaultRoles ───────────────────────────────────────

describe("seedDefaultRoles", () => {
  it("首次：角色不存在 → 建 admin/member + 覆盖权限 + 默认用户绑 admin", async () => {
    await seedDefaultRoles();

    // 2 个角色 admin / member
    const roles = await db.select().from(role).orderBy(asc(role.key));
    expect(roles).toHaveLength(2);
    expect(roles.map((r) => r.key)).toEqual(["admin", "member"]);
    expect(roles.every((r) => r.isSystem)).toBe(true);
    expect(roles.map((r) => r.name)).toEqual(["管理员", "成员"]);

    // admin 拿全部权限
    const admin = roles.find((r) => r.key === "admin")!;
    const adminPerms = await db
      .select({ permission: rolePermission.permission })
      .from(rolePermission)
      .where(eq(rolePermission.roleId, admin.id));
    expect(new Set(adminPerms.map((p) => p.permission))).toEqual(new Set(ADMIN_PERMISSIONS));

    // member 拿受限权限（无 skill.write）
    const member = roles.find((r) => r.key === "member")!;
    const memberPerms = await db
      .select({ permission: rolePermission.permission })
      .from(rolePermission)
      .where(eq(rolePermission.roleId, member.id));
    const memberPermSet = new Set(memberPerms.map((p) => p.permission));
    expect(memberPermSet).toEqual(new Set(MEMBER_PERMISSIONS));
    expect(memberPermSet.has("skill.write")).toBe(false);

    // 默认用户已建且绑 admin
    const users = await db.select().from(user);
    expect(users).toHaveLength(1);
    const defaultUser = users[0];
    expect(defaultUser).toBeDefined();
    if (!defaultUser) throw new Error("expected default user");

    const bindings = await db.select().from(userRole).where(eq(userRole.userId, defaultUser.id));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.roleId).toBe(admin.id);
  });

  it("幂等：角色已存在 → 不建角色、不重复权限、不重复绑定（真实 unique 约束生效）", async () => {
    await seedDefaultRoles();
    // 第二次 seed：必须不抛 unique 冲突,且数据行数不变
    await expect(seedDefaultRoles()).resolves.toBeUndefined();

    const roles = await db.select().from(role);
    expect(roles).toHaveLength(2);

    // RolePermission 真实 unique (roleId, permission)：重复 setRolePermissions 删旧+插新,
    // 行数应与 ADMIN_PERMISSIONS + MEMBER_PERMISSIONS 一致,不累积
    const perms = await db.select().from(rolePermission);
    expect(perms).toHaveLength(ADMIN_PERMISSIONS.length + MEMBER_PERMISSIONS.length);

    // UserRole 真实 unique (userId, roleId)：assignRoleToUser 用 INSERT IGNORE,
    // 默认用户只绑 1 条 admin,不累积
    const users = await db.select().from(user);
    expect(users).toHaveLength(1);
    const u0 = users[0];
    if (!u0) throw new Error("expected user");
    const bindings = await db.select().from(userRole).where(eq(userRole.userId, u0.id));
    expect(bindings).toHaveLength(1);
  });

  it("升级：旧英文名 → rename 成中文（幂等校正）", async () => {
    await seedDefaultRoles();
    // 手动把 name 改回英文,模拟旧部署
    await db.update(role).set({ name: "Administrator" }).where(eq(role.key, "admin"));
    await db.update(role).set({ name: "Member" }).where(eq(role.key, "member"));

    await seedDefaultRoles();

    const roles = await db.select().from(role).orderBy(asc(role.key));
    expect(roles.map((r) => r.name)).toEqual(["管理员", "成员"]);
    // 角色行数仍 2（不重建）
    expect(roles).toHaveLength(2);
  });
});

// ─── seedDefaultPolicy ──────────────────────────────────────

describe("seedDefaultPolicy", () => {
  it("首次：灌入 4 个 policy key（ON DUPLICATE KEY UPDATE 幂等）", async () => {
    await seedDefaultPolicy();

    const rows = await db.select().from(policyConfig);
    // 4 个默认 key（protectedPaths / commandDenyList / formatOnWrite / verifyBeforeDelivery）
    expect(rows).toHaveLength(4);
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual([
      "commandDenyList",
      "formatOnWrite",
      "protectedPaths",
      "verifyBeforeDelivery",
    ]);
  });

  it("幂等：重复 seed 不累积行数,值被覆盖为默认", async () => {
    await seedDefaultPolicy();
    // 手动改一个 value 模拟用户后续编辑,seed 应覆盖回默认
    await db
      .update(policyConfig)
      .set({ value: ["tampered"] })
      .where(eq(policyConfig.key, "commandDenyList"));

    await seedDefaultPolicy();

    const rows = await db.select().from(policyConfig);
    expect(rows).toHaveLength(4);
    const cmd = rows.find((r) => r.key === "commandDenyList");
    expect(cmd?.value).not.toEqual(["tampered"]);
    // 默认 commandDenyList 是 string[]
    expect(Array.isArray(cmd?.value)).toBe(true);
  });
});

// ─── seedDefaultProviders ───────────────────────────────────

describe("seedDefaultProviders", () => {
  it("首次：provider 不存在 → 建 default，apiKeyRef=LLM_API_KEY（不落明文）", async () => {
    const r = await seedDefaultProviders();

    expect(r.created).toBe(true);
    const rows = await db.select().from(providerProfile);
    expect(rows).toHaveLength(1);
    const p = rows[0]!;
    expect(p.name).toBe(DEFAULT_PROVIDER_NAME);
    expect(p.apiKeyRef).toBe("LLM_API_KEY");
    expect(p.isDefault).toBe(true);
    // 断言不落明文：apiKeyRef 仅 env 引用名,不含 sk- 前缀真 key
    expect(JSON.stringify(p)).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });

  it("幂等：provider 已存在 → no-op，不建", async () => {
    await seedDefaultProviders();
    const r = await seedDefaultProviders();

    expect(r.created).toBe(false);
    expect(await countRows(providerProfile)).toBe(1);
  });
});

// ─── seedDefaultAgents ──────────────────────────────────────

describe("seedDefaultAgents", () => {
  it("示例 skill 未就绪 → 跳过（不报错，不建 agent）", async () => {
    const r = await seedDefaultAgents();

    expect(r).toEqual({ created: false, skipped: true });
    expect(await countRows(agent)).toBe(0);
  });

  it("首次：agent 不存在 + 示例 skill 就绪 → 建 default，config 显式 {}", async () => {
    await seedDefaultSkill();
    const r = await seedDefaultAgents();

    expect(r).toEqual({ created: true, skipped: false });
    const rows = await db.select().from(agent);
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.name).toBe(DEFAULT_AGENT_NAME);
    expect(a.config).toEqual({});
    // skillId 真实指向已建的 skill
    const [sk] = await db.select().from(skill).where(eq(skill.name, DEFAULT_SKILL_NAME)).limit(1);
    expect(a.skillId).toBe(sk?.id ?? null);
  });

  it("幂等：agent 已存在 → no-op", async () => {
    await seedDefaultSkill();
    await seedDefaultAgents();
    const r = await seedDefaultAgents();

    expect(r).toEqual({ created: false, skipped: false });
    expect(await countRows(agent)).toBe(1);
  });
});

// ─── SEED_VERSION 幂等标记 ──────────────────────────────────

describe("SEED_VERSION 幂等标记", () => {
  it("SEED_VERSION 常量已导出且为非空字符串", () => {
    expect(typeof SEED_VERSION).toBe("string");
    expect(SEED_VERSION.length).toBeGreaterThan(0);
  });

  it("真实 DB：getSeedVersion 初始 null,setSeedVersion 写入后可读回", async () => {
    const { getSeedVersion, setSeedVersion } = await import("@/lib/db/queries");

    expect(await getSeedVersion()).toBeNull();

    await setSeedVersion(SEED_VERSION);
    expect(await getSeedVersion()).toBe(SEED_VERSION);

    // policyConfig 表真实落了 seed_version 行
    const [row] = await db
      .select()
      .from(policyConfig)
      .where(eq(policyConfig.key, "seed_version"))
      .limit(1);
    expect(row?.value).toBe(SEED_VERSION);
  });

  it("真实 DB：setSeedVersion 重复调用覆盖（不累积行）", async () => {
    const { setSeedVersion, getSeedVersion } = await import("@/lib/db/queries");

    await setSeedVersion("v1");
    await setSeedVersion("v2");

    expect(await getSeedVersion()).toBe("v2");
    const rows = await db.select().from(policyConfig).where(eq(policyConfig.key, "seed_version"));
    expect(rows).toHaveLength(1);
  });
});

// ─── 端到端：完整 seed 流程幂等 ─────────────────────────────

describe("完整 seed 流程（端到端真实 DB）", () => {
  it("依次跑全部 seed 函数 → 重复跑不报错、行数不累积", async () => {
    async function runAll() {
      await seedDefaultSkill();
      await seedDefaultRoles();
      await seedDefaultPolicy();
      await seedDefaultProviders();
      await seedDefaultAgents();
    }

    await runAll();

    // 抓首跑快照
    const snap = {
      skill: await countRows(skill),
      skillVersion: await countRows(skillVersion),
      role: await countRows(role),
      rolePermission: await countRows(rolePermission),
      user: await countRows(user),
      userRole: await countRows(userRole),
      policyConfig: await countRows(policyConfig),
      providerProfile: await countRows(providerProfile),
      agent: await countRows(agent),
    };

    // 期望值
    expect(snap.skill).toBe(1);
    expect(snap.skillVersion).toBe(1);
    expect(snap.role).toBe(2);
    expect(snap.rolePermission).toBe(ADMIN_PERMISSIONS.length + MEMBER_PERMISSIONS.length);
    expect(snap.user).toBe(1);
    expect(snap.userRole).toBe(1);
    expect(snap.policyConfig).toBe(4);
    expect(snap.providerProfile).toBe(1);
    expect(snap.agent).toBe(1);

    // 第二次跑：真实 unique 约束 + 应用层幂等逻辑共同保证不抛错、不累积
    await expect(runAll()).resolves.toBeUndefined();

    expect(await countRows(skill)).toBe(snap.skill);
    expect(await countRows(skillVersion)).toBe(snap.skillVersion);
    expect(await countRows(role)).toBe(snap.role);
    expect(await countRows(rolePermission)).toBe(snap.rolePermission);
    expect(await countRows(user)).toBe(snap.user);
    expect(await countRows(userRole)).toBe(snap.userRole);
    expect(await countRows(policyConfig)).toBe(snap.policyConfig);
    expect(await countRows(providerProfile)).toBe(snap.providerProfile);
    expect(await countRows(agent)).toBe(snap.agent);
  });
});
