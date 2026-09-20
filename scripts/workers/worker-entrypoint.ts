import { runConfiguredWorkerProcess } from "@/lib/workers/worker-environment";

runConfiguredWorkerProcess().catch((error) => {
  console.error("[worker-entrypoint] 启动失败", error);
  process.exitCode = 1;
});
