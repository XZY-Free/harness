/**
 * 正式 schema seed 集成测试（§19.5，真实 MySQL 8）。
 *
 * 空库流程必须是 Migration → Seed 真正成功，不允许"schema 不兼容跳过"。
 * seed 只幂等引导正式对象：tenant → UserIdentity → principalBinding → 默认 Agent。
 *
 * 与 lib/identity/identity.test.ts 同构：beforeEach resetDatabase 清空所有表，
 * seed 走真实 queries 层连真实 DB，不 mock db client。
 */
import { db } from "@/lib/db/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAgentByKey } from "@/lib/agents/persistence/agent-queries";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { DEFAULT_AGENT_KEY, seedDefaultAgent, seedDefaultIdentity } from "@/lib/db/seed";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { getPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { getTenantByKey } from "@/lib/identity/tenant-queries";
import { getUserIdentityBySubject } from "@/lib/identity/user-identity-queries";
import { agentTable } from "@/lib/persistence/schema/agent";
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

// ─── seedDefaultAgent ────────────────────────────────────────

describe("seedDefaultAgent", () => {
  it("首次：建默认 draft Agent（身份）", async () => {
    const { tenantId } = await seedDefaultIdentity();
    const r = await seedDefaultAgent();

    expect(r.created).toBe(true);

    const agent = await getAgentByKey(tenantId, DEFAULT_AGENT_KEY);
    expect(agent).not.toBeNull();
    expect(agent?.lifecycleState).toBe("draft");
    expect(agent?.displayName).toBe("默认 Agent");
    expect(agent?.ownerUserId).toBeTruthy();
  });

  it("幂等：重复调用返回 created=false，不重复建 agent", async () => {
    const { tenantId } = await seedDefaultIdentity();
    await seedDefaultAgent();
    const r = await seedDefaultAgent();

    expect(r.created).toBe(false);
    expect(await db.select().from(agentTable)).toHaveLength(1);
  });

  it("agent 由 seedDefaultIdentity 的默认用户担任 owner", async () => {
    const { tenantId, userIdentityId } = await seedDefaultIdentity();
    await seedDefaultAgent();

    const agent = await getAgentByKey(tenantId, DEFAULT_AGENT_KEY);
    expect(agent?.ownerUserId).toBe(userIdentityId);
  });
});

// ─── 端到端：完整 seed 流程幂等 ─────────────────────────────

describe("完整 seed 流程（端到端真实 DB）", () => {
  it("seedDefaultIdentity + seedDefaultAgent → 重复跑不报错、行数不累积", async () => {
    await seedDefaultIdentity();
    await seedDefaultAgent();

    const snap = {
      tenant: (await db.select().from(tenant)).length,
      userIdentity: (await db.select().from(userIdentity)).length,
      principalBinding: (await db.select().from(principalBinding)).length,
      agent: (await db.select().from(agentTable)).length,
    };
    expect(snap).toEqual({ tenant: 1, userIdentity: 1, principalBinding: 1, agent: 1 });

    // 第二次跑：真实 unique 约束 + 应用层幂等逻辑共同保证不抛错、不累积
    await expect(seedDefaultIdentity()).resolves.toBeTruthy();
    await expect(seedDefaultAgent()).resolves.toEqual({ created: false });

    expect(await db.select().from(tenant)).toHaveLength(1);
    expect(await db.select().from(userIdentity)).toHaveLength(1);
    expect(await db.select().from(principalBinding)).toHaveLength(1);
    expect(await db.select().from(agentTable)).toHaveLength(1);
  });
});
