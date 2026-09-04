import { runProductionWorkerProcess } from "@/lib/workers/production-worker-process";

runProductionWorkerProcess("tool-execution-worker").catch((error) => {
  console.error("[tool-execution-worker] 启动失败:", error);
  process.exitCode = 1;
});
