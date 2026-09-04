import { runProductionWorkerProcess } from "@/lib/workers/production-worker-process";

runProductionWorkerProcess().catch((error) => {
  console.error("[worker-entrypoint] 启动失败", error);
  process.exitCode = 1;
});
