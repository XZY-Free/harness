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

/**
 * Workload Token 测试签名密钥（§26：≥ 32 字节、独立随机）。
 *
 * 仅测试运行期注入；生产/真实环境必须由部署方配置独立随机 Secret。
 * globalSetup 对全部 project 只跑一次，故 unit 与 db 测试共享同一密钥。
 */
const TEST_WORKLOAD_TOKEN_SIGNING_SECRET = "snow-harness-test-signing-secret-0000-abcdef0123456789";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const { connectionString, stop } = await startTestMysql();
  process.env.DATABASE_URL = connectionString;
  process.env.SNOWHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET = TEST_WORKLOAD_TOKEN_SIGNING_SECRET;
  console.log("[global-setup] DATABASE_URL =", connectionString);
  return stop;
}
