/**
 * schema seed / 租户基线供给（消费方模型 v4）。
 *
 * 建库顺序（跨两仓）：
 *
 * ```text
 * auth-center 迁移（19 表）→ auth-center seed（默认租户，幂等）
 * → nexharness 迁移（116 表，外键引用）
 * → 本 seed：对已存在的全部租户幂等补齐内核基线（Governance + Policy 双 baseline）
 * ```
 *
 * 租户行由 auth-center 创建；内核基线属本仓数据——本命令即"租户供给流"的
 * nexharness 侧半边（auth-center 建租户 ↔ 内核基线幂等供给）。
 *
 * 用法：APP_ENV=development pnpm db:seed
 * 注意：db client 必须动态 import——静态 import 会在 env 装载前初始化（时序坑，
 * 与 scripts/register-builtin-tools.ts 同模式）。
 */
import { loadAppEnvFiles } from "@/lib/env-loader";

async function main(): Promise<void> {
  const appEnv = process.env.APP_ENV;
  if (!appEnv || !["development", "test", "production"].includes(appEnv)) {
    throw new Error("请显式设置 APP_ENV=development、test 或 production");
  }
  loadAppEnvFiles(appEnv);
  const { closeDbPool, db } = await import("@/lib/db/client");
  const { tenant } = await import("@/lib/persistence/schema/identity");
  const { ensureTenantBaselines } = await import("@/lib/identity/tenant-bootstrap");
  try {
    const tenants = await db.select({ id: tenant.id, key: tenant.key }).from(tenant);
    if (tenants.length === 0) {
      console.log(
        "[seed] 未发现租户。请先运行 auth-center 的 db:migrate 与 db:seed（建默认租户）。",
      );
      return;
    }
    for (const row of tenants) {
      const result = await ensureTenantBaselines(row.id);
      console.log(
        `[seed] 租户 ${row.key}（${row.id}）：Governance/Policy 基线${result === "created" ? "已创建" : "已存在"}`,
      );
    }
    console.log("[seed] 完成。");
  } finally {
    await closeDbPool();
  }
}

main().catch((error) => {
  console.error("[seed] 失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
