/**
 * Control Plane Outbox Worker — 独立进程入口。
 *
 * 不依赖 Next.js 请求生命周期。
 * 用法: pnpm worker:control-plane-outbox
 */

import { runProductionWorkerProcess } from "@/lib/workers/production-worker-process";

runProductionWorkerProcess("control-plane-outbox-worker").catch((error) => {
  console.error("[control-plane-outbox-worker] 启动失败:", error);
  process.exitCode = 1;
});
