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
import { db } from "@/lib/db/client";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { permissionRoleAssignment } from "@/lib/persistence/schema/authorization";
import { principalBinding } from "@/lib/persistence/schema/identity";
import { and, eq } from "drizzle-orm";

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

/** 显式管理员引导只写正式角色分配，唯一约束保证幂等。 */
export async function seedDefaultGrants(
  tenantId: string,
  principalBindingId: string,
): Promise<void> {
  const [principal] = await db
    .select()
    .from(principalBinding)
    .where(
      and(eq(principalBinding.id, principalBindingId), eq(principalBinding.tenantId, tenantId)),
    );
  if (!principal || principal.subjectType !== "user") throw new Error("管理员主体不存在");
  await db
    .insert(permissionRoleAssignment)
    .ignore()
    .values({ tenantId, principalId: principalBindingId, roleKey: "admin", source: "local" });
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
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main().catch((error) => {
    console.error("[seed] 失败：", error);
    process.exit(1);
  });
}
