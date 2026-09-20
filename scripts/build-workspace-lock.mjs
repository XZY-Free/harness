#!/usr/bin/env node
/**
 * 构建 `native/workspace-lock`（A07 决策一的内核排他锁 provider）。
 *
 * 用法：`pnpm build:workspace-lock`
 *
 * 为什么必须是真实构建而不是可选的：
 * `lib/workspace/scope-lock.ts` 在 provider 缺失时**抛出**
 * `ScopeLockUnavailableError`（进而被 Broker 收敛为 `WorkspaceWriterNotFenced`），
 * 绝不静默降级成"没有锁也能写"。因此宿主（开发机 / 运行镜像）必须先跑本脚本。
 *
 * 只接受**本仓库唯一**的原生 provider：不保留任何旧算法 fallback。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleRoot = join(repoRoot, "native", "workspace-lock");

const NODE_GYP_CANDIDATES = [join(repoRoot, "node_modules", ".pnpm")];

function findNodeGyp() {
  const configured = process.env.SNOWHARNESS_NODE_GYP_PATH?.trim();
  if (configured && existsSync(configured)) return configured;
  const direct = join(repoRoot, "node_modules", "node-gyp", "bin", "node-gyp.js");
  if (existsSync(direct)) return direct;
  // pnpm：node-gyp 可能是 @electron/rebuild 的传递依赖，位于 .pnpm 下。
  const pnpmDir = NODE_GYP_CANDIDATES[0];
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (!entry.startsWith("node-gyp@")) continue;
      const candidate = join(pnpmDir, entry, "node_modules", "node-gyp", "bin", "node-gyp.js");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const nodeGyp = findNodeGyp();
if (!nodeGyp) {
  console.error(
    "[build:workspace-lock] 未找到 node-gyp。请先在仓库根执行 `pnpm install`，或设置 SNOWHARNESS_NODE_GYP_PATH。",
  );
  process.exit(1);
}

console.log(`[build:workspace-lock] 使用 ${nodeGyp}`);
const result = spawnSync(process.execPath, [nodeGyp, "rebuild"], {
  cwd: moduleRoot,
  stdio: "inherit",
  env: process.env,
});
if (result.status !== 0) {
  console.error(
    "[build:workspace-lock] 构建失败。原生 provider 缺失时 scope 临界区会 fail closed。",
  );
  process.exit(result.status ?? 1);
}

const built = join(moduleRoot, "build", "Release", "workspace_lock.node");
if (!existsSync(built)) {
  console.error(`[build:workspace-lock] 构建命令成功但未产出 ${built}`);
  process.exit(1);
}
console.log(`[build:workspace-lock] 完成：${built}`);
