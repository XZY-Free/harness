import { runConfiguredWorkerProcess } from "@/lib/workers/worker-environment";

runConfiguredWorkerProcess("tool-execution-worker").catch((error) => {
  console.error("[tool-execution-worker] 启动失败:", error);
  process.exitCode = 1;
});
