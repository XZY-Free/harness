/**
 * S10-W08 e2e 启动编排脚本（playwright webServer）。
 *
 * 职责：
 * - 启动真实 MySQL 8 容器（testcontainers）+ 跑 drizzle migration。
 * - 用注入的 DATABASE_URL 启动 `next dev --turbo`（APP_ENV=test，认证回退默认用户）。
 * - 转发 SIGTERM / SIGINT 到子进程，关闭容器后退出。
 *
 * 设计要点：
 * - 不复用 vitest 的 globalSetup：playwright webServer 与 globalSetup 启动顺序不同
 *   （webServer 先于 globalSetup），需在 webServer 命令内自包含 MySQL 启动。
 * - 使用 testcontainers 而非本地 MySQL，确保 CI 与本地行为一致。
 * - 复用 vitest mysql-harness 的容器启动参数（关闭 binlog/flush/file-per-table）
 *   以加速 TRUNCATE，但 e2e 不 TRUNCATE（只跑 migration 一次），保留参数仅作一致性。
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";

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

  // 启动 Next.js dev server（APP_ENV=test → 认证回退默认用户）。
  // turbo 模式首次编译较慢，playwright webServer.timeout 已设为 180s。
  console.log("[e2e] 正在启动 Next.js dev server...");
  const dev = spawn("pnpm", ["dev:test"], {
    env: { ...process.env, DATABASE_URL: connectionString },
    stdio: "inherit",
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[e2e] 收到 ${signal}，开始关闭...`);
    dev.kill("SIGTERM");
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
