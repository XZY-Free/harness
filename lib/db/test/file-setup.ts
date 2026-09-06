import { closeDbPool } from "@/lib/db/client";
import { closeTestMysqlPools } from "@/lib/db/test/mysql-harness";
import { afterAll } from "vitest";

/**
 * DB project 的文件级资源清理。
 *
 * Vitest 默认按文件隔离模块上下文；每个文件都会各自加载业务 DB client
 * 与 reset pool，因此必须在文件结束时显式释放两类连接，不能依赖进程退出。
 */
afterAll(async () => {
  await closeTestMysqlPools();
  await closeDbPool();
});
