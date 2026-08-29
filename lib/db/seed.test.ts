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
import { randomUUID } from "node:crypto";

import { db } from "@/lib/db/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { seedDefaultGrants, seedDefaultIdentity } from "@/lib/db/seed";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { checkActionScope } from "@/lib/identity/authorization";
import { getPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { getTenantByKey } from "@/lib/identity/tenant-queries";
import { getUserIdentityBySubject } from "@/lib/identity/user-identity-queries";
import { agentTable } from "@/lib/persistence/schema/agents";
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

// ─── seedDefaultGrants：外部 Agent onboarding 授权闭环 ──────

/**
 * 专题01 §14（07-Studio管理闭环.md）：Migration → Seed 后，默认开发者管理员
 * 必须能走完现有 Studio 外部 Agent onboarding 流：注册合同 → 建 Revision →
 * 发布 Agent Revision → 注册外部 Runtime → 发布 RuntimeRevision → 发布员工路由。
 *
 * 事实源是现有 admin 路由的 requireAdminActionScope 调用参数，不是 UI：
 * - agent.contract.register → { type: "agent", id: null }（DB Agent id 登记前不存在）
 * - agent.revision.create / agent.publish / route.update
 *   → { type: "agent", id: <已建记录的具体 id> }
 * - runtime.publish → { type: "runtime", id: <已建 Runtime 的具体 id> }
 *
 * 不 mock checkActionScope / 查询 / DB：走真实 MySQL 的 RoleActionBinding 行。
 * 未知 action 仍 fail-closed；Agent 空表断言保持不变。
 */
describe("seedDefaultGrants：外部 Agent onboarding 五动作全通", () => {
  it("seed 后 checkActionScope 对六个 onboarding action/resource 组合全部 allowed", async () => {
    const identity = await seedDefaultIdentity();
    await seedDefaultGrants(identity.tenantId, identity.principalBindingId);

    // 具体资源 id：任意 UUID 即可（wildcard scope 覆盖同 type 所有 id）。
    const agentId = randomUUID();
    const runtimeId = randomUUID();

    const onboardingRequests = [
      // 1. 注册 Agent 合同（route: agent-registrations，pre-create → id=null）
      { actionCode: "agent.contract.register", resource: { type: "agent", id: null } },
      // 2. 创建 AgentRevision（route: agents/[agent_id]/revisions）
      { actionCode: "agent.revision.create", resource: { type: "agent", id: agentId } },
      // 3. 发布 AgentRevision（route: agent-revisions/[revision_id]/publish）
      { actionCode: "agent.publish", resource: { type: "agent", id: agentId } },
      // 4. 发布 RuntimeRevision（route: runtime-revisions/[revision_id]/publish）
      { actionCode: "runtime.publish", resource: { type: "runtime", id: runtimeId } },
      // 5. 发布员工路由（route: deployment-route-sets / hosted-provisioning）
      { actionCode: "route.update", resource: { type: "agent", id: agentId } },
    ] as const;

    for (const request of onboardingRequests) {
      const decision = await checkActionScope(identity.tenantId, identity.userIdentityId, request);
      expect(decision, `${request.actionCode} 应被默认授权`).toEqual({ allowed: true });
    }

    // 既有安全语义不放松：Agent 空表仍是合法平台状态（§15）。
    expect(await db.select().from(agentTable)).toHaveLength(0);
  });

  it("未知 action 仍 fail-closed（不因 seed 放宽）", async () => {
    const identity = await seedDefaultIdentity();
    await seedDefaultGrants(identity.tenantId, identity.principalBindingId);

    const decision = await checkActionScope(identity.tenantId, identity.userIdentityId, {
      actionCode: "not.a.real.action" as never,
      resource: { type: "agent", id: null },
    });
    expect(decision).toEqual({ allowed: false, reason: "unknown_action" });
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
