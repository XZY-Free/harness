import { loadAppEnvFiles } from "@/lib/env-loader";

/** 由部署操作者显式执行；不创建账户、不修改密码或网络策略。 */
async function main() {
  const appEnv = process.env.APP_ENV;
  if (!appEnv || !["development", "test", "production"].includes(appEnv)) {
    throw new Error("请显式设置 APP_ENV=development、test 或 production");
  }
  loadAppEnvFiles(appEnv);
  const [tenantId, ownerUserId] = process.argv.slice(2);
  if (!tenantId || !ownerUserId)
    throw new Error("用法：tsx scripts/register-builtin-tools.ts <tenantId> <ownerUserId>");
  const { db, closeDbPool } = await import("@/lib/db/client");
  try {
    const { userIdentity } = await import("@/lib/persistence/schema/identity");
    const { and, eq } = await import("drizzle-orm");
    const [owner] = await db
      .select({ id: userIdentity.id })
      .from(userIdentity)
      .where(
        and(
          eq(userIdentity.id, ownerUserId),
          eq(userIdentity.tenantId, tenantId),
          eq(userIdentity.status, "active"),
        ),
      )
      .limit(1);
    if (!owner) throw new Error("工具归属用户不存在、已停用或不属于指定租户");
    const { registerBuiltinTools } = await import("@/lib/capability/builtin-tools");
    await registerBuiltinTools({ tenantId, ownerUserId });
    console.log("Harness 基础工具登记完成，已有发布版本和停用决定保持不变。");
  } finally {
    await closeDbPool();
  }
}

main().catch(() => {
  console.error("基础工具登记失败，请检查环境、租户、用户及资产状态。");
  process.exitCode = 1;
});
