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

/**
 * DB 或事务的公共查询接口类型。
 *
 * Drizzle 的 MySqlTransaction 和 MySql2Database 共享 .select()/.from()/.where()
 * 等查询构建器方法，但 TypeScript 类型系统未建立继承关系（Transaction 缺少 $client）。
 * 运行时两者完全兼容 — 所有需要事务内读取的 Reader 均应使用此类型。
 */
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
