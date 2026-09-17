/**
 * EnvironmentLease 清理 Worker（常驻进程入口）。
 *
 * 为什么必须是独立常驻进程（repairs/06-environment.md §5）：
 * provision / prepared / activation 失败、Owner 丢失、Invocation terminal 都会把
 * 真实已创建的资源登记为 `releasing` 的持久清理工作。控制面 `released` 只在**真实释放回执**
 * 之后才允许写，因此必须有一个不依赖请求生命周期、可退避重试的执行者。
 *
 * 与 `scripts/workers/workspace-host.ts` 同构：独立进程入口，不占用
 * `CANONICAL_PRODUCTION_ROLES`（那是 Durable Worker 的角色集合，本进程是资源侧执行器）。
 */
import { createDefaultEnvironmentInstanceBackend } from "@/lib/environment/environment-instance-backend";
import { runDueEnvironmentLeaseCleanups } from "@/lib/environment/environment-provisioner";
import { logger } from "@/lib/logger";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createEnvironmentCleanupServiceFromEnvironment() {
  const backend = createDefaultEnvironmentInstanceBackend({
    runtimeType:
      process.env.SNOWHARNESS_ENVIRONMENT_BACKEND === "host_agent" ? "host" : "container",
    ...(process.env.SNOWHARNESS_ENVIRONMENT_CONTROL_ROOT
      ? { controlRoot: process.env.SNOWHARNESS_ENVIRONMENT_CONTROL_ROOT }
      : {}),
  });
  const owner = `environment-cleanup:${process.env.HOSTNAME ?? "localhost"}:${process.pid}`;
  const intervalMs = positiveInt(process.env.SNOWHARNESS_ENVIRONMENT_CLEANUP_INTERVAL_MS, 5_000);
  const limit = positiveInt(process.env.SNOWHARNESS_ENVIRONMENT_CLEANUP_BATCH, 20);
  return { backend, owner, intervalMs, limit };
}

/** 单轮：扫描到期的 `releasing` Lease 并真实释放。 */
export async function runEnvironmentCleanupOnce(input?: {
  limit?: number;
}): Promise<{ scanned: number; released: number; pendingRetry: number }> {
  const service = createEnvironmentCleanupServiceFromEnvironment();
  return runDueEnvironmentLeaseCleanups({
    backend: service.backend,
    owner: service.owner,
    limit: input?.limit ?? service.limit,
  });
}

export async function runEnvironmentLeaseCleanupProcess(): Promise<void> {
  const service = createEnvironmentCleanupServiceFromEnvironment();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdout.write(
    `[environment-lease-cleanup] 启动 backend=${service.backend.kind} interval=${service.intervalMs}ms\n`,
  );
  while (!stopping) {
    try {
      const outcome = await runDueEnvironmentLeaseCleanups({
        backend: service.backend,
        owner: service.owner,
        limit: service.limit,
      });
      if (outcome.scanned > 0) {
        logger.info("[environment-lease-cleanup] 清理一轮", outcome);
      }
    } catch (error) {
      // 单轮失败不终止进程：Lease 仍处于 `releasing`，下一轮按退避重试。
      logger.error("[environment-lease-cleanup] 清理失败", { error: String(error) });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, service.intervalMs));
  }
  process.stdout.write("[environment-lease-cleanup] 已停止\n");
}

if (process.argv[1]?.endsWith("environment-lease-cleanup.ts")) {
  runEnvironmentLeaseCleanupProcess().catch((error) => {
    console.error("[environment-lease-cleanup] 启动失败", error);
    process.exitCode = 1;
  });
}
