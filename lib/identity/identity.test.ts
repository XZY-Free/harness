import { POST as authOperationPost } from "@/app/api/auth/[...operation]/route";
/**
 * S02-C01：身份模块集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - tenant-queries：默认租户 seed 幂等、按 key/id 查找。
 * - user-identity-queries：upsert 创建/复用/漂移更新、按 id/subject/跨租户查找。
 * - principal-binding-queries：upsert 创建/复用/漂移更新、按用户列出、按主体查找。
 * - resolver：dev/trusted-headers 双模式、缺身份/缺邮箱报错、authErrorResponse 401 映射。
 */
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { EnterpriseProfileAcceptanceError } from "@/lib/identity/accept-enterprise-profile-observation";
import type { UserAuthenticationProvider } from "@/lib/identity/authentication-provider";
import type {
  EnterpriseProfileObservation,
  EnterpriseProfileSource,
} from "@/lib/identity/enterprise-profile-source";
import {
  attributesFromRows,
  getEnterpriseUserProfileFacts,
} from "@/lib/identity/enterprise-user-profile-queries";
import {
  getPrincipalBinding,
  listPrincipalBindingsByUser,
  upsertPrincipalBinding,
} from "@/lib/identity/principal-binding-queries";
import {
  AuthenticationError,
  authErrorResponse,
  getCurrentPrincipal,
  resolvePrincipal,
} from "@/lib/identity/resolver";
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_KEY,
  ensureDefaultTenant,
  getTenantById,
  getTenantByKey,
} from "@/lib/identity/tenant-queries";
import {
  getUserIdentityById,
  getUserIdentityBySubject,
  getUserIdentityForTenant,
  upsertUserIdentity,
} from "@/lib/identity/user-identity-queries";
import { userIdentity } from "@/lib/persistence/schema/identity";
import { eq } from "drizzle-orm";
import mysql from "mysql2/promise";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 生产发行版把企业资料源注入组合根（profileSource），开放版默认不启用。
// 测试只需替换组合根的返回，让 resolvePrincipal 走真实的"认证证据 → 资料观察 → 接纳"链路，
// 而不是 mock 认证提供器、仓库、接纳服务或数据库。认证提供器仍由用例注入。
// F02：普通 resolvePrincipal 在认证证据不携带企业资料观察时，不得隐式触发 profileSource.observe。
// 用模块级共享状态计数 observe 调用，并在每个用例开始前归零，供断言 observeCount === 0。
const profileSourceState = vi.hoisted(() => {
  const state = {
    observeCount: 0,
    authenticationProviderOverride: null as UserAuthenticationProvider | null,
    resetObserveCount() {
      state.observeCount = 0;
    },
  };
  return state;
});

vi.mock("@/lib/identity/identity-extension-bootstrap", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/identity/identity-extension-bootstrap")>();
  const { openSourceAuthenticationProvider } = await import(
    "@/lib/identity/authentication-provider"
  );
  return {
    ...actual,
    getIdentityExtensions: vi.fn(async () => ({
      authenticationProvider:
        profileSourceState.authenticationProviderOverride ?? openSourceAuthenticationProvider,
      profileSource: {
        sourceSystem: "directory",
        trusted: true,
        maxFreshAgeMs: 60 * 60_000,
        maxStaleAgeMs: 2 * 60 * 60_000,
        // F02：注入一个受信且具备 observe 能力的真实 source，用于证明当前实现会在
        // "证据无观察"时误调用目录；返回 unavailable 以保持 principal 可用。
        observe: async () => {
          profileSourceState.observeCount += 1;
          return { status: "unavailable" as const };
        },
      } satisfies EnterpriseProfileSource,
    })),
  };
});

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

function setAuthMode(mode: string | undefined) {
  process.env.SNOW_AUTH_MODE = mode;
}

beforeEach(async () => {
  await resetDatabase(db);
  setAuthMode("dev");
  profileSourceState.resetObserveCount();
  profileSourceState.authenticationProviderOverride = null;
});

afterEach(() => {
  setAuthMode(ORIGINAL_AUTH_MODE);
});

// ─── tenant-queries ──────────────────────────────────────────

describe("tenant-queries", () => {
  it("ensureDefaultTenant 首次调用创建默认租户", async () => {
    const tenant = await ensureDefaultTenant();
    expect(tenant.id).toBe(DEFAULT_TENANT_ID);
    expect(tenant.key).toBe(DEFAULT_TENANT_KEY);
    expect(tenant.status).toBe("active");
  });

  it("ensureDefaultTenant 二次调用幂等返回同一行", async () => {
    const first = await ensureDefaultTenant();
    const second = await ensureDefaultTenant();
    expect(second.id).toBe(first.id);
    expect(second.key).toBe(first.key);
  });

  it("getTenantByKey 返回 active 租户", async () => {
    await ensureDefaultTenant();
    const tenant = await getTenantByKey(DEFAULT_TENANT_KEY);
    expect(tenant).not.toBeNull();
    expect(tenant?.id).toBe(DEFAULT_TENANT_ID);
  });

  it("getTenantByKey 未知 key 返回 null", async () => {
    const tenant = await getTenantByKey("nonexistent");
    expect(tenant).toBeNull();
  });

  it("getTenantById 返回租户", async () => {
    await ensureDefaultTenant();
    const tenant = await getTenantById(DEFAULT_TENANT_ID);
    expect(tenant).not.toBeNull();
    expect(tenant?.key).toBe(DEFAULT_TENANT_KEY);
  });

  it("getTenantById 未知 id 返回 null", async () => {
    const tenant = await getTenantById("00000000-0000-0000-0000-000000000000");
    expect(tenant).toBeNull();
  });
});

// ─── user-identity-queries ───────────────────────────────────

describe("user-identity-queries", () => {
  it("upsertUserIdentity 首次创建新身份", async () => {
    const tenant = await ensureDefaultTenant();
    const identity = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-001",
      email: "alice@example.com",
      displayName: "Alice",
    });
    expect(identity.id).toBeTruthy();
    expect(identity.externalSubject).toBe("emp-001");
    expect(identity.email).toBe("alice@example.com");
    expect(identity.status).toBe("active");
  });

  it("upsertUserIdentity 同 subject 二次调用复用同一 id", async () => {
    const tenant = await ensureDefaultTenant();
    const first = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-001",
      email: "alice@example.com",
      displayName: "Alice",
    });
    const second = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-001",
      email: "alice@example.com",
      displayName: "Alice",
    });
    expect(second.id).toBe(first.id);
  });

  it("upsertUserIdentity email/displayName 漂移时更新", async () => {
    const tenant = await ensureDefaultTenant();
    await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-001",
      email: "alice@example.com",
      displayName: "Alice",
    });
    const updated = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-001",
      email: "alice.new@example.com",
      displayName: "Alice Smith",
    });
    expect(updated.email).toBe("alice.new@example.com");
    expect(updated.displayName).toBe("Alice Smith");
  });

  it("getUserIdentityById 返回身份", async () => {
    const tenant = await ensureDefaultTenant();
    const created = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-001",
      email: "alice@example.com",
      displayName: "Alice",
    });
    const found = await getUserIdentityById(created.id);
    expect(found).not.toBeNull();
    expect(found?.externalSubject).toBe("emp-001");
  });

  it("getUserIdentityById 未知 id 返回 null", async () => {
    const found = await getUserIdentityById("00000000-0000-0000-0000-000000000000");
    expect(found).toBeNull();
  });

  it("getUserIdentityBySubject 按 (tenantId, subject) 查找", async () => {
    const tenant = await ensureDefaultTenant();
    await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-001",
      email: "alice@example.com",
      displayName: "Alice",
    });
    const found = await getUserIdentityBySubject(tenant.id, "emp-001");
    expect(found).not.toBeNull();
    expect(found?.email).toBe("alice@example.com");
  });

  it("getUserIdentityForTenant 跨租户返回 null（隐藏式）", async () => {
    const tenant = await ensureDefaultTenant();
    const created = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-001",
      email: "alice@example.com",
      displayName: "Alice",
    });
    // 用错误的 tenantId 查找 → 返回 null（跨租户隐藏存在性）。
    const otherTenantId = "11111111-1111-4111-8111-111111111111";
    const found = await getUserIdentityForTenant(created.id, otherTenantId);
    expect(found).toBeNull();
  });

  it("getUserIdentityForTenant 同租户返回身份", async () => {
    const tenant = await ensureDefaultTenant();
    const created = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-001",
      email: "alice@example.com",
      displayName: "Alice",
    });
    const found = await getUserIdentityForTenant(created.id, tenant.id);
    expect(found).not.toBeNull();
    expect(found?.externalSubject).toBe("emp-001");
  });

  it("F04 普通展示更新携带旧 status=active 时，不得把 B 刚提交的 disabled 恢复为 active", async () => {
    const tenant = await ensureDefaultTenant();

    // A（普通认证/展示更新）先创建目标身份，并读取到旧 status=active。
    const target = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-001",
      email: "alice@example.com",
      displayName: "Alice",
    });
    expect(target.status).toBe("active");

    // A 在暂停前的一段"读取"，保留旧 active 作为后续运行时输入。
    const existingIdentity = await getUserIdentityBySubject(tenant.id, "emp-001");
    expect(existingIdentity?.status).toBe("active");

    // 对照组 1：同租户另一 subject；必须在目标行更新后保持原样。
    const sibling = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-sibling",
      email: "sibling@example.com",
      displayName: "Sibling",
    });

    // 用独立 mysql2 连接充当"已授权的停用写入者 B"：先建第二个租户与跨租户同一 subject
    // 的对照行，再单独把目标身份提交为 disabled。
    const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
    const CROSS_TENANT_ID = "33333333-3333-4333-8333-333333333333";
    const connB = await mysql.createConnection(process.env.DATABASE_URL!);
    try {
      await connB.execute(
        "INSERT INTO `Tenant` (`id`, `key`, `name`, `createdAt`, `updatedAt`) VALUES (?, ?, ?, NOW(3), NOW(3))",
        [OTHER_TENANT_ID, "other-tenant", "Other Tenant"],
      );
      await connB.execute(
        "INSERT INTO `UserIdentity` (`id`, `tenantId`, `externalSubject`, `email`, `displayName`, `status`, `createdAt`, `updatedAt`) VALUES (?, ?, ?, ?, ?, 'active', NOW(3), NOW(3))",
        [CROSS_TENANT_ID, OTHER_TENANT_ID, "emp-001", "cross@example.com", "Cross Tenant"],
      );
      // B 在独立连接上把目标身份提交为 disabled（代表已经过授权的外部停用写入）。
      const [bResult] = await connB.execute(
        "UPDATE `UserIdentity` SET `status` = 'disabled' WHERE `id` = ?",
        [target.id],
      );
      expect((bResult as { affectedRows: number }).affectedRows).toBe(1);
    } finally {
      await connB.end();
    }

    // A 在读到旧 active 后完成"展示字段漂移"更新；它把旧 status 作为运行时输入带回。
    // 通过变量承载，未来 API 移除 status 后仍是"运行时多余属性"而非编译期多余属性错误，
    // 从而让本测试保持为行为失败而不是编译失败。
    const staleRuntimeInput = {
      tenantId: tenant.id,
      externalSubject: existingIdentity!.externalSubject,
      email: "alice.new@example.com",
      displayName: "Alice Smith",
      status: existingIdentity!.status, // 旧 active，但普通展示更新不应拥有 status 写权限。
    };
    const updated = await upsertUserIdentity(staleRuntimeInput);

    // ── 期望：只有 email/displayName 漂移；status 必须保持 B 写入的 disabled ──
    expect(updated.status).toBe("disabled");
    expect(updated.email).toBe("alice.new@example.com");
    expect(updated.displayName).toBe("Alice Smith");

    const after = await getUserIdentityById(target.id);
    expect(after?.status).toBe("disabled");
    expect(after?.email).toBe("alice.new@example.com");
    expect(after?.displayName).toBe("Alice Smith");

    // 跨主体 / 跨租户行不受影响：update 只落在精确的 (tenant, subject) 行。
    const siblingAfter = await getUserIdentityById(sibling.id);
    expect(siblingAfter?.status).toBe("active");
    expect(siblingAfter?.displayName).toBe("Sibling");
    const crossAfter = await getUserIdentityById(CROSS_TENANT_ID);
    expect(crossAfter?.status).toBe("active");
    expect(crossAfter?.email).toBe("cross@example.com");
  });
});

// ─── principal-binding-queries ───────────────────────────────

describe("principal-binding-queries", () => {
  it("upsertPrincipalBinding 首次创建 user 类型绑定", async () => {
    const tenant = await ensureDefaultTenant();
    const identity = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-001",
      email: "alice@example.com",
      displayName: "Alice",
    });
    const binding = await upsertPrincipalBinding({
      tenantId: tenant.id,
      subjectType: "user",
      externalId: "emp-001",
      displayName: "Alice",
      userIdentityId: identity.id,
    });
    expect(binding.id).toBeTruthy();
    expect(binding.subjectType).toBe("user");
    expect(binding.externalId).toBe("emp-001");
    expect(binding.userIdentityId).toBe(identity.id);
  });

  it("upsertPrincipalBinding 同 (type, externalId) 二次调用复用", async () => {
    const tenant = await ensureDefaultTenant();
    const first = await upsertPrincipalBinding({
      tenantId: tenant.id,
      subjectType: "group",
      externalId: "group-eng",
      displayName: "Engineering",
    });
    const second = await upsertPrincipalBinding({
      tenantId: tenant.id,
      subjectType: "group",
      externalId: "group-eng",
      displayName: "Engineering",
    });
    expect(second.id).toBe(first.id);
  });

  it("upsertPrincipalBinding displayName 漂移时更新", async () => {
    const tenant = await ensureDefaultTenant();
    await upsertPrincipalBinding({
      tenantId: tenant.id,
      subjectType: "role",
      externalId: "role-admin",
      displayName: "Admin",
    });
    const updated = await upsertPrincipalBinding({
      tenantId: tenant.id,
      subjectType: "role",
      externalId: "role-admin",
      displayName: "Administrator",
    });
    expect(updated.displayName).toBe("Administrator");
  });

  it("upsertPrincipalBinding 支持 group/role/department 类型", async () => {
    const tenant = await ensureDefaultTenant();
    for (const subjectType of ["group", "role", "department"] as const) {
      const binding = await upsertPrincipalBinding({
        tenantId: tenant.id,
        subjectType,
        externalId: `ext-${subjectType}`,
        displayName: subjectType,
      });
      expect(binding.subjectType).toBe(subjectType);
    }
  });

  it("listPrincipalBindingsByUser 列出 userIdentity 的所有绑定", async () => {
    const tenant = await ensureDefaultTenant();
    const identity = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "emp-001",
      email: "alice@example.com",
      displayName: "Alice",
    });
    // user 绑定
    await upsertPrincipalBinding({
      tenantId: tenant.id,
      subjectType: "user",
      externalId: "emp-001",
      displayName: "Alice",
      userIdentityId: identity.id,
    });
    // group 绑定
    await upsertPrincipalBinding({
      tenantId: tenant.id,
      subjectType: "group",
      externalId: "group-eng",
      displayName: "Engineering",
      userIdentityId: identity.id,
    });

    const list = await listPrincipalBindingsByUser(tenant.id, identity.id);
    expect(list).toHaveLength(2);
    expect(list.map((b) => b.subjectType).sort()).toEqual(["group", "user"]);
  });

  it("getPrincipalBinding 按 (tenantId, type, externalId) 查找", async () => {
    const tenant = await ensureDefaultTenant();
    await upsertPrincipalBinding({
      tenantId: tenant.id,
      subjectType: "user",
      externalId: "emp-001",
      displayName: "Alice",
    });
    const found = await getPrincipalBinding(tenant.id, "user", "emp-001");
    expect(found).not.toBeNull();
    expect(found?.displayName).toBe("Alice");
  });

  it("getPrincipalBinding 未知组合返回 null", async () => {
    const tenant = await ensureDefaultTenant();
    const found = await getPrincipalBinding(tenant.id, "user", "nonexistent");
    expect(found).toBeNull();
  });
});

// ─── resolver ────────────────────────────────────────────────

describe("resolver", () => {
  it("dev 模式返回默认身份并创建租户/身份/绑定", async () => {
    setAuthMode("dev");
    const principal = await resolvePrincipal(new Headers(), "employee");

    expect(principal.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(principal.tenantKey).toBe(DEFAULT_TENANT_KEY);
    expect(principal.externalSubject).toBe(DEFAULT_USER_ID);
    expect(principal.email).toBe(DEFAULT_USER_EMAIL);
    expect(principal.displayName).toBe(DEFAULT_USER_NAME);
    expect(principal.audience).toBe("employee");
    expect(principal.userIdentityId).toBeTruthy();

    // 验证身份已落库。
    const identity = await getUserIdentityById(principal.userIdentityId);
    expect(identity).not.toBeNull();
    expect(identity?.externalSubject).toBe(DEFAULT_USER_ID);

    // 验证绑定已落库。
    const binding = await getPrincipalBinding(principal.tenantId, "user", DEFAULT_USER_ID);
    expect(binding).not.toBeNull();
    expect(binding?.userIdentityId).toBe(principal.userIdentityId);
  });

  it("dev 模式二次调用复用同一 userIdentityId", async () => {
    setAuthMode("dev");
    const first = await resolvePrincipal(new Headers());
    const second = await resolvePrincipal(new Headers());
    expect(second.userIdentityId).toBe(first.userIdentityId);
    expect(second.tenantId).toBe(first.tenantId);
  });

  it("企业适配器不可用时不得用原始 SSO 覆盖已停用身份，且 employee Principal 必须拒绝", async () => {
    setAuthMode("trusted-headers");
    const tenant = await ensureDefaultTenant();
    // 测试仅用状态做 setup：普通创建后，用测试专用的 DB 状态更新把身份标记为 disabled。
    // （普通创建路径不拥有 status 写权限。）
    const disabled = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "employee-disabled-1",
      email: "directory-record@example.test",
      displayName: "目录中的停用用户",
    });
    await db
      .update(userIdentity)
      .set({ status: "disabled" })
      .where(eq(userIdentity.id, disabled.id));
    const headers = new Headers({
      "x-snow-user-id": "employee-disabled-1",
      "x-snow-user-email": "untrusted-sso@example.test",
      "x-snow-user-name": "Untrusted SSO name",
    });

    await expect(resolvePrincipal(headers, "employee")).rejects.toMatchObject({
      code: "user_disabled",
    });

    const after = await getUserIdentityById(disabled.id);
    expect(after).toMatchObject({
      status: "disabled",
      email: "directory-record@example.test",
      displayName: "目录中的停用用户",
    });
  });

  it("认证主体 A 携带的观察指向同租户已有主体 B 时，必须在写入任何企业资料前拒绝", async () => {
    const tenant = await ensureDefaultTenant();
    // 预置同租户已有主体 B：现有错误实现按 observation.externalSubject 命中并覆盖写入 B，
    // 因此必须让 B 事先存在，才能暴露"错误主体资料污染企业用户"这一缺陷。
    const identityB = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "employee-b",
      email: "bob@example.test",
      displayName: "Bob",
    });

    const observation: EnterpriseProfileObservation = {
      tenantId: tenant.id,
      externalSubject: identityB.externalSubject,
      sourceSystem: "directory",
      attributes: { employeeNo: "E-1", departmentCode: "D-1" },
      verifiedAt: new Date("2026-09-01T00:00:00.000Z"),
      freshUntil: new Date("2026-09-01T00:30:00.000Z"),
      staleUntil: new Date("2026-09-01T01:30:00.000Z"),
    };

    const provider: UserAuthenticationProvider = {
      name: "controlled-a",
      async authenticate() {
        return {
          status: "authenticated",
          evidence: {
            externalSubject: "employee-a",
            email: "alice@example.test",
            displayName: "Alice",
            trustedAuthenticationClaims: {},
            enterpriseProfileObservation: observation,
          },
        };
      },
    };

    // resolvePrincipal 必须先拒绝，而不是把 B 当作观察对象接纳。
    const resolvePromise = resolvePrincipal(new Headers(), "employee", {
      authenticationProvider: provider,
    });
    await expect(resolvePromise).rejects.toBeInstanceOf(EnterpriseProfileAcceptanceError);
    await expect(resolvePromise).rejects.toMatchObject({ code: "subject_mismatch" });

    // 拒绝后，A、B 的企业事实都不变，B 没有被注入任何观察值。
    const identityA = await getUserIdentityBySubject(tenant.id, "employee-a");
    const factsA = identityA ? await getEnterpriseUserProfileFacts(tenant.id, identityA.id) : null;
    const factsB = await getEnterpriseUserProfileFacts(tenant.id, identityB.id);
    expect(factsA?.attributes ?? []).toEqual([]);
    expect(factsA?.syncState).toBeNull();
    expect(factsB?.attributes ?? []).toEqual([]);
    expect(factsB?.syncState).toBeNull();

    // B 的标准身份字段保持不变（未被观察改写）。
    const afterB = await getUserIdentityById(identityB.id);
    expect(afterB).toMatchObject({
      externalSubject: "employee-b",
      email: "bob@example.test",
      displayName: "Bob",
    });
  });

  it("F02 普通 resolvePrincipal 无企业资料观察时不得隐式调用 profileSource.observe", async () => {
    // 受控认证提供器：authenticate 计数证明普通认证仍运行，其证据不带 enterpriseProfileObservation。
    const authenticateCount = { value: 0 };
    const provider: UserAuthenticationProvider = {
      name: "controlled-no-observation",
      async authenticate() {
        authenticateCount.value += 1;
        return {
          status: "authenticated",
          evidence: {
            externalSubject: "employee-f02",
            email: "f02@example.test",
            displayName: "F02 User",
            trustedAuthenticationClaims: {},
          },
        };
      },
    };

    // 普通 session/API 创建路径两次；认证证据均不含企业资料观察。
    const principal1 = await resolvePrincipal(new Headers(), "employee", {
      authenticationProvider: provider,
    });
    const principal2 = await resolvePrincipal(new Headers(), "employee", {
      authenticationProvider: provider,
    });

    // 认证计数与调用次数一致：普通认证仍完整运行（而非被旁路）。
    expect(authenticateCount.value).toBe(2);
    // 关键断言：证据无观察时不得隐式触发资料源 observe（目录调用）。
    expect(profileSourceState.observeCount).toBe(0);

    // Principal 仍有效：稳定身份、租户正确、资料状态 unavailable（未伪造任何企业事实）。
    expect(principal1.externalSubject).toBe("employee-f02");
    expect(principal1.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(principal1.profileStatus).toBe("unavailable");
    expect(principal2.userIdentityId).toBe(principal1.userIdentityId);

    // 无任何被写入/伪造的企业资料事实。
    const facts = await getEnterpriseUserProfileFacts(
      principal1.tenantId,
      principal1.userIdentityId,
    );
    expect(facts?.attributes ?? []).toEqual([]);
    expect(facts?.syncState).toBeNull();
  });

  it("F01 callback 成功后必须等待统一 Core 接纳，已停用身份不得返回成功", async () => {
    const tenant = await ensureDefaultTenant();
    const disabled = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "callback-disabled",
      email: "directory-record@example.test",
      displayName: "Disabled User",
    });
    await db
      .update(userIdentity)
      .set({ status: "disabled" })
      .where(eq(userIdentity.id, disabled.id));

    const calls = { authenticate: 0, callback: 0 };
    profileSourceState.authenticationProviderOverride = {
      name: "callback-core-rejection",
      async authenticate() {
        calls.authenticate += 1;
        return { status: "unauthenticated" };
      },
      async callback() {
        calls.callback += 1;
        return {
          status: "authenticated",
          evidence: {
            externalSubject: "callback-disabled",
            email: "untrusted-callback@example.test",
            displayName: "Untrusted Callback",
            trustedAuthenticationClaims: {},
          },
        };
      },
    };

    const response = await authOperationPost(
      new NextRequest("http://localhost/api/auth/callback", {
        method: "POST",
        headers: { "x-request-id": "req_f01_disabled" },
      }),
      { params: Promise.resolve({ operation: ["callback"] }) },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED", request_id: "req_f01_disabled" },
    });
    expect(calls).toEqual({ authenticate: 0, callback: 1 });
    expect(await getPrincipalBinding(tenant.id, "user", "callback-disabled")).toBeNull();
    expect(await getUserIdentityById(disabled.id)).toMatchObject({
      status: "disabled",
      email: "directory-record@example.test",
      displayName: "Disabled User",
    });
  });

  it("F01 callback 的认证证据直接进入统一身份与企业资料接纳，不得二次认证", async () => {
    const now = Date.now();
    const calls = { authenticate: 0, callback: 0 };
    profileSourceState.authenticationProviderOverride = {
      name: "callback-core-success",
      async authenticate() {
        calls.authenticate += 1;
        return { status: "unauthenticated" };
      },
      async callback() {
        calls.callback += 1;
        return {
          status: "authenticated",
          evidence: {
            externalSubject: "callback-accepted",
            email: "callback-accepted@example.test",
            displayName: "Accepted User",
            trustedAuthenticationClaims: {},
            enterpriseProfileObservation: {
              tenantId: DEFAULT_TENANT_ID,
              externalSubject: "callback-accepted",
              sourceSystem: "directory",
              attributes: { employeeNo: "E-F01", departmentCode: "D-F01" },
              verifiedAt: new Date(now - 1_000),
              freshUntil: new Date(now + 30 * 60_000),
              staleUntil: new Date(now + 90 * 60_000),
            },
          },
        };
      },
    };

    const response = await authOperationPost(
      new NextRequest("http://localhost/api/auth/callback", { method: "POST" }),
      { params: Promise.resolve({ operation: ["callback"] }) },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual({ authenticate: 0, callback: 1 });
    const identity = await getUserIdentityBySubject(DEFAULT_TENANT_ID, "callback-accepted");
    expect(identity).not.toBeNull();
    expect(await getPrincipalBinding(DEFAULT_TENANT_ID, "user", "callback-accepted")).toMatchObject(
      {
        userIdentityId: identity!.id,
      },
    );
    const facts = await getEnterpriseUserProfileFacts(DEFAULT_TENANT_ID, identity!.id);
    expect(attributesFromRows(facts!.attributes)).toMatchObject({
      employeeNo: "E-F01",
      departmentCode: "D-F01",
    });
    expect(facts?.syncState?.sourceSystem).toBe("directory");
  });

  it("trusted-headers 模式从 header 解析身份", async () => {
    setAuthMode("trusted-headers");
    const headers = new Headers();
    headers.set("x-snow-user-id", "sso-42");
    headers.set("x-snow-user-email", "bob@example.com");
    headers.set("x-snow-user-name", "Bob");

    const principal = await resolvePrincipal(headers, "admin");
    expect(principal.externalSubject).toBe("sso-42");
    expect(principal.email).toBe("bob@example.com");
    expect(principal.displayName).toBe("Bob");
    expect(principal.audience).toBe("admin");
  });

  it("trusted-headers 模式缺 externalId → AuthenticationError missing_identity", async () => {
    setAuthMode("trusted-headers");
    const headers = new Headers();
    headers.set("x-snow-user-email", "bob@example.com");
    await expect(resolvePrincipal(headers)).rejects.toThrow(AuthenticationError);
    try {
      await resolvePrincipal(headers);
    } catch (e) {
      expect((e as AuthenticationError).code).toBe("missing_identity");
    }
  });

  it("trusted-headers 模式缺 email → AuthenticationError missing_email", async () => {
    setAuthMode("trusted-headers");
    const headers = new Headers();
    headers.set("x-snow-user-id", "sso-42");
    await expect(resolvePrincipal(headers)).rejects.toThrow(AuthenticationError);
    try {
      await resolvePrincipal(headers);
    } catch (e) {
      expect((e as AuthenticationError).code).toBe("missing_email");
    }
  });

  it("trusted-headers 模式 header 值仅空白 → 视为缺失", async () => {
    setAuthMode("trusted-headers");
    const headers = new Headers();
    headers.set("x-snow-user-id", "   ");
    headers.set("x-snow-user-email", "bob@example.com");
    await expect(resolvePrincipal(headers)).rejects.toThrow(AuthenticationError);
  });

  it("trusted-headers 模式 email 漂移时更新", async () => {
    setAuthMode("trusted-headers");
    const h1 = new Headers();
    h1.set("x-snow-user-id", "sso-42");
    h1.set("x-snow-user-email", "bob@example.com");
    h1.set("x-snow-user-name", "Bob");
    const first = await resolvePrincipal(h1);

    const h2 = new Headers();
    h2.set("x-snow-user-id", "sso-42");
    h2.set("x-snow-user-email", "bob.new@example.com");
    h2.set("x-snow-user-name", "Bob Smith");
    const second = await resolvePrincipal(h2);

    expect(second.userIdentityId).toBe(first.userIdentityId);
    expect(second.email).toBe("bob.new@example.com");
    expect(second.displayName).toBe("Bob Smith");
  });

  it("getCurrentPrincipal dev 模式可用", async () => {
    setAuthMode("dev");
    const principal = await getCurrentPrincipal("runtime");
    expect(principal.externalSubject).toBe(DEFAULT_USER_ID);
    expect(principal.audience).toBe("runtime");
  });

  it("getCurrentPrincipal trusted-headers 模式抛 AuthenticationError", async () => {
    setAuthMode("trusted-headers");
    await expect(getCurrentPrincipal()).rejects.toThrow(AuthenticationError);
  });

  it("authErrorResponse 把 AuthenticationError 转 401", async () => {
    const error = new AuthenticationError("missing_identity", "缺少 SSO 用户标识");
    const response = authErrorResponse(error, "req_test_1");
    expect(response).not.toBeNull();
    expect(response?.status).toBe(401);
    const body = (await response?.json()) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(body.error.request_id).toBe("req_test_1");
  });

  it("authErrorResponse 非 AuthenticationError 返回 null", () => {
    const response = authErrorResponse(new Error("other"), "req_test_2");
    expect(response).toBeNull();
  });

  it("authErrorResponse 缺 requestId 时自动生成", async () => {
    const error = new AuthenticationError("missing_email", "缺少邮箱");
    const response = authErrorResponse(error);
    expect(response).not.toBeNull();
    const body = (await response?.json()) as { error: { request_id: string } };
    expect(body.error.request_id).toMatch(/^req_/);
  });
});
