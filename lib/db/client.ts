import { dbConfig } from "@/lib/config";
import * as schema from "@/lib/persistence/schema";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

/**
 * 外部 MySQL + Drizzle（mysql2 驱动）。
 *
 * 数据库结构只由 drizzle-kit migration 管理（db:migrate）。
 *
 * - 应用启动不执行动态建表。
 * - 连接池与 migration 生命周期由 drizzle-kit + 应用启动时 db:migrate 脚本负责
 *
 * 用 globalThis 缓存连接池，避免 Next.js 开发模式热重载反复建池。
 */

const connectionString =
  dbConfig.url || "mysql://build-placeholder:build-placeholder@127.0.0.1:3306/placeholder";

// 连接池参数可配置（原仅用连接串默认 connectionLimit=10）。
const poolOptions: mysql.PoolOptions = {
  connectionLimit: Number.parseInt(process.env.SNOW_DB_CONNECTION_LIMIT ?? "10", 10),
  waitForConnections: true,
  queueLimit: Number.parseInt(process.env.SNOW_DB_QUEUE_LIMIT ?? "100", 10),
  // BIGINT 的 DB→driver 边界必须保留十进制原文；默认 Number 会在 2^53 后舍入。
  supportBigNumbers: true,
  // 安全整数仍按 Number 返回（COUNT(*) 等旧调用方依赖此类型）；超出安全范围才返回字符串。
  bigNumberStrings: false,
};

const globalForDb = globalThis as unknown as {
  __snowMysqlPool?: mysql.Pool;
};

const pool =
  globalForDb.__snowMysqlPool ?? mysql.createPool({ uri: connectionString, ...poolOptions });
if (!globalForDb.__snowMysqlPool) {
  globalForDb.__snowMysqlPool = pool;
}

export const db = drizzle(pool, { schema, mode: "default" });

/** 迁移的 MySQL 命名锁与 DDL 必须共用同一条物理连接。 */
export async function openMigrationConnection(): Promise<mysql.PoolConnection> {
  return pool.getConnection();
}

/** 关闭当前测试文件的业务连接池，避免 Vitest 文件隔离造成连接池累积。 */
export async function closeDbPool(): Promise<void> {
  const currentPool = globalForDb.__snowMysqlPool;
  if (!currentPool) return;
  globalForDb.__snowMysqlPool = undefined;
  await currentPool.end();
}

/**
 * DB 或事务的公共查询接口类型。
 *
 * Drizzle 的 MySqlTransaction 和 MySql2Database 共享 .select()/.from()/.where()
 * 等查询构建器方法，但 TypeScript 类型系统未建立继承关系（Transaction 缺少 $client）。
 * 运行时两者完全兼容 — 所有需要事务内读取的 Reader 均应使用此类型。
 */
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
