/**
 * Runtime Dispatch Retry Worker（Durable Dispatch / Retry Authority 的唯一执行 Owner）。
 *
 * 事实源：
 * - docs/architecture/runtime-control-plane.md
 *
 * 每轮：
 * 1. claim due InvocationAttempts（FOR UPDATE SKIP LOCKED + lease）
 * 2. dispatchQueuedInvocationAttempt（同一 Attempt、稳定 idempotency key）
 * 3. claim due InvocationCommands（transient nextDispatchAt 到期 / lease 过期接管）
 * 4. retryDispatchedCommandToRuntime（同一 command idempotency key）
 * 5. sleep poll interval
 *
 * 关键约束：
 * - 两个 lane 共享 Policy / lease 原语；不造第二个 Worker。
 * - 网络调用在 DB transaction 之外（claim 事务先提交）。
 * - workerId 仅用于 lease owner，不是安全 Principal，不写业务 Event。
 * - 时钟可注入（测试 fake clock）。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { logger } from "@/lib/logger";
import type { InvocationCommand } from "@/lib/persistence/schema/conversation";
import { threadTable } from "@/lib/persistence/schema/conversation";
import type { InvocationAttempt } from "@/lib/persistence/schema/executions";
import { retryDispatchedCommandToRuntime } from "@/lib/runtime/command-dispatch-gateway";
import { dispatchPersistedQueuedInvocationAttempt } from "@/lib/runtime/retry/dispatch-persisted-queued-invocation-attempt";
import {
  claimDueInvocationAttempts,
  claimDueInvocationCommands,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import {
  type DispatchClock,
  RUNTIME_DISPATCH_RETRY_POLICY,
  realDispatchClock,
} from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import { eq } from "drizzle-orm";

/** Worker 依赖（可注入用于测试）。 */
export interface RuntimeDispatchRetryWorkerDeps {
  clock?: DispatchClock;
  pollIntervalMs?: number;
  workerId?: string;
  /** Attempt lane 覆盖（测试注入）。 */
  dispatchAttempt?: (attempt: InvocationAttempt) => Promise<void>;
  /** canonical persisted Attempt service 覆盖（验证默认 lane 接线）。 */
  dispatchPersistedAttempt?: (attemptId: string) => Promise<unknown>;
  /** Command lane 覆盖（测试注入）。 */
  dispatchCommand?: (command: InvocationCommand) => Promise<void>;
  /** 单轮处理上限覆盖。 */
  batchSize?: number;
}

/** Worker 句柄。 */
export interface RuntimeDispatchRetryWorker {
  start(): Promise<void>;
  stop(): void;
  /** 执行一轮（测试可单独调用）。 */
  tick(): Promise<{ attempts: number; commands: number }>;
}

/** 生成 Worker 身份：hostname:pid:random（仅 lease owner 语义）。 */
export function generateDispatchRetryWorkerId(): string {
  return `${typeof process !== "undefined" ? (process.env.HOSTNAME ?? "localhost") : "localhost"}:${typeof process !== "undefined" ? process.pid : 0}:${randomUUID().slice(0, 8)}`;
}

/**
 * 创建 Runtime Dispatch Retry Worker。
 *
 * 单实例进程内循环（setTimeout 轮询；不 monkey patch 全局 Date）。
 */
export function createRuntimeDispatchRetryWorker(
  deps: RuntimeDispatchRetryWorkerDeps = {},
): RuntimeDispatchRetryWorker {
  const clock = deps.clock ?? realDispatchClock;
  const pollIntervalMs = deps.pollIntervalMs ?? RUNTIME_DISPATCH_RETRY_POLICY.workerPollIntervalMs;
  const batchSize = deps.batchSize ?? RUNTIME_DISPATCH_RETRY_POLICY.batchSize;
  const workerId = deps.workerId ?? generateDispatchRetryWorkerId();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** 默认 Attempt lane：从持久化 Authority 重建 transport 并 dispatch 同一 Attempt。 */
  const persistedAttemptDispatcher =
    deps.dispatchPersistedAttempt ?? dispatchPersistedQueuedInvocationAttempt;
  const defaultDispatchAttempt = async (attempt: InvocationAttempt): Promise<void> => {
    await persistedAttemptDispatcher(attempt.id);
  };

  /** 默认 Command lane：经命令网关 retry 入口（同一 idempotency key + 能力复核）。 */
  const defaultDispatchCommand = async (command: InvocationCommand): Promise<void> => {
    const [thread] = await db
      .select({ tenantId: threadTable.tenantId })
      .from(threadTable)
      .where(eq(threadTable.id, command.threadId))
      .limit(1);
    if (!thread) {
      logger.warn("[runtime-dispatch-retry-worker] Command 关联 Thread 不存在", {
        commandId: command.id,
      });
      return;
    }
    await retryDispatchedCommandToRuntime({
      tenantId: thread.tenantId,
      commandId: command.id,
    });
  };

  const dispatchAttempt = deps.dispatchAttempt ?? defaultDispatchAttempt;
  const dispatchCommand = deps.dispatchCommand ?? defaultDispatchCommand;

  async function tick(): Promise<{ attempts: number; commands: number }> {
    const now = clock();
    const attempts = await claimDueInvocationAttempts({
      now,
      leaseOwner: workerId,
      leaseDurationMs: RUNTIME_DISPATCH_RETRY_POLICY.leaseDurationMs,
      limit: batchSize,
    });
    for (const attempt of attempts) {
      try {
        await dispatchAttempt(attempt);
      } catch (error) {
        // 单个 work 失败不阻断本轮其余 work；lease 过期后可被接管重试。
        logger.error("[runtime-dispatch-retry-worker] Attempt dispatch 失败", {
          attemptId: attempt.id,
          error: String(error),
        });
      }
    }

    const commands = await claimDueInvocationCommands({
      now: clock(),
      leaseOwner: workerId,
      leaseDurationMs: RUNTIME_DISPATCH_RETRY_POLICY.leaseDurationMs,
      limit: batchSize,
    });
    for (const command of commands) {
      try {
        await dispatchCommand(command);
      } catch (error) {
        logger.error("[runtime-dispatch-retry-worker] Command retry 失败", {
          commandId: command.id,
          error: String(error),
        });
      }
    }

    return { attempts: attempts.length, commands: commands.length };
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      await tick().catch((error) => {
        logger.error("[runtime-dispatch-retry-worker] tick 失败", { error: String(error) });
      });
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, pollIntervalMs);
      });
    }
  }

  return {
    async start() {
      stopped = false;
      void loop();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    tick,
  };
}
