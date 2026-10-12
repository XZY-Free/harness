import { admitQueuedJob, scanQueuedJobsWithoutInvocation } from "@/lib/job/job-admission";
import { runDueJobCommands } from "@/lib/job/job-command-lane";
/**
 * `job-worker` 角色（R01 §4）。
 *
 * 事实源：
 * - docs/topic02/nexharness-topic02-closure/repairs/01-production.md §3/§4
 *
 * 职责（只做这两件事，不造 Universal WorkItem）：
 * 1. Job admission lane —— `Job queued 无 Invocation` 的幂等接纳。
 * 2. JobCommand lane —— queued/waiting/dispatched(lease 过期) 的幂等领域消费。
 *
 * 与 `runtime-dispatch-retry-worker` 的分工：那个 Worker 负责 Executions 侧的
 * Attempt/Session/InvocationCommand 与 Workspace Writer 释放；本 Worker 只负责 Job 侧。
 * 两者都只是"发现 + 领取"，所有状态推进仍由各自领域的正式服务完成。
 */
import { logger } from "@/lib/logger";
import { generateDispatchRetryWorkerId } from "@/lib/runtime/retry/runtime-dispatch-retry-worker";

export interface JobWorkerDeps {
  workerId?: string;
  pollIntervalMs?: number;
  batchSize?: number;
  /** Command lease 时长（毫秒）。 */
  commandLeaseMs?: number;
  /** 单轮接纳 Job 的覆盖（测试注入）。 */
  admitJob?: typeof admitQueuedJob;
  /** 单轮命令消费的覆盖（测试注入）。 */
  consumeCommands?: typeof runDueJobCommands;
  /** 候选扫描覆盖（测试注入）。 */
  scanJobs?: typeof scanQueuedJobsWithoutInvocation;
}

export interface JobWorkerTickSummary {
  admittedJobs: number;
  skippedJobs: number;
  failedJobs: number;
  commandsScanned: number;
  commandsConsumed: number;
}

export interface JobWorker {
  pollOnce(): Promise<JobWorkerTickSummary>;
  stop(): void;
}

export function createJobWorker(deps: JobWorkerDeps = {}): JobWorker {
  const workerId = deps.workerId ?? `job-worker:${generateDispatchRetryWorkerId()}`;
  const batchSize = deps.batchSize ?? 20;
  const commandLeaseMs = deps.commandLeaseMs ?? 30_000;
  const admitJob = deps.admitJob ?? admitQueuedJob;
  const consumeCommands = deps.consumeCommands ?? runDueJobCommands;
  const scanJobs = deps.scanJobs ?? scanQueuedJobsWithoutInvocation;
  let stopped = false;

  return {
    async pollOnce(): Promise<JobWorkerTickSummary> {
      const summary: JobWorkerTickSummary = {
        admittedJobs: 0,
        skippedJobs: 0,
        failedJobs: 0,
        commandsScanned: 0,
        commandsConsumed: 0,
      };
      if (stopped) return summary;

      // 1. Job admission lane：单个 Job 失败不阻断其余 Job（下一个 tick 仍可发现它）。
      let candidates: Array<{ tenantId: string; jobId: string }> = [];
      try {
        candidates = await scanJobs({ limit: batchSize });
      } catch (error) {
        logger.error("[job-worker] Job 候选扫描失败", { error: String(error) });
      }
      for (const candidate of candidates) {
        try {
          const outcome = await admitJob(candidate);
          if (outcome.outcome === "admitted") summary.admittedJobs += 1;
          else summary.skippedJobs += 1;
        } catch (error) {
          summary.failedJobs += 1;
          logger.error("[job-worker] Job 接纳失败", {
            jobId: candidate.jobId,
            error: String(error),
          });
        }
      }

      // 2. JobCommand lane。
      try {
        const commands = await consumeCommands({
          leaseOwner: workerId,
          leaseDurationMs: commandLeaseMs,
          limit: batchSize,
        });
        summary.commandsScanned = commands.scanned;
        summary.commandsConsumed = commands.consumed;
      } catch (error) {
        logger.error("[job-worker] JobCommand lane 失败", { error: String(error) });
      }

      return summary;
    },
    stop() {
      stopped = true;
    },
  };
}
