// S01-W04：项目级统一验证入口。
//
// 把 契约校验、类型检查、单元测试、真实 MySQL 集成测试、lint 和生产构建组合为
// 单一命令，作为后续阶段共同验收入口。任一步失败立即终止并返回非零退出码。
//
// 用法：node scripts/verify.mjs
// 可选环境变量：
//   VERIFY_SKIP_BUILD=1  跳过生产构建（本地快速验证）

import { spawnSync } from "node:child_process";

const skipBuild = process.env.VERIFY_SKIP_BUILD === "1";

const steps = [
  { name: "契约校验", cmd: ["pnpm", ["contracts:verify"]] },
  { name: "TypeScript 类型检查", cmd: ["pnpm", ["typecheck"]] },
  { name: "单元 + MySQL 集成测试", cmd: ["pnpm", ["test"]] },
  { name: "Lint (biome)", cmd: ["pnpm", ["lint"]] },
];
if (!skipBuild) {
  steps.push({ name: "生产构建 (next build)", cmd: ["pnpm", ["build"]] });
}

function runStep(step) {
  console.log(`\n▶ ${step.name}`);
  console.log("─".repeat(60));
  const [bin, args] = step.cmd;
  const result = spawnSync(bin, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✗ 失败：${step.name}（退出码 ${result.status ?? "null"})`);
    process.exit(result.status ?? 1);
  }
  console.log(`✓ ${step.name}`);
}

console.log("V11 验证入口 — 契约 / 类型 / 测试 / lint / 构建");
for (const step of steps) {
  runStep(step);
}
console.log("\n✅ 全部验证通过");
