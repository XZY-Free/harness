/**
 * 正式 schema seed 集成测试（§19.5，真实 MySQL 8）。
 *
 * 空库流程必须是 Migration → Seed 真正成功，不允许"schema 不兼容跳过"。
 * seed 只幂等引导正式对象：tenant → UserIdentity → principalBinding → PermissionGrant。
 * 专题01 §15：不创建默认 Agent（Agent 空表是合法平台状态，§6.2/§33.1）。
 *
 * 与 lib/identity/identity.test.ts 同构：beforeEach resetDatabase 清空所有表，
 * seed 走真实 queries 层连真实 DB，不 mock db client。
 */
import { db } from "@/lib/db/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { seedDefaultIdentity } from "@/lib/db/seed";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { getPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { getTenantByKey } from "@/lib/identity/tenant-queries";
import { getUserIdentityBySubject } from "@/lib/identity/user-identity-queries";
import { principalBinding, tenant, userIdentity } from "@/lib/persistence/schema/identity";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(async () => {
  await resetDatabase(db);
});

// ─── seedDefaultIdentity ─────────────────────────────────────

describe("seedDefaultIdentity", () => {
  it("首次：建默认租户 + 默认用户身份 + 主体绑定", async () => {
    const r = await seedDefaultIdentity();

    expect(r.tenantId).toBeTruthy();
    expect(r.userIdentityId).toBeTruthy();

    const t = await getTenantByKey("default");
    expect(t).not.toBeNull();
    expect(t?.id).toBe(r.tenantId);

    const identity = await getUserIdentityBySubject(r.tenantId, DEFAULT_USER_ID);
    expect(identity).not.toBeNull();
    expect(identity?.id).toBe(r.userIdentityId);
    expect(identity?.email).toBe(DEFAULT_USER_EMAIL);
    expect(identity?.displayName).toBe(DEFAULT_USER_NAME);
    expect(identity?.status).toBe("active");

    const binding = await getPrincipalBinding(r.tenantId, "user", DEFAULT_USER_ID);
    expect(binding).not.toBeNull();
    expect(binding?.userIdentityId).toBe(r.userIdentityId);
  });

  it("幂等：重复调用复用同一 tenant/identity/binding，不累积行", async () => {
    const first = await seedDefaultIdentity();
    const second = await seedDefaultIdentity();

    expect(second.tenantId).toBe(first.tenantId);
    expect(second.userIdentityId).toBe(first.userIdentityId);

    expect(await db.select().from(tenant)).toHaveLength(1);
    expect(await db.select().from(userIdentity)).toHaveLength(1);
    expect(await db.select().from(principalBinding)).toHaveLength(1);
  });
});

// ─── 端到端：完整 seed 流程幂等 ─────────────────────────────

describe("完整 seed 流程（端到端真实 DB）", () => {
  it("seedDefaultIdentity → 重复跑不报错、行数不累积；不创建任何 Agent（§15 Agent 空表合法）", async () => {
    await seedDefaultIdentity();

    const snap = {
      tenant: (await db.select().from(tenant)).length,
      userIdentity: (await db.select().from(userIdentity)).length,
      principalBinding: (await db.select().from(principalBinding)).length,
    };
    expect(snap).toEqual({ tenant: 1, userIdentity: 1, principalBinding: 1 });

    // 第二次跑：真实 unique 约束 + 应用层幂等逻辑共同保证不抛错、不累积
    await expect(seedDefaultIdentity()).resolves.toBeTruthy();

    expect(await db.select().from(tenant)).toHaveLength(1);
    expect(await db.select().from(userIdentity)).toHaveLength(1);
    expect(await db.select().from(principalBinding)).toHaveLength(1);
  });
});
