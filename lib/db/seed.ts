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
 * seed 不承载关键基建——CLI seed 只引导默认租户。用户、主体绑定与权限必须由
 * `auth:bootstrap-admin` 显式创建，不能让空库启动后凭空出现已登录用户。
 *
 * 专题01 §15：不再创建默认 Agent（Agent 空表是合法平台状态，§6.2/§33.1）；
 * 基础 Harness Runtime 初始化走正式 Runtime 控制面（§15.3/§11.4），不伪装成 Agent seed。
 *
 * 测试和迁移工具可显式调用下方身份/授权 helper；这些 helper 同样保持幂等。
 */
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import type { ActionCode } from "@/lib/identity/action-codes";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import {
  grantActionBinding,
  listActionBindingsByPrincipal,
  parseBindingScope,
} from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";

/** 默认用户授予的 Studio 动作码（admin 等值：全部 Studio 长期业务动作，tenant-wildcard）。 */
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
  "agent.invoke",
  "workspace.read",
  "workspace.write",
  "analytics.read",
  "audit.read",
];

/**
 * 外部 Agent onboarding 动作 → 显式资源 scope（专题01 §14，07-Studio管理闭环.md）。
 *
 * 默认开发者管理员必须能走完现有 Studio 外部 Agent 注册闭环：注册合同 →
 * 建 Revision → 发布 Agent Revision → 注册外部 Runtime → 发布 RuntimeRevision →
 * 发布员工路由。scope type 取自 ACTION_RESOURCE_TYPES 与各 admin 路由的
 * requireAdminActionScope 实参（agent.contract.register 为 pre-create，
 * resource id=null，wildcard 同样覆盖）。
 *
 * 不用 tenant scope：tenant-wildcard 只覆盖 type=tenant 的请求资源，
 * scopeCovers 要求 type 严格相等，必须按动作显式给 agent / runtime wildcard。
 */
export const ONBOARDING_GRANT_ACTION_SCOPES: ReadonlyArray<{
  actionCode: ActionCode;
  resourceScopeType: "agent" | "runtime";
}> = [
  { actionCode: "agent.contract.register", resourceScopeType: "agent" },
  { actionCode: "agent.revision.create", resourceScopeType: "agent" },
  { actionCode: "agent.publish", resourceScopeType: "agent" },
  { actionCode: "runtime.publish", resourceScopeType: "runtime" },
  { actionCode: "route.update", resourceScopeType: "agent" },
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
 * 为默认用户授予全部 Studio 动作码（tenant-wildcard scope，admin 等值），
 * 以及外部 Agent onboarding 六动作（显式 agent / runtime wildcard scope）。
 *
 * thread 类动作额外授予 self-wildcard scope：正式授权模型里 ".self" 解码为
 * (self 资源)，tenant-wildcard grant 不覆盖 self 类型请求资源（scopeCovers 要求
 * type 相同），故默认用户需同时持有 tenant + self 两态，才能通过
 * requireStudioAction(…, { type: "self" }) 门禁（创建/管理自己的 thread）。
 *
 * 幂等：写入前读取当前主体的有效绑定，同 action + 同 wildcard scope 已存在时跳过。
 * RoleActionBinding 没有业务唯一约束，因此幂等由本服务在单次管理流程中保证。
 */
export async function seedDefaultGrants(
  tenantId: string,
  principalBindingId: string,
): Promise<void> {
  const desired = [
    ...DEFAULT_GRANT_ACTION_CODES.map((actionCode) => ({
      actionCode,
      resourceScope: { type: "tenant" as const, wildcard: true as const },
    })),
    ...(["thread.read", "thread.write"] as const).map((actionCode) => ({
      actionCode,
      resourceScope: { type: "self" as const, wildcard: true as const },
    })),
    ...ONBOARDING_GRANT_ACTION_SCOPES.map(({ actionCode, resourceScopeType }) => ({
      actionCode,
      resourceScope: { type: resourceScopeType, wildcard: true as const },
    })),
  ];
  const existing = await listActionBindingsByPrincipal(tenantId, principalBindingId);
  const now = new Date();

  for (const grant of desired) {
    const alreadyActive = existing.some((binding) => {
      if (binding.actionCode !== grant.actionCode) return false;
      if (binding.validFrom > now || (binding.validUntil !== null && binding.validUntil <= now)) {
        return false;
      }
      const scope = parseBindingScope(binding);
      return scope?.type === grant.resourceScope.type && scope.wildcard === true;
    });
    if (!alreadyActive) {
      await grantActionBinding({
        tenantId,
        principalBindingId,
        actionCode: grant.actionCode,
        resourceScope: grant.resourceScope,
      });
    }
  }
}

// ─── CLI runner（pnpm db:seed → tsx lib/db/seed.ts）─────────

async function main() {
  console.log("[seed] 开始正式 schema seed...");
  const tenant = await ensureDefaultTenant();
  console.log(`[seed] 默认租户就绪：tenant=${tenant.id}`);

  // 专题01 §15：不创建默认 Agent（Agent 空表合法）。基础 Harness Runtime 走正式控制面初始化。
  // 用户和权限只能通过 auth:bootstrap-admin 显式创建，seed 不再制造可登录的默认身份。
  console.log("[seed] 正式 schema seed 完成（未创建默认用户）");
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
