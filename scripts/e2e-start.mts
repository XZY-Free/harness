/**
 * e2e 启动编排脚本（playwright webServer）。
 *
 * 职责：
 * - 启动真实 MySQL 8 容器（testcontainers）+ 跑 drizzle migration。
 * - 启动 e2e 确定性模型服务（OpenAI 兼容端点），使 Agent Loop 能真正产出回复。
 * - 引导正式执行链（enabled Agent → published Revision → Route → Projection），
 *   使客户端首条消息能走通 Route Resolver → ExecutionBinding → Runtime。
 * - 用注入的 DATABASE_URL / LLM_* 构建并启动 Next server（APP_ENV=test，认证回退默认用户）。
 * - 转发 SIGTERM / SIGINT 到子进程，关闭容器后退出。
 *
 * 设计要点：
 * - 不复用 vitest 的 globalSetup：playwright webServer 与 globalSetup 启动顺序不同
 *   （webServer 先于 globalSetup），需在 webServer 命令内自包含 MySQL 启动。
 * - 使用 testcontainers 而非本地 MySQL，确保 CI 与本地行为一致。
 * - 模型服务是 OpenAI 兼容 HTTP 端点（§11.2 允许的「测试 HTTP Server」），
 *   生产 provider / streamText 路径完整执行，生产代码零测试分支。
 * - 引导脚本以子进程运行（`tsx scripts/e2e-bootstrap.ts`），确保 `@/` 别名解析与
 *   正式 worker 脚本一致，且 DB 连接在自己的进程内开闭。
 * - 用 `next build` + `next start`（而非 `next dev`）：Next 16 对同一项目目录的
 *   dev server 有独占锁，开发者常驻 `pnpm dev` 时 e2e 起不来；且 start 更贴近生产。
 *   构建输出隔离到 `.next-e2e`，不污染开发者的 `.next`。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import { startE2eModelServer } from "./e2e-model-server.mts";

/** e2e 构建产物目录：与开发者的 .next 隔离。 */
const E2E_DIST_DIR = ".next-e2e";

/**
 * 解析 .env 文件为键值对（只支持 KEY=VALUE 与 # 注释，够用即可）。
 *
 * 为什么需要：`next start` 会把 NODE_ENV 设为 production，Next 因此加载
 * `.env.production` 而不是 `.env.test`——若不显式注入，SNOW_AUTH_MODE 等
 * 测试配置会取到生产值，导致鉴权失败、助手列表为空。
 * 显式读取 `.env.test` 可让它继续作为 e2e 配置的唯一事实源，避免在代码里复制一份。
 */
function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const parsed: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    parsed[key] = value;
  }
  return parsed;
}

/** 构造子进程环境（.env.test 基线 + DB / 确定性模型 / 隔离构建目录覆盖）。 */
function childEnv(connectionString: string, modelBaseUrl: string, port: string) {
  return {
    ...process.env,
    ...loadEnvFile(resolve(process.cwd(), ".env.test")),
    APP_ENV: "test",
    PORT: port,
    SNOW_DIST_DIR: E2E_DIST_DIR,
    DATABASE_URL: connectionString,
    LLM_BASE_URL: modelBaseUrl,
    LLM_API_KEY: "e2e-test-key",
  };
}

/** 跑一个子命令并等待其成功退出；失败即中止（禁止「跳过后继续」的伪成功）。 */
function runToCompletion(
  label: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${label} 退出码 ${code}`));
    });
    child.on("error", rejectRun);
  });
}

async function main(): Promise<void> {
  // 禁用 ryuk 资源回收容器（网络受限拉不动；teardown 显式 stop 容器即可）。
  process.env.TESTCONTAINERS_RYUK_DISABLED = "true";
  const { MySqlContainer } = await import("@testcontainers/mysql");

  console.log("[e2e] 正在启动 MySQL 容器...");
  const container = await new MySqlContainer("mysql:8.0")
    .withDatabase("snow_test")
    .withRootPassword("test")
    .withCommand([
      "--skip-sync-binlog",
      "--innodb-flush-log-at-trx-commit=0",
      "--innodb-doublewrite=0",
      "--disable-log-bin",
      "--innodb-file-per-table=0",
    ])
    .start();
  const connectionString = container.getConnectionUri();
  console.log(`[e2e] MySQL 就绪：${connectionString}`);

  // 跑 drizzle migration（与生产同构，确保 schema 完整）。
  console.log("[e2e] 正在执行 drizzle migration...");
  const migratePool = mysql.createPool(connectionString);
  const migrateDb = drizzle(migratePool, { mode: "default" });
  try {
    await migrate(migrateDb, {
      migrationsFolder: resolve(process.cwd(), "drizzle"),
    });
  } finally {
    await migratePool.end();
  }
  console.log("[e2e] Migration 完成。");

  // 启动确定性模型服务（OpenAI 兼容端点）。
  const modelServer = await startE2eModelServer();
  console.log(`[e2e] 确定性模型服务就绪：${modelServer.baseUrl}`);

  const port = process.env.SNOW_E2E_PORT ?? "3100";
  const env = childEnv(connectionString, modelServer.baseUrl, port);

  // 引导正式执行链（Agent/Runtime/Publication/Route/Projection 全走正式服务）。
  console.log("[e2e] 正在引导正式执行链...");
  await runToCompletion("e2e 引导脚本", "pnpm", ["exec", "tsx", "scripts/e2e-bootstrap.ts"], env);
  console.log("[e2e] 正式执行链引导完成。");

  // 构建到隔离目录后用 next start 运行。
  //
  // 不用 next dev 的原因：Next 16 对同一项目目录的 dev server 有独占锁，
  // 开发者本机常驻 `pnpm dev` 时 e2e 无法启动第二个 dev server（换端口也不行）。
  // next start 无此限制，且更贴近生产行为，符合 §20「验证真实产品」的意图。
  console.log(`[e2e] 正在构建（distDir=${E2E_DIST_DIR}）...`);
  await runToCompletion("e2e 构建", "pnpm", ["exec", "next", "build"], env);
  console.log("[e2e] 构建完成。");

  console.log(`[e2e] 正在启动 Next.js server（端口 ${port}）...`);
  const dev = spawn("pnpm", ["exec", "next", "start", "--port", port], {
    env,
    stdio: "inherit",
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[e2e] 收到 ${signal}，开始关闭...`);
    dev.kill("SIGTERM");
    await modelServer.close().catch(() => {});
    try {
      await container.stop();
      console.log("[e2e] MySQL 容器已停止。");
    } catch (err) {
      console.error("[e2e] MySQL 停止失败：", err);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  dev.on("exit", (code) => {
    console.log(`[e2e] Dev server 退出，code=${code}`);
    void modelServer.close().catch(() => {});
    container
      .stop()
      .catch((err) => console.error("[e2e] MySQL 停止失败：", err))
      .finally(() => process.exit(code ?? 0));
  });
}

main().catch((err) => {
  console.error("[e2e] 启动失败：", err);
  process.exit(1);
});
