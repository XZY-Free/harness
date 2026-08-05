import {
  GET as getSkillGET,
  PATCH as patchSkillPATCH,
} from "@/app/admin/api/v1/skills/[skill_id]/route";
import { POST as createVersionPOST } from "@/app/admin/api/v1/skills/[skill_id]/versions/route";
/**
 * S06-C01：V11 Skill / SkillVersion 仓储与 Admin API 集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - content-cache：computeContentHash / verifyContentHash / isValidContentHash。
 * - Skill 仓储：createSkill / getSkillById / getSkillByKey / listSkills / updateSkill。
 * - SkillVersion 仓储：createSkillVersion / getSkillVersionById / listSkillVersions /
 *   getCurrentSkillVersion / publishSkillVersion。
 * - Admin API：
 *   - POST /admin/api/v1/skills
 *   - GET /admin/api/v1/skills
 *   - GET /admin/api/v1/skills/{skill_id}
 *   - PATCH /admin/api/v1/skills/{skill_id}
 *   - POST /admin/api/v1/skills/{skill_id}/versions
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。Admin API 测试需 SNOW_AUTH_MODE=dev +
 * grantActionBinding 绑定 skill.create/skill.update/skill.publish/skill.version.create。
 */
import { POST as createSkillPOST, GET as listSkillsGET } from "@/app/admin/api/v1/skills/route";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { assertCrossTenantHidden, buildV11Request } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  computeContentHash,
  isValidContentHash,
  verifyContentHash,
} from "@/lib/v11/capability/content-cache";
import {
  SKILL_KEY_REGEX,
  SkillLifecycleError,
  type SkillLifecycleState,
  SkillNotFoundError,
  SkillValidationError,
  SkillVersionConflictError,
  SkillVersionNotFoundError,
  type SkillVisibilityScope,
  createSkill,
  createSkillVersion,
  getCurrentSkillVersion,
  getSkillById,
  getSkillByKey,
  getSkillVersionById,
  listSkillVersions,
  listSkills,
  publishSkillVersion,
  updateSkill,
} from "@/lib/v11/capability/skill-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 admin-api.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：seed admin 用户 + skill action bindings ─────────

async function seedAdminWithSkillBindings() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const binding = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });
  // skill.create：tenant wildcard（创建本租户内 Skill）。
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "skill.create",
    resourceScope: { type: "tenant", wildcard: true },
  });
  // skill.update：skill wildcard（更新本租户内所有 Skill）。
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "skill.update",
    resourceScope: { type: "skill", wildcard: true },
  });
  // skill.publish：skill wildcard。
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "skill.publish",
    resourceScope: { type: "skill", wildcard: true },
  });
  // skill.version.create：skill wildcard。
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "skill.version.create",
    resourceScope: { type: "skill", wildcard: true },
  });
  return { tenantId: tenant.id, userIdentityId: identity.id };
}

/** 构造一个合法的 sha256: hash。 */
function buildValidContentHash(content: string): string {
  return computeContentHash(content);
}

/** 构造一个非法的 hash 字符串（无前缀）。 */
function buildInvalidHash(): string {
  return "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
}

// ═══════════════════════════════════════════════════════════
// 1. content-cache 工具
// ═══════════════════════════════════════════════════════════

describe("V11 content-cache 工具", () => {
  it("computeContentHash 返回 sha256: 前缀 + 64 hex", () => {
    const hash = computeContentHash("hello world");
    expect(hash.startsWith("sha256:")).toBe(true);
    const hex = hash.slice("sha256:".length);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex.length).toBe(64);
  });

  it("computeContentHash 相同输入产生相同 hash", () => {
    const a = computeContentHash("same content");
    const b = computeContentHash("same content");
    expect(a).toBe(b);
  });

  it("computeContentHash 不同输入产生不同 hash", () => {
    const a = computeContentHash("content-a");
    const b = computeContentHash("content-b");
    expect(a).not.toBe(b);
  });

  it("verifyContentHash 合法 + 匹配 → true", () => {
    const hash = computeContentHash("verify-me");
    expect(verifyContentHash("verify-me", hash)).toBe(true);
  });

  it("verifyContentHash 内容不匹配 → false", () => {
    const hash = computeContentHash("original");
    expect(verifyContentHash("tampered", hash)).toBe(false);
  });

  it("verifyContentHash 非法 hash 格式 → false（fail-closed）", () => {
    expect(verifyContentHash("any", "not-a-hash")).toBe(false);
    expect(verifyContentHash("any", "")).toBe(false);
  });

  it("isValidContentHash 合法格式 → true", () => {
    expect(isValidContentHash(computeContentHash("x"))).toBe(true);
  });

  it("isValidContentHash 缺前缀 / 长度错误 / 含非 hex 字符 → false", () => {
    expect(isValidContentHash("sha256:abc")).toBe(false);
    expect(isValidContentHash(buildInvalidHash())).toBe(false);
    expect(
      isValidContentHash("sha256:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"),
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Skill 仓储：createSkill / getSkillById / getSkillByKey
// ═══════════════════════════════════════════════════════════

describe("V11 Skill 仓储：createSkill", () => {
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithSkillBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
  });

  it("createSkill 成功：默认 lifecycle=draft, visibility=tenant, source=local, versionNo=1", async () => {
    const skill = await createSkill({
      tenantId,
      skillKey: "finance-report",
      displayName: "财务报表 Skill",
      description: "生成财务报表",
      ownerUserId: ownerId,
      createdBy: ownerId,
    });

    expect(skill.id).toEqual(expect.any(String));
    expect(skill.tenantId).toBe(tenantId);
    expect(skill.skillKey).toBe("finance-report");
    expect(skill.displayName).toBe("财务报表 Skill");
    expect(skill.description).toBe("生成财务报表");
    expect(skill.ownerUserId).toBe(ownerId);
    expect(skill.lifecycleState).toBe("draft");
    expect(skill.visibilityScope).toBe("tenant");
    expect(skill.sourceType).toBe("local");
    expect(skill.versionNo).toBe(1);
    expect(skill.currentVersionId).toBeNull();
    expect(skill.deletedAt).toBeNull();
    expect(skill.createdAt).toEqual(expect.any(Date));
    expect(skill.updatedAt).toEqual(expect.any(Date));
  });

  it("createSkill 支持 visibilityScope=internal / sourceType=external", async () => {
    const skill = await createSkill({
      tenantId,
      skillKey: "internal-skill",
      displayName: "内部 Skill",
      ownerUserId: ownerId,
      visibilityScope: "internal",
      sourceType: "external",
      createdBy: ownerId,
    });
    expect(skill.visibilityScope).toBe("internal");
    expect(skill.sourceType).toBe("external");
  });

  it("createSkill skillKey 非法（含大写）→ SkillValidationError", async () => {
    await expect(
      createSkill({
        tenantId,
        skillKey: "Invalid-Key",
        displayName: "X",
        ownerUserId: ownerId,
        createdBy: ownerId,
      }),
    ).rejects.toThrow(SkillValidationError);
  });

  it("createSkill skillKey 非法（含下划线）→ SkillValidationError", async () => {
    await expect(
      createSkill({
        tenantId,
        skillKey: "invalid_key",
        displayName: "X",
        ownerUserId: ownerId,
        createdBy: ownerId,
      }),
    ).rejects.toThrow(SkillValidationError);
  });

  it("createSkill skillKey 非法（空字符串）→ SkillValidationError", async () => {
    await expect(
      createSkill({
        tenantId,
        skillKey: "",
        displayName: "X",
        ownerUserId: ownerId,
        createdBy: ownerId,
      }),
    ).rejects.toThrow(SkillValidationError);
  });

  it("createSkill displayName 为空 → SkillValidationError", async () => {
    await expect(
      createSkill({
        tenantId,
        skillKey: "empty-name",
        displayName: "",
        ownerUserId: ownerId,
        createdBy: ownerId,
      }),
    ).rejects.toThrow(SkillValidationError);
  });

  it("createSkill ownerUserId 为空 → SkillValidationError", async () => {
    await expect(
      createSkill({
        tenantId,
        skillKey: "no-owner",
        displayName: "X",
        ownerUserId: "",
        createdBy: ownerId,
      }),
    ).rejects.toThrow(SkillValidationError);
  });

  it("createSkill skillKey 重复 → SkillValidationError(code=skill_key_exists)", async () => {
    await createSkill({
      tenantId,
      skillKey: "duplicate-key",
      displayName: "First",
      ownerUserId: ownerId,
      createdBy: ownerId,
    });

    await expect(
      createSkill({
        tenantId,
        skillKey: "duplicate-key",
        displayName: "Second",
        ownerUserId: ownerId,
        createdBy: ownerId,
      }),
    ).rejects.toThrow(SkillValidationError);
  });

  it("SKILL_KEY_REGEX 校验：合法 key 形如 a-b-c", () => {
    expect(SKILL_KEY_REGEX.test("a")).toBe(true);
    expect(SKILL_KEY_REGEX.test("a-b")).toBe(true);
    expect(SKILL_KEY_REGEX.test("a-b-c")).toBe(true);
    expect(SKILL_KEY_REGEX.test("abc123")).toBe(true);
    expect(SKILL_KEY_REGEX.test("abc-123-def")).toBe(true);
  });

  it("SKILL_KEY_REGEX 校验：非法 key", () => {
    expect(SKILL_KEY_REGEX.test("A")).toBe(false);
    expect(SKILL_KEY_REGEX.test("a_b")).toBe(false);
    expect(SKILL_KEY_REGEX.test("a.b")).toBe(false);
    expect(SKILL_KEY_REGEX.test("-a")).toBe(false);
    expect(SKILL_KEY_REGEX.test("a-")).toBe(false);
    expect(SKILL_KEY_REGEX.test("a--b")).toBe(false);
  });
});

describe("V11 Skill 仓储：getSkillById / getSkillByKey 跨租户隔离", () => {
  let tenantId: string;
  let ownerId: string;
  let skillId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithSkillBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const skill = await createSkill({
      tenantId,
      skillKey: "iso-test",
      displayName: "ISO Test",
      ownerUserId: ownerId,
      createdBy: ownerId,
    });
    skillId = skill.id;
  });

  it("getSkillById 命中本租户 → 返回 Skill", async () => {
    const found = await getSkillById({ tenantId, skillId });
    expect(found).not.toBeNull();
    expect(found?.id).toBe(skillId);
  });

  it("getSkillById 跨租户 → 返回 null", async () => {
    const found = await getSkillById({
      tenantId: "11111111-1111-4111-8111-111111111111",
      skillId,
    });
    expect(found).toBeNull();
  });

  it("getSkillById 不存在 → 返回 null", async () => {
    const found = await getSkillById({
      tenantId,
      skillId: "99999999-9999-4999-8999-999999999999",
    });
    expect(found).toBeNull();
  });

  it("getSkillByKey 命中本租户 → 返回 Skill", async () => {
    const found = await getSkillByKey({ tenantId, skillKey: "iso-test" });
    expect(found?.id).toBe(skillId);
  });

  it("getSkillByKey 跨租户 → 返回 null", async () => {
    const found = await getSkillByKey({
      tenantId: "11111111-1111-4111-8111-111111111111",
      skillKey: "iso-test",
    });
    expect(found).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. listSkills 分页 + lifecycle / visibility 过滤
// ═══════════════════════════════════════════════════════════

describe("V11 Skill 仓储：listSkills 分页与过滤", () => {
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithSkillBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    // 创建 4 个 Skill，覆盖不同 lifecycle/visibility 组合：
    // - list-a: draft / tenant
    // - list-b: enabled / internal
    // - list-c: disabled / owner
    // - list-d: draft / tenant
    await createSkill({
      tenantId,
      skillKey: "list-a",
      displayName: "A",
      ownerUserId: ownerId,
      visibilityScope: "tenant",
      createdBy: ownerId,
    });
    const b = await createSkill({
      tenantId,
      skillKey: "list-b",
      displayName: "B",
      ownerUserId: ownerId,
      visibilityScope: "internal",
      createdBy: ownerId,
    });
    await updateSkill({
      tenantId,
      skillId: b.id,
      lifecycleState: "enabled",
      expectedVersionNo: 1,
    });
    const c = await createSkill({
      tenantId,
      skillKey: "list-c",
      displayName: "C",
      ownerUserId: ownerId,
      visibilityScope: "owner",
      createdBy: ownerId,
    });
    await updateSkill({
      tenantId,
      skillId: c.id,
      lifecycleState: "disabled",
      expectedVersionNo: 1,
    });
    await createSkill({
      tenantId,
      skillKey: "list-d",
      displayName: "D",
      ownerUserId: ownerId,
      visibilityScope: "tenant",
      createdBy: ownerId,
    });
  });

  it("listSkills 默认返回全部 4 条", async () => {
    const { items, nextCursor } = await listSkills({ tenantId });
    expect(items).toHaveLength(4);
    expect(nextCursor).toBeNull();
  });

  it("listSkills 按 lifecycle=draft 过滤 → 2 条", async () => {
    const { items } = await listSkills({
      tenantId,
      lifecycleStates: ["draft"] as readonly SkillLifecycleState[],
    });
    expect(items).toHaveLength(2);
    expect(items.every((s) => s.lifecycleState === "draft")).toBe(true);
  });

  it("listSkills 按 lifecycle=enabled 过滤 → 1 条", async () => {
    const { items } = await listSkills({
      tenantId,
      lifecycleStates: ["enabled"] as readonly SkillLifecycleState[],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.skillKey).toBe("list-b");
  });

  it("listSkills 按 visibility=internal 过滤 → 1 条", async () => {
    const { items } = await listSkills({
      tenantId,
      visibilityScopes: ["internal"] as readonly SkillVisibilityScope[],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.skillKey).toBe("list-b");
  });

  it("listSkills limit=2 → 返回 2 条 + nextCursor 非空", async () => {
    const { items, nextCursor } = await listSkills({ tenantId, limit: 2 });
    expect(items).toHaveLength(2);
    expect(nextCursor).not.toBeNull();
  });

  it("listSkills 使用 cursor 翻页可遍历全部 4 条", async () => {
    const first = await listSkills({ tenantId, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listSkills({ tenantId, limit: 2, cursor: first.nextCursor });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();

    // 两页合并去重 id 共 4 条
    const allIds = new Set([...first.items, ...second.items].map((s) => s.id));
    expect(allIds.size).toBe(4);
  });

  it("listSkills 跨租户 → 返回空", async () => {
    const { items } = await listSkills({
      tenantId: "11111111-1111-4111-8111-111111111111",
    });
    expect(items).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. updateSkill 乐观锁 + lifecycle 状态机
// ═══════════════════════════════════════════════════════════

describe("V11 Skill 仓储：updateSkill 乐观锁与状态机", () => {
  let tenantId: string;
  let ownerId: string;
  let skillId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithSkillBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const skill = await createSkill({
      tenantId,
      skillKey: "update-test",
      displayName: "Init",
      ownerUserId: ownerId,
      createdBy: ownerId,
    });
    skillId = skill.id;
  });

  it("updateSkill 更新 displayName + versionNo 递增", async () => {
    const updated = await updateSkill({
      tenantId,
      skillId,
      displayName: "Updated",
      expectedVersionNo: 1,
    });
    expect(updated.displayName).toBe("Updated");
    expect(updated.versionNo).toBe(2);
  });

  it("updateSkill 更新 description + visibilityScope", async () => {
    const updated = await updateSkill({
      tenantId,
      skillId,
      description: "new desc",
      visibilityScope: "internal",
      expectedVersionNo: 1,
    });
    expect(updated.description).toBe("new desc");
    expect(updated.visibilityScope).toBe("internal");
    expect(updated.versionNo).toBe(2);
  });

  it("updateSkill 乐观锁 versionNo 不匹配 → SkillVersionConflictError", async () => {
    await expect(
      updateSkill({
        tenantId,
        skillId,
        displayName: "Stale",
        expectedVersionNo: 999,
      }),
    ).rejects.toThrow(SkillVersionConflictError);
  });

  it("updateSkill lifecycle draft → enabled 合法", async () => {
    const updated = await updateSkill({
      tenantId,
      skillId,
      lifecycleState: "enabled",
      expectedVersionNo: 1,
    });
    expect(updated.lifecycleState).toBe("enabled");
  });

  it("updateSkill lifecycle enabled → disabled → enabled 合法", async () => {
    await updateSkill({ tenantId, skillId, lifecycleState: "enabled", expectedVersionNo: 1 });
    const disabled = await updateSkill({
      tenantId,
      skillId,
      lifecycleState: "disabled",
      expectedVersionNo: 2,
    });
    expect(disabled.lifecycleState).toBe("disabled");
    const reEnabled = await updateSkill({
      tenantId,
      skillId,
      lifecycleState: "enabled",
      expectedVersionNo: 3,
    });
    expect(reEnabled.lifecycleState).toBe("enabled");
  });

  it("updateSkill lifecycle draft → retired 合法", async () => {
    const retired = await updateSkill({
      tenantId,
      skillId,
      lifecycleState: "retired",
      expectedVersionNo: 1,
    });
    expect(retired.lifecycleState).toBe("retired");
  });

  it("updateSkill lifecycle retired → enabled 终态不可恢复 → SkillLifecycleError", async () => {
    await updateSkill({ tenantId, skillId, lifecycleState: "retired", expectedVersionNo: 1 });
    await expect(
      updateSkill({
        tenantId,
        skillId,
        lifecycleState: "enabled",
        expectedVersionNo: 2,
      }),
    ).rejects.toThrow(SkillLifecycleError);
  });

  it("updateSkill 跨租户 → SkillNotFoundError", async () => {
    await expect(
      updateSkill({
        tenantId: "11111111-1111-4111-8111-111111111111",
        skillId,
        displayName: "X",
        expectedVersionNo: 1,
      }),
    ).rejects.toThrow(SkillNotFoundError);
  });

  it("updateSkill displayName 空字符串 → SkillValidationError", async () => {
    await expect(
      updateSkill({
        tenantId,
        skillId,
        displayName: "",
        expectedVersionNo: 1,
      }),
    ).rejects.toThrow(SkillValidationError);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. SkillVersion 仓储
// ═══════════════════════════════════════════════════════════

describe("V11 SkillVersion 仓储：createSkillVersion", () => {
  let tenantId: string;
  let ownerId: string;
  let skillId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithSkillBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const skill = await createSkill({
      tenantId,
      skillKey: "version-test",
      displayName: "Version Test",
      ownerUserId: ownerId,
      createdBy: ownerId,
    });
    skillId = skill.id;
  });

  it("createSkillVersion 首次 versionNo=1, revisionState=draft", async () => {
    const version = await createSkillVersion({
      tenantId,
      skillId,
      contentRef: "git:abc123",
      contentHash: buildValidContentHash("content-v1"),
      manifestJson: { name: "v1", tools: ["search"] },
      createdBy: ownerId,
    });

    expect(version.skillId).toBe(skillId);
    expect(version.versionNo).toBe(1);
    expect(version.contentRef).toBe("git:abc123");
    expect(version.contentHash.startsWith("sha256:")).toBe(true);
    expect(version.revisionState).toBe("draft");
    expect(version.publishedAt).toBeNull();
    expect(version.manifestJson).toEqual({ name: "v1", tools: ["search"] });
  });

  it("createSkillVersion 第二次 versionNo=2 单调递增", async () => {
    await createSkillVersion({
      tenantId,
      skillId,
      contentRef: "git:v1",
      contentHash: buildValidContentHash("content-v1"),
      createdBy: ownerId,
    });
    const v2 = await createSkillVersion({
      tenantId,
      skillId,
      contentRef: "git:v2",
      contentHash: buildValidContentHash("content-v2"),
      createdBy: ownerId,
    });
    expect(v2.versionNo).toBe(2);
  });

  it("createSkillVersion contentHash 格式非法 → SkillValidationError", async () => {
    await expect(
      createSkillVersion({
        tenantId,
        skillId,
        contentRef: "git:bad-hash",
        contentHash: buildInvalidHash(),
        createdBy: ownerId,
      }),
    ).rejects.toThrow(SkillValidationError);
  });

  it("createSkillVersion contentHash 缺前缀 → SkillValidationError", async () => {
    await expect(
      createSkillVersion({
        tenantId,
        skillId,
        contentRef: "git:no-prefix",
        contentHash: "plain-hash",
        createdBy: ownerId,
      }),
    ).rejects.toThrow(SkillValidationError);
  });

  it("createSkillVersion contentRef 空 → SkillValidationError", async () => {
    await expect(
      createSkillVersion({
        tenantId,
        skillId,
        contentRef: "",
        contentHash: buildValidContentHash("x"),
        createdBy: ownerId,
      }),
    ).rejects.toThrow(SkillValidationError);
  });

  it("createSkillVersion createdBy 空 → SkillValidationError", async () => {
    await expect(
      createSkillVersion({
        tenantId,
        skillId,
        contentRef: "git:nocreator",
        contentHash: buildValidContentHash("x"),
        createdBy: "",
      }),
    ).rejects.toThrow(SkillValidationError);
  });

  it("createSkillVersion Skill 不存在 / 跨租户 → SkillNotFoundError", async () => {
    await expect(
      createSkillVersion({
        tenantId: "11111111-1111-4111-8111-111111111111",
        skillId,
        contentRef: "git:cross",
        contentHash: buildValidContentHash("x"),
        createdBy: ownerId,
      }),
    ).rejects.toThrow(SkillNotFoundError);
  });

  it("createSkillVersion Skill 已 retired → SkillLifecycleError", async () => {
    await updateSkill({ tenantId, skillId, lifecycleState: "retired", expectedVersionNo: 1 });
    await expect(
      createSkillVersion({
        tenantId,
        skillId,
        contentRef: "git:retired",
        contentHash: buildValidContentHash("x"),
        createdBy: ownerId,
      }),
    ).rejects.toThrow(SkillLifecycleError);
  });

  it("createSkillVersion 支持 sourceType + sourceRef", async () => {
    const version = await createSkillVersion({
      tenantId,
      skillId,
      contentRef: "market://skill/123",
      contentHash: buildValidContentHash("market-content"),
      sourceType: "capability_market",
      sourceRef: "market-skill-001",
      createdBy: ownerId,
    });
    expect(version.sourceType).toBe("capability_market");
    expect(version.sourceRef).toBe("market-skill-001");
  });
});

describe("V11 SkillVersion 仓储：getSkillVersionById / listSkillVersions / getCurrentSkillVersion", () => {
  let tenantId: string;
  let ownerId: string;
  let skillId: string;
  let versionId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithSkillBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const skill = await createSkill({
      tenantId,
      skillKey: "query-version-test",
      displayName: "Query Version Test",
      ownerUserId: ownerId,
      createdBy: ownerId,
    });
    skillId = skill.id;
    const version = await createSkillVersion({
      tenantId,
      skillId,
      contentRef: "git:v1",
      contentHash: buildValidContentHash("v1"),
      createdBy: ownerId,
    });
    versionId = version.id;
  });

  it("getSkillVersionById 命中 → 返回 SkillVersion", async () => {
    const found = await getSkillVersionById({ tenantId, skillVersionId: versionId });
    expect(found?.id).toBe(versionId);
    expect(found?.versionNo).toBe(1);
  });

  it("getSkillVersionById 跨租户 → 返回 null（join Skill 校验）", async () => {
    const found = await getSkillVersionById({
      tenantId: "11111111-1111-4111-8111-111111111111",
      skillVersionId: versionId,
    });
    expect(found).toBeNull();
  });

  it("getSkillVersionById 不存在 → 返回 null", async () => {
    const found = await getSkillVersionById({
      tenantId,
      skillVersionId: "99999999-9999-4999-8999-999999999999",
    });
    expect(found).toBeNull();
  });

  it("listSkillVersions 按 versionNo 降序返回", async () => {
    await createSkillVersion({
      tenantId,
      skillId,
      contentRef: "git:v2",
      contentHash: buildValidContentHash("v2"),
      createdBy: ownerId,
    });
    await createSkillVersion({
      tenantId,
      skillId,
      contentRef: "git:v3",
      contentHash: buildValidContentHash("v3"),
      createdBy: ownerId,
    });

    const list = await listSkillVersions({ tenantId, skillId });
    expect(list).toHaveLength(3);
    expect(list[0]?.versionNo).toBe(3);
    expect(list[1]?.versionNo).toBe(2);
    expect(list[2]?.versionNo).toBe(1);
  });

  it("listSkillVersions 按 revisionState=draft 过滤", async () => {
    await createSkillVersion({
      tenantId,
      skillId,
      contentRef: "git:v2",
      contentHash: buildValidContentHash("v2"),
      createdBy: ownerId,
    });
    const list = await listSkillVersions({
      tenantId,
      skillId,
      revisionStates: ["draft"],
    });
    expect(list).toHaveLength(2);
  });

  it("listSkillVersions Skill 不存在 → SkillNotFoundError", async () => {
    await expect(
      listSkillVersions({
        tenantId,
        skillId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toThrow(SkillNotFoundError);
  });

  it("getCurrentSkillVersion 未发布 → 返回 null", async () => {
    const current = await getCurrentSkillVersion({ tenantId, skillId });
    expect(current).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 6. publishSkillVersion 状态机 + currentVersionId 更新
// ═══════════════════════════════════════════════════════════

describe("V11 SkillVersion 仓储：publishSkillVersion", () => {
  let tenantId: string;
  let ownerId: string;
  let skillId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithSkillBindings();
    tenantId = seeded.tenantId;
    ownerId = seeded.userIdentityId;
    const skill = await createSkill({
      tenantId,
      skillKey: "publish-test",
      displayName: "Publish Test",
      ownerUserId: ownerId,
      createdBy: ownerId,
    });
    skillId = skill.id;
  });

  it("publishSkillVersion draft → published + currentVersionId 更新 + Skill versionNo 递增", async () => {
    const v1 = await createSkillVersion({
      tenantId,
      skillId,
      contentRef: "git:pub-v1",
      contentHash: buildValidContentHash("pub-v1"),
      createdBy: ownerId,
    });

    const { skill, version } = await publishSkillVersion({
      tenantId,
      skillVersionId: v1.id,
      publishedBy: ownerId,
    });

    expect(version.revisionState).toBe("published");
    expect(version.publishedAt).toEqual(expect.any(Date));
    expect(skill.currentVersionId).toBe(v1.id);
    expect(skill.versionNo).toBe(2); // Skill versionNo 由 1 → 2

    // getCurrentSkillVersion 应返回 v1
    const current = await getCurrentSkillVersion({ tenantId, skillId });
    expect(current?.id).toBe(v1.id);
    expect(current?.revisionState).toBe("published");
  });

  it("publishSkillVersion 二次发布：新版本 published + 旧版本 withdrawn + currentVersionId 切换", async () => {
    const v1 = await createSkillVersion({
      tenantId,
      skillId,
      contentRef: "git:pub-v1",
      contentHash: buildValidContentHash("pub-v1"),
      createdBy: ownerId,
    });
    await publishSkillVersion({
      tenantId,
      skillVersionId: v1.id,
      publishedBy: ownerId,
    });

    const v2 = await createSkillVersion({
      tenantId,
      skillId,
      contentRef: "git:pub-v2",
      contentHash: buildValidContentHash("pub-v2"),
      createdBy: ownerId,
    });
    const { skill, version } = await publishSkillVersion({
      tenantId,
      skillVersionId: v2.id,
      publishedBy: ownerId,
    });

    expect(version.revisionState).toBe("published");
    expect(skill.currentVersionId).toBe(v2.id);

    // v1 应该被自动 withdrawn
    const v1After = await getSkillVersionById({ tenantId, skillVersionId: v1.id });
    expect(v1After?.revisionState).toBe("withdrawn");
  });

  it("publishSkillVersion 重复发布同版本（已 published）→ SkillLifecycleError", async () => {
    const v1 = await createSkillVersion({
      tenantId,
      skillId,
      contentRef: "git:dup-pub",
      contentHash: buildValidContentHash("dup-pub"),
      createdBy: ownerId,
    });
    await publishSkillVersion({
      tenantId,
      skillVersionId: v1.id,
      publishedBy: ownerId,
    });

    await expect(
      publishSkillVersion({
        tenantId,
        skillVersionId: v1.id,
        publishedBy: ownerId,
      }),
    ).rejects.toThrow(SkillLifecycleError);
  });

  it("publishSkillVersion 不存在 / 跨租户 → SkillVersionNotFoundError", async () => {
    await expect(
      publishSkillVersion({
        tenantId: "11111111-1111-4111-8111-111111111111",
        skillVersionId: "99999999-9999-4999-8999-999999999999",
        publishedBy: ownerId,
      }),
    ).rejects.toThrow(SkillVersionNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. Admin API: POST /admin/api/v1/skills
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/skills", () => {
  let tenantId: string;
  let userIdentityId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithSkillBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
  });

  it("成功创建 → 201 + ETag(skill-1)", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/skills",
      idempotencyKey: "idem-create-skill-001",
      body: {
        skill_key: "api-skill-1",
        display_name: "API Skill 1",
        description: "via API",
        owner_user_id: userIdentityId,
        visibility_scope: "tenant",
        source_type: "local",
      },
    });

    const response = await createSkillPOST(request);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.skill_key).toBe("api-skill-1");
    expect(body.lifecycle_state).toBe("draft");
    expect(body.version_no).toBe(1);
    expect(body.etag).toBe("skill-1");
    const etag = response.headers.get("etag");
    expect(etag).toContain("skill-1");
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/skills",
      body: {
        skill_key: "api-no-idem",
        display_name: "X",
        owner_user_id: userIdentityId,
      },
    });

    const response = await createSkillPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("请求体非法（缺 owner_user_id）→ 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/skills",
      idempotencyKey: "idem-bad-body-001",
      body: {
        skill_key: "api-bad",
        display_name: "X",
      },
    });

    const response = await createSkillPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("skillKey 非法 → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/skills",
      idempotencyKey: "idem-bad-key-001",
      body: {
        skill_key: "Invalid_Key",
        display_name: "X",
        owner_user_id: userIdentityId,
      },
    });

    const response = await createSkillPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("幂等重放 → 200 (same response)", async () => {
    const body = {
      skill_key: "api-idempotent",
      display_name: "Idempotent",
      owner_user_id: userIdentityId,
    };
    const request1 = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/skills",
      idempotencyKey: "idem-replay-skill-001",
      body,
    });
    const response1 = await createSkillPOST(request1);
    expect(response1.status).toBe(201);
    const body1 = (await response1.json()) as Record<string, unknown>;

    const request2 = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/skills",
      idempotencyKey: "idem-replay-skill-001",
      body,
    });
    const response2 = await createSkillPOST(request2);
    // 幂等重放返回与首次相同 status（completeRecord 存的 httpStatus）
    expect(response2.status).toBe(201);
    const body2 = (await response2.json()) as Record<string, unknown>;
    expect(body2.id).toBe(body1.id);
    expect(body2.skill_key).toBe(body1.skill_key);
  });
});

// ═══════════════════════════════════════════════════════════
// 8. Admin API: GET /admin/api/v1/skills
// ═══════════════════════════════════════════════════════════

describe("GET /admin/api/v1/skills", () => {
  let tenantId: string;
  let userIdentityId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithSkillBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
    await createSkill({
      tenantId,
      skillKey: "list-api-a",
      displayName: "A",
      ownerUserId: userIdentityId,
      createdBy: userIdentityId,
    });
    await createSkill({
      tenantId,
      skillKey: "list-api-b",
      displayName: "B",
      ownerUserId: userIdentityId,
      createdBy: userIdentityId,
    });
  });

  it("成功列出 → 200 + items 数组", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: "/skills",
    });

    const response = await listSkillsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; next_cursor: string | null };
    expect(body.items).toHaveLength(2);
    expect(body.next_cursor).toBeNull();
  });

  it("lifecycle_state 过滤 → 仅返回匹配的 Skill", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: "/skills?lifecycle_state=enabled",
    });

    const response = await listSkillsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ lifecycle_state: string }> };
    expect(body.items).toHaveLength(0);
  });

  it("limit=1 → 1 条 + next_cursor 非空", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: "/skills?limit=1",
    });

    const response = await listSkillsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; next_cursor: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.next_cursor).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 9. Admin API: GET / PATCH /admin/api/v1/skills/{skill_id}
// ═══════════════════════════════════════════════════════════

describe("GET / PATCH /admin/api/v1/skills/{skill_id}", () => {
  let tenantId: string;
  let userIdentityId: string;
  let skillId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithSkillBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
    const skill = await createSkill({
      tenantId,
      skillKey: "single-api",
      displayName: "Single",
      ownerUserId: userIdentityId,
      createdBy: userIdentityId,
    });
    skillId = skill.id;
  });

  it("GET 成功 → 200 + current_version=null（未发布）+ ETag", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: `/skills/${skillId}`,
    });

    const response = await getSkillGET(request, {
      params: Promise.resolve({ skill_id: skillId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe(skillId);
    expect(body.current_version).toBeNull();
    expect(body.etag).toBe("skill-1");
    const etag = response.headers.get("etag");
    expect(etag).toContain("skill-1");
  });

  it("GET 跨租户 → 404 RESOURCE_NOT_FOUND", async () => {
    // 当前 SNOW_AUTH_MODE=dev 使用 DEFAULT_USER_ID，所属 tenantId 与本测试 tenantId 一致；
    // 我们直接构造一个不存在的 skillId 验证 404 路径。
    const randomSkillId = "99999999-9999-4999-8999-999999999999";
    const requestId = "req-get-not-found";
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: `/skills/${randomSkillId}`,
      requestId,
    });

    const response = await getSkillGET(request, {
      params: Promise.resolve({ skill_id: randomSkillId }),
    });
    await assertCrossTenantHidden(response, requestId);
  });

  it("PATCH 成功 → 200 + ETag(skill-2)", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/skills/${skillId}`,
      idempotencyKey: "idem-patch-skill-001",
      ifMatch: "skill-1",
      body: {
        display_name: "Patched",
        description: "patched desc",
      },
    });

    const response = await patchSkillPATCH(request, {
      params: Promise.resolve({ skill_id: skillId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.display_name).toBe("Patched");
    expect(body.description).toBe("patched desc");
    expect(body.version_no).toBe(2);
    expect(body.etag).toBe("skill-2");
  });

  it("PATCH 缺少 If-Match → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/skills/${skillId}`,
      idempotencyKey: "idem-patch-no-ifmatch-001",
      body: { display_name: "X" },
    });

    const response = await patchSkillPATCH(request, {
      params: Promise.resolve({ skill_id: skillId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("PATCH 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/skills/${skillId}`,
      ifMatch: "skill-1",
      body: { display_name: "X" },
    });

    const response = await patchSkillPATCH(request, {
      params: Promise.resolve({ skill_id: skillId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("PATCH ETag 不匹配 → 412 ETAG_MISMATCH", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/skills/${skillId}`,
      idempotencyKey: "idem-patch-etag-mismatch-001",
      ifMatch: "skill-999",
      body: { display_name: "X" },
    });

    const response = await patchSkillPATCH(request, {
      params: Promise.resolve({ skill_id: skillId }),
    });
    expect(response.status).toBe(412);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ETAG_MISMATCH");
  });

  it("PATCH lifecycle draft → retired 合法 → 422 不触发", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/skills/${skillId}`,
      idempotencyKey: "idem-patch-retire-001",
      ifMatch: "skill-1",
      body: { lifecycle_state: "retired" },
    });

    const response = await patchSkillPATCH(request, {
      params: Promise.resolve({ skill_id: skillId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.lifecycle_state).toBe("retired");
  });

  it("PATCH lifecycle retired → enabled 终态 → 422 BUSINESS_CONSTRAINT_VIOLATION", async () => {
    // 先 retire
    const retireReq = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/skills/${skillId}`,
      idempotencyKey: "idem-patch-retire-step1-001",
      ifMatch: "skill-1",
      body: { lifecycle_state: "retired" },
    });
    await patchSkillPATCH(retireReq, {
      params: Promise.resolve({ skill_id: skillId }),
    });

    // 再尝试 enable（终态不可恢复）
    const enableReq = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/skills/${skillId}`,
      idempotencyKey: "idem-patch-retire-step2-001",
      ifMatch: "skill-2",
      body: { lifecycle_state: "enabled" },
    });

    const response = await patchSkillPATCH(enableReq, {
      params: Promise.resolve({ skill_id: skillId }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUSINESS_CONSTRAINT_VIOLATION");
  });

  it("PATCH 请求体非法（display_name 空字符串）→ 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PATCH",
      path: `/skills/${skillId}`,
      idempotencyKey: "idem-patch-bad-body-001",
      ifMatch: "skill-1",
      body: { display_name: "" },
    });

    const response = await patchSkillPATCH(request, {
      params: Promise.resolve({ skill_id: skillId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });
});

// ═══════════════════════════════════════════════════════════
// 10. Admin API: POST /admin/api/v1/skills/{skill_id}/versions
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/skills/{skill_id}/versions", () => {
  let tenantId: string;
  let userIdentityId: string;
  let skillId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithSkillBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
    const skill = await createSkill({
      tenantId,
      skillKey: "version-api-test",
      displayName: "Version API Test",
      ownerUserId: userIdentityId,
      createdBy: userIdentityId,
    });
    skillId = skill.id;
  });

  it("成功创建 SkillVersion → 201 + version_no=1 + revision_state=draft", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/skills/${skillId}/versions`,
      idempotencyKey: "idem-create-version-001",
      body: {
        content_ref: "git:api-v1",
        content_hash: buildValidContentHash("api-v1-content"),
        manifest: { name: "v1", tools: ["search"] },
        source_type: "local",
      },
    });

    const response = await createVersionPOST(request, {
      params: Promise.resolve({ skill_id: skillId }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.version_no).toBe(1);
    expect(body.revision_state).toBe("draft");
    expect(body.content_ref).toBe("git:api-v1");
    expect(body.skill_id).toBe(skillId);
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/skills/${skillId}/versions`,
      body: {
        content_ref: "git:no-idem",
        content_hash: buildValidContentHash("no-idem"),
      },
    });

    const response = await createVersionPOST(request, {
      params: Promise.resolve({ skill_id: skillId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("content_hash 格式非法 → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/skills/${skillId}/versions`,
      idempotencyKey: "idem-bad-hash-001",
      body: {
        content_ref: "git:bad-hash",
        content_hash: buildInvalidHash(),
      },
    });

    const response = await createVersionPOST(request, {
      params: Promise.resolve({ skill_id: skillId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("Skill 跨租户（不存在） → 404 RESOURCE_NOT_FOUND", async () => {
    const randomSkillId = "99999999-9999-4999-8999-999999999999";
    const requestId = "req-version-cross-tenant";
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/skills/${randomSkillId}/versions`,
      idempotencyKey: "idem-version-cross-tenant-001",
      requestId,
      body: {
        content_ref: "git:cross",
        content_hash: buildValidContentHash("cross"),
      },
    });

    const response = await createVersionPOST(request, {
      params: Promise.resolve({ skill_id: randomSkillId }),
    });
    await assertCrossTenantHidden(response, requestId);
  });

  it("幂等重放 → 返回相同 version", async () => {
    const body = {
      content_ref: "git:idempotent-version",
      content_hash: buildValidContentHash("idempotent-version"),
    };
    const request1 = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/skills/${skillId}/versions`,
      idempotencyKey: "idem-version-replay-001",
      body,
    });
    const response1 = await createVersionPOST(request1, {
      params: Promise.resolve({ skill_id: skillId }),
    });
    expect(response1.status).toBe(201);
    const body1 = (await response1.json()) as Record<string, unknown>;

    const request2 = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/skills/${skillId}/versions`,
      idempotencyKey: "idem-version-replay-001",
      body,
    });
    const response2 = await createVersionPOST(request2, {
      params: Promise.resolve({ skill_id: skillId }),
    });
    expect(response2.status).toBe(201);
    const body2 = (await response2.json()) as Record<string, unknown>;
    expect(body2.id).toBe(body1.id);
  });
});

// ═══════════════════════════════════════════════════════════
// 11. Admin API: 缺少 action scope → 403 ACTION_SCOPE_DENIED
// ═══════════════════════════════════════════════════════════

describe("Admin API 权限守卫：缺少 action scope → 403", () => {
  let tenantId: string;
  let userIdentityId: string;

  beforeEach(async () => {
    // 仅 seed tenant + user，不绑定任何 skill action
    const tenant = await ensureDefaultTenant();
    tenantId = tenant.id;
    const identity = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: DEFAULT_USER_ID,
      email: DEFAULT_USER_EMAIL,
      displayName: DEFAULT_USER_NAME,
    });
    await upsertPrincipalBinding({
      tenantId: tenant.id,
      subjectType: "user",
      externalId: DEFAULT_USER_ID,
      displayName: DEFAULT_USER_NAME,
      userIdentityId: identity.id,
    });
    userIdentityId = identity.id;
  });

  it("POST /skills 缺 skill.create 绑定 → 403 ACTION_SCOPE_DENIED", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/skills",
      idempotencyKey: "idem-no-scope-001",
      body: {
        skill_key: "no-scope",
        display_name: "X",
        owner_user_id: userIdentityId,
      },
    });

    const response = await createSkillPOST(request);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ACTION_SCOPE_DENIED");
  });

  it("GET /skills 缺 skill.create 绑定 → 403 ACTION_SCOPE_DENIED", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: "/skills",
    });

    const response = await listSkillsGET(request);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ACTION_SCOPE_DENIED");
  });
});
