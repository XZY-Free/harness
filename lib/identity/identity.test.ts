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
import {
  getPrincipalBinding,
  listPrincipalBindingsByUser,
  upsertPrincipalBinding,
} from "@/lib/identity/principal-binding-queries";
import {
  AuthenticationError,
  getCurrentPrincipal,
  resolvePrincipal,
  authErrorResponse,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

function setAuthMode(mode: string | undefined) {
  process.env.SNOW_AUTH_MODE = mode;
}

beforeEach(async () => {
  await resetDatabase(db);
  setAuthMode("dev");
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
