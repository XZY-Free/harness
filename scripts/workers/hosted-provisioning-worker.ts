/**
 * Hosted Provisioning Worker — 独立进程入口。
 *
 * 不依赖 Next.js 请求生命周期。
 * 用法: pnpm worker:hosted-provisioning
 */

import { createHostedProvisioningWorker } from "@/lib/runtimes/application/hosted-provisioning-worker";

const worker = createHostedProvisioningWorker();

// 优雅关闭
process.on("SIGTERM", () => {
  worker.stop();
});

process.on("SIGINT", () => {
  worker.stop();
});

worker.start().catch((error) => {
  console.error("[hosted-provisioning-worker] 启动失败:", error);
  process.exit(1);
});
