/**
 * 正式 schema seed（§19.5）。
 *
 * 空库流程必须是：
 *
 * ```text
 * Migration
 * → Seed
 * ```
 *
 * 必须真正成功，不允许"schema 不兼容，所以跳过 Agent Seed"之类逻辑。
 *
 * 正式系统惰性自举：`ensureDefaultTenant` 每请求、`ensureRouteSet` 惰性，
 * seed 不承载关键基建——本 seed 只做幂等引导正式对象：
 *   tenant → UserIdentity → principalBinding → PermissionGrant。
 *
 * 专题01 §15：不再创建默认 Agent（Agent 空表是合法平台状态，§6.2/§33.1）；
 * 基础 Harness Runtime 初始化走正式 Runtime 控制面（§15.3/§11.4），不伪装成 Agent seed。
 *
 * 每个步骤都是 upsert / get-then-create 幂等，重复执行不产生重复行、
 * 不抛 unique 冲突，天然满足"Migration → Seed 成功"。
 */
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import type { ActionCode } from "@/lib/identity/action-codes";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";

/** 默认用户授予的 Studio 动作码（admin 等值：全部 Studio 长期业务动作）。 */
export const DEFAULT_GRANT_ACTION_CODES: ActionCode[] = [
  "studio.access",
  "skill.read",
  "skill.write",
  "thread.read",
  "thread.write",
  "policy.read",
  "policy.write",
  "user.manage",
  "agent.read",
  "workspace.read",
  "workspace.write",
  "analytics.read",
  "audit.read",
];

/**
 * 幂等引导默认租户 + 默认用户身份 + 主体绑定。
 *
 * 与 `lib/identity/resolver.ts` 的 `resolvePrincipal` 每请求引导链同源，
 * 空库时保证内部 identity 骨架就绪。返回 tenantId / userIdentityId / principalBindingId。
 */
export async function seedDefaultIdentity(): Promise<{
  tenantId: string;
  userIdentityId: string;
  principalBindingId: string;
}> {
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

  return { tenantId: tenant.id, userIdentityId: identity.id, principalBindingId: binding.id };
}

/**
 * 为默认用户授予全部 Studio 动作码（tenant-wildcard scope，admin 等值）。
 *
 * thread 类动作额外授予 self-wildcard scope：正式授权模型里 ".self" 解码为
 * (self 资源)，tenant-wildcard grant 不覆盖 self 类型请求资源（scopeCovers 要求
 * type 相同），故默认用户需同时持有 tenant + self 两态，才能通过
 * requireStudioAction(…, { type: "self" }) 门禁（创建/管理自己的 thread）。
 *
 * 幂等：grantActionBinding 每次写入新绑定，重复执行会产生重复行；
 * 这里不依赖唯一约束（RoleActionBinding 无 (tenant,principal,action) unique），
 * 交由调用方（CLI seed / 测试 setup）决定是否重复调用。
 */
export async function seedDefaultGrants(
  tenantId: string,
  principalBindingId: string,
): Promise<void> {
  for (const actionCode of DEFAULT_GRANT_ACTION_CODES) {
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode,
      resourceScope: { type: "tenant", wildcard: true },
    });
  }
  // thread 类动作：self 范围（旧 thread.write.self 语义），默认用户 admin 等值。
  for (const actionCode of ["thread.read", "thread.write"] as const) {
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode,
      resourceScope: { type: "self", wildcard: true },
    });
  }
}

// ─── CLI runner（pnpm db:seed → tsx lib/db/seed.ts）─────────

async function main() {
  console.log("[seed] 开始正式 schema seed...");

  const identity = await seedDefaultIdentity();
  console.log(
    `[seed] 默认租户 + 用户身份就绪：tenant=${identity.tenantId} userIdentity=${identity.userIdentityId}`,
  );

  await seedDefaultGrants(identity.tenantId, identity.principalBindingId);
  console.log(`[seed] 默认用户授予 ${DEFAULT_GRANT_ACTION_CODES.length} 个 Studio 动作码`);

  // 专题01 §15：不创建默认 Agent（Agent 空表合法）。基础 Harness Runtime 走正式控制面初始化。
  console.log("[seed] 正式 schema seed 完成");
  process.exit(0);
}

// 直接运行时执行；被 import（单测）时不自动跑。
// 用 typeof require 守卫，CJS / ESM 加载器下都安全。
if (typeof require !== "undefined" && require.main === module) {
  main().catch((error) => {
    console.error("[seed] 失败：", error);
    process.exit(1);
  });
}
