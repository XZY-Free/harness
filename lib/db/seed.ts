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
 *   tenant → UserIdentity → principalBinding → 默认 Agent。
 *
 * 每个步骤都是 upsert / get-then-create 幂等，重复执行不产生重复行、
 * 不抛 unique 冲突，天然满足"Migration → Seed 成功"。
 */
import { createAgent, getAgentByKey } from "@/lib/agents/persistence/agent-queries";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";

/** 默认 agent key（租户内唯一，幂等键）。 */
export const DEFAULT_AGENT_KEY = "default";

/**
 * 幂等引导默认租户 + 默认用户身份 + 主体绑定。
 *
 * 与 `lib/identity/resolver.ts` 的 `resolvePrincipal` 每请求引导链同源，
 * 空库时保证内部 identity 骨架就绪。返回 tenantId 与 userIdentityId。
 */
export async function seedDefaultIdentity(): Promise<{
  tenantId: string;
  userIdentityId: string;
}> {
  const tenant = await ensureDefaultTenant();

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

  return { tenantId: tenant.id, userIdentityId: identity.id };
}

/**
 * 幂等灌默认 Agent（getAgentByKey 先行防重复；已存在则 no-op）。
 *
 * 仅建 draft 身份，不造 revision / route——正式 Route/Agent 生命周期由
 * 控制面 API 建立，seed 只保证空库有可用的默认 Agent 身份。
 */
export async function seedDefaultAgent(): Promise<{ created: boolean }> {
  const { tenantId, userIdentityId } = await seedDefaultIdentity();

  const existing = await getAgentByKey(tenantId, DEFAULT_AGENT_KEY);
  if (existing) return { created: false };

  await createAgent({
    tenantId,
    agentKey: DEFAULT_AGENT_KEY,
    displayName: "默认 Agent",
    description: "正式 schema seed 引导的默认 agent（draft 身份）",
    ownerUserId: userIdentityId,
    lifecycleState: "draft",
  });

  return { created: true };
}

// ─── CLI runner（pnpm db:seed → tsx lib/db/seed.ts）─────────

async function main() {
  console.log("[seed] 开始正式 schema seed...");

  const identity = await seedDefaultIdentity();
  console.log(
    `[seed] 默认租户 + 用户身份就绪：tenant=${identity.tenantId} userIdentity=${identity.userIdentityId}`,
  );

  const agent = await seedDefaultAgent();
  console.log(
    `[seed] 默认 agent "${DEFAULT_AGENT_KEY}" ${agent.created ? "已写入" : "已存在（幂等跳过）"}`,
  );

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
