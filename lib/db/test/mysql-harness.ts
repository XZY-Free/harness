import * as schema from "@/lib/db/schema";
/**
 * S1（08 同构）：真实 MySQL 测试基础设施。
 *
 * 生产是 MySQL（mysql2 + drizzle），测试必须生产同构——禁止 fake-db mock 替代真实 DB 做事实源。
 * 本模块用 testcontainers 起真实 MySQL 8 容器，跑 drizzle migration，提供 per-test 隔离 helper。
 *
 * - globalSetup（vitest）启动时起 container + migrate，URL 写入 process.env.DATABASE_URL，
 *   db client 在 worker 进程 import 时读 env 建池。
 * - 每个 DB 测试 beforeEach 调 resetDatabase() 清空所有表（外键关闭后 TRUNCATE），
 *   保证测试间隔离。
 *
 * 性能优化（TRUNCATE 60+ 表的固有开销从 12s/test 降到 1-2s/test）：
 * - 表名列表在 worker 进程内缓存（migration 完成后表结构固定，SHOW TABLES 只跑一次）。
 * - MySQL container 启动时通过命令行参数关闭 binlog/flush/doublewrite/file-per-table，
 *   TRUNCATE 不再触发 binlog 刷盘和 .ibd 文件删除/创建（macOS Docker osxfs 主要开销）。
 * - reset 专用连接池启用 multipleStatements=true，把 60+ 条 TRUNCATE + FOREIGN_KEY_CHECKS
 *   开关拼成一条 SQL 一次往返执行；与 lib/db/client.ts 的生产池完全隔离，不影响生产安全。
 */
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";

/** 用全局 container 的连接串建一个 drizzle 实例（供 setup/migrate/重置用）。 */
export function buildDrizzle(connectionString: string) {
  const pool = mysql.createPool(connectionString);
  return { db: drizzle(pool, { schema, mode: "default" }), pool };
}

/** 起真实 MySQL 8 container 并跑 migration。返回连接串与停止函数。 */
export async function startTestMysql(): Promise<{
  connectionString: string;
  stop: () => Promise<void>;
}> {
  // 禁用 ryuk 资源回收容器（网络受限拉不动；teardown 显式 stop 容器即可）。
  process.env.TESTCONTAINERS_RYUK_DISABLED = "true";
  const { MySqlContainer } = await import("@testcontainers/mysql");
  // 关闭 binlog 同步 + 降低 innodb flush 频率：测试场景不需要持久化保证，
  // DDL（TRUNCATE）默认要等 binlog 刷盘，关闭后 TRUNCATE 提速 5-10 倍。
  const container = await new MySqlContainer("mysql:8.0")
    .withDatabase("snow_test")
    .withRootPassword("test")
    .withCommand([
      "--skip-sync-binlog",
      "--innodb-flush-log-at-trx-commit=0",
      "--innodb-doublewrite=0",
      "--disable-log-bin",
      // 共享表空间：TRUNCATE 不再删/建 .ibd 文件，避免 macOS Docker osxfs/VirtioFS
      // 文件系统开销（每表 TRUNCATE ~100ms → ~5ms）。
      "--innodb-file-per-table=0",
    ])
    .start();
  const connectionString = container.getConnectionUri();
  const { db, pool } = buildDrizzle(connectionString);
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
  return {
    connectionString,
    stop: async () => {
      await container.stop();
    },
  };
}

// ─── per-test 隔离：批量 TRUNCATE 优化 ───────────────────────────

/** worker 进程内表名缓存（migration 完成后表结构固定，SHOW TABLES 只跑一次）。 */
let cachedTableNames: string[] | null = null;

/** reset 专用连接池（启用 multipleStatements），懒加载，所有测试共享。 */
let resetPool: mysql.Pool | null = null;

function getResetPool(): mysql.Pool {
  if (resetPool) return resetPool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL 未注入（globalSetup 未运行？）");
  }
  resetPool = mysql.createPool({ uri: url, multipleStatements: true });
  return resetPool;
}

/**
 * 清空所有业务表（per-test 隔离）。
 *
 * 性能要点：
 * - 第一次调用时通过 SHOW TABLES 取表名并缓存到 worker 进程内，后续测试直接复用。
 * - 用启用 multipleStatements 的专用连接池，把 FOREIGN_KEY_CHECKS 开关 + 60+ 条 TRUNCATE
 *   拼成一条 SQL 一次往返执行；配合 container 启动参数关闭 binlog/flush/file-per-table，
 *   实测 94 表 TRUNCATE 从 ~12s 降到 1-2s。
 *
 * @param db 仅用于首次取表名；后续重置走专用 multipleStatements 池，不占用业务池连接。
 */
export async function resetDatabase(db: ReturnType<typeof buildDrizzle>["db"]): Promise<void> {
  // 1. 取表名（worker 进程内缓存，避免每 test 一次 SHOW TABLES 往返）。
  let names = cachedTableNames;
  if (!names) {
    const [rows] = (await db.execute("SHOW TABLES")) as unknown as [Record<string, string>[]];
    names = rows.map((r) => String(Object.values(r)[0])).filter((n) => !n.startsWith("__"));
    cachedTableNames = names;
  }

  // 2. 一次性执行：关外键检查 → 批量 TRUNCATE → 恢复（multipleStatements，一条 SQL）。
  //    binlog 已在 container 启动时通过 --disable-log-bin 全局关闭，无需 session 级 sql_log_bin=0
  //    （testcontainers root 用户无 SUPER/SYSTEM_VARIABLES_ADMIN 权限设 session 变量）。
  const truncateSQL = `SET FOREIGN_KEY_CHECKS = 0; ${names.map((n) => `TRUNCATE TABLE \`${n}\`;`).join(" ")} SET FOREIGN_KEY_CHECKS = 1;`;
  const pool = getResetPool();
  await pool.query(truncateSQL);
}
