/**
 * Control Plane Outbox Worker — 独立进程入口。
 *
 * 不依赖 Next.js 请求生命周期。
 * 用法: pnpm worker:control-plane-outbox
 */

import { createOutboxRelayWorker } from "@/lib/control-plane/events/outbox-relay-worker";
import { createBuildRouteEligibility } from "@/lib/routes/projection/build-route-eligibility";
import { mysqlRouteEligibilityStore } from "@/lib/routes/projection/mysql-route-eligibility-store";
import { mysqlRouteEligibilitySourceReader } from "@/lib/routes/projection/mysql-route-eligibility-source-reader";
import { createProjectionEventHandler } from "@/lib/routes/projection/projection-event-handlers";

const buildRouteEligibility = createBuildRouteEligibility({
  store: mysqlRouteEligibilityStore,
});

const handler = createProjectionEventHandler({
  store: mysqlRouteEligibilityStore,
  sourceReader: mysqlRouteEligibilitySourceReader,
  buildRouteEligibility,
});

const worker = createOutboxRelayWorker(handler);

// 优雅关闭
process.on("SIGTERM", () => {
  worker.stop();
});

process.on("SIGINT", () => {
  worker.stop();
});

worker.start().catch((error) => {
  console.error("[control-plane-outbox-worker] 启动失败:", error);
  process.exit(1);
});
