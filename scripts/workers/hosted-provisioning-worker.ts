/**
 * Hosted Provisioning Worker — 独立进程入口。
 *
 * 不依赖 Next.js 请求生命周期。
 * 用法: pnpm worker:hosted-provisioning
 */

import { runProductionWorkerProcess } from "@/lib/workers/production-worker-process";

runProductionWorkerProcess("hosted-provisioning-worker").catch((error) => {
  console.error("[hosted-provisioning-worker] 启动失败:", error);
  process.exitCode = 1;
});
