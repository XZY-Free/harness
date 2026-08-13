/**
 * S1（08 同构）：vitest globalSetup。
 *
 * 启动真实 MySQL 8 容器 + 跑 drizzle migration，把连接串写入 process.env.DATABASE_URL。
 * db client（lib/db/client.ts）在 worker 进程 import 时读 env 建池，连同一 container。
 * 测试结束（teardown）时停止容器。
 *
 * vitest 不加载 .env.test，DATABASE_URL 仅由本 setup 注入，无占位串覆盖风险。
 */
import { startTestMysql } from "./mysql-harness";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const { connectionString, stop } = await startTestMysql();
  process.env.DATABASE_URL = connectionString;
  console.log("[global-setup] DATABASE_URL =", connectionString);
  return stop;
}
