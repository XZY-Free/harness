/**
 * Runtime Dispatch Retry Worker — 独立进程入口（Durable Dispatch / Retry Authority）。
 *
 * 不依赖 Next.js 请求生命周期。
 * 用法: pnpm worker:runtime-dispatch-retry
 */

import { createRuntimeDispatchRetryWorker } from "@/lib/runtime/retry/runtime-dispatch-retry-worker";

const worker = createRuntimeDispatchRetryWorker();

// 优雅关闭
process.on("SIGTERM", () => {
  worker.stop();
});

process.on("SIGINT", () => {
  worker.stop();
});

worker.start().catch((error) => {
  console.error("[runtime-dispatch-retry-worker] 启动失败:", error);
  process.exit(1);
});
