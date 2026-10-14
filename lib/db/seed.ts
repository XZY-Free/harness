/**
 * schema seed（占位指引）。
 *
 * 空库流程（消费方模型 v4，身份与租户数据的唯一权威是 auth-center 仓）：
 *
 * ```text
 * auth-center 迁移（19 表，含 Tenant / UserIdentity / PrincipalBinding）
 * → auth-center seed（默认租户 + 管理员，幂等）
 * → nexharness 迁移（116 表，外键引用上述 3 表）
 * → 本 seed（无独立种子数据，仅输出指引）
 * ```
 *
 * 本仓不再承载任何身份引导逻辑——原 seedDefaultIdentity / seedDefaultGrants
 * 已随身份域迁移至 auth-center（其 lib/db/seed.ts 为权威版本）。
 */

// ─── CLI runner（pnpm db:seed → tsx lib/db/seed.ts）─────────

function main(): void {
  console.log("[seed] nexharness 116 表基线无独立种子数据。");
  console.log("[seed] 身份与租户数据由 auth-center 统一管理，建库顺序：");
  console.log("[seed]   1) cd ../auth-center && pnpm db:migrate   # 19 表（外键前置）");
  console.log("[seed]   2) cd ../auth-center && pnpm db:seed      # 默认租户 + 管理员");
  console.log("[seed]   3) 本仓 pnpm exec drizzle-kit migrate     # 116 表");
  console.log("[seed] 完成。");
}

// 直接运行时执行；被 import 时不自动跑。
// 用 typeof require 守卫，CJS / ESM 加载器下都安全。
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main();
}
