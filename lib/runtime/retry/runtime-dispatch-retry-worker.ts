/**
 * Runtime Dispatch Retry Worker（Durable Dispatch / Retry Authority 的唯一执行 Owner）。
 *
 * 事实源：
 * - docs/architecture/runtime-control-plane.md
 *
 * 每轮：
 * 1. 扫描到期 Session dispatch（只取候选 ID）→ 领取 → dispatchPersistedQueuedInvocationAttempt
 * 2. 扫描到期 InvocationCommand（只取候选 ID）→ 领取 → retryDispatchedCommandToRuntime
 * 3. 维护 lane：Workspace Writer 物理释放与 W 行收口（R04 §3）
 * 4. 维护 lane：租约已到期的 Owner 收口（R01 §3 `Owner expired` / R04 §5）
 * 5. sleep poll interval
 *
 * 关键约束：
 * - 各 lane 共享 Policy / lease 原语；不造第二个 Worker。
 * - 网络调用在 DB transaction 之外（claim 事务先提交）。
 * - workerId 仅用于 lease owner，不是安全 Principal，不写业务 Event。
 * - 时钟可注入（测试 fake clock）。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { logger } from "@/lib/logger";
import type { InvocationCommand } from "@/lib/persistence/schema/executions";
import {
  type AuthorityRecoverySummary,
  runDueExpiredOwnerRecoveries,
} from "@/lib/runtime/application/authority-recovery-lane";
import { retryDispatchedCommandToRuntime } from "@/lib/runtime/command-dispatch-gateway";
import { dispatchPersistedQueuedInvocationAttempt } from "@/lib/runtime/retry/dispatch-persisted-queued-invocation-attempt";
import {
  type SessionDispatchClaim,
  claimInvocationCommandDispatch,
  claimSessionDispatch,
  scanDueInvocationCommandDispatches,
  scanDueSessionDispatches,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import {
  type DispatchClock,
  RUNTIME_DISPATCH_RETRY_POLICY,
  realDispatchClock,
} from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import { runDueWorkspaceWriterReleases } from "@/lib/workspace/workspace-writer-release";

/** Worker 依赖（可注入用于测试）。 */
export interface RuntimeDispatchRetryWorkerDeps {
  clock?: DispatchClock;
  pollIntervalMs?: number;
  workerId?: string;
  /** Session dispatch lane 覆盖（测试注入）。 */
  dispatchAttempt?: (claim: SessionDispatchClaim) => Promise<void>;
  /** canonical persisted Attempt service 覆盖（验证默认 lane 接线）。 */
  dispatchPersistedAttempt?: (claim: SessionDispatchClaim) => Promise<unknown>;
  /** Command lane 覆盖（测试注入）。 */
  dispatchCommand?: (command: InvocationCommand, claimToken: string) => Promise<void>;
  /** 维护 lane 覆盖（测试注入）：Workspace Writer 物理释放。 */
  releaseWorkspaceWriters?: () => Promise<{
    scanned: number;
    released: number;
    superseded: number;
    retried: number;
    skipped: number;
  }>;
  /** 维护 lane 覆盖（测试注入）：租约到期的 Owner 收口。 */
  recoverExpiredOwners?: () => Promise<AuthorityRecoverySummary>;
  /** 单轮处理上限覆盖。 */
  batchSize?: number;
}

/** Worker 句柄。 */
export interface RuntimeDispatchRetryWorker {
  start(): Promise<void>;
  stop(): void;
  /** 执行一轮（测试可单独调用）。 */
  tick(): Promise<{
    attempts: number;
    commands: number;
    writerReleases: number;
    ownerRecoveries: number;
  }>;
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

  /** 默认 Session dispatch lane：从持久化 Authority 重建 transport 并 dispatch 同一 Session。 */
  const persistedAttemptDispatcher =
    deps.dispatchPersistedAttempt ?? dispatchPersistedQueuedInvocationAttempt;
  const defaultDispatchAttempt = async (claim: SessionDispatchClaim): Promise<void> => {
    await persistedAttemptDispatcher(claim);
  };

  /** 默认 Command lane：经命令网关 retry 入口（同一 idempotency key + claim 身份）。 */
  const defaultDispatchCommand = async (command: InvocationCommand, claimToken: string) => {
    await retryDispatchedCommandToRuntime({
      tenantId: command.tenantId,
      commandId: command.id,
      claimToken,
    });
  };

  const dispatchAttempt = deps.dispatchAttempt ?? defaultDispatchAttempt;
  const dispatchCommand = deps.dispatchCommand ?? defaultDispatchCommand;
  const releaseWorkspaceWriters =
    deps.releaseWorkspaceWriters ??
    (() => runDueWorkspaceWriterReleases({ leaseOwner: workerId, limit: batchSize }));
  const recoverExpiredOwners =
    deps.recoverExpiredOwners ?? (() => runDueExpiredOwnerRecoveries({ limit: batchSize }));

  async function tick(): Promise<{
    attempts: number;
    commands: number;
    writerReleases: number;
    ownerRecoveries: number;
  }> {
    const now = clock();
    // 扫描只取候选 ID；每条工作在自己的领取事务里按对象自身根重新验证 due/state/lease。
    const attemptCandidates = await scanDueSessionDispatches({ now, limit: batchSize });
    let attempts = 0;
    for (const candidate of attemptCandidates) {
      const claim = await claimSessionDispatch({
        sessionBindingId: candidate.sessionBindingId,
        attemptId: candidate.attemptId,
        leaseOwner: workerId,
        leaseDurationMs: RUNTIME_DISPATCH_RETRY_POLICY.leaseDurationMs,
        now: clock(),
      });
      if (!claim) continue;
      attempts += 1;
      try {
        await dispatchAttempt(claim);
      } catch (error) {
        // 单个 work 失败不阻断本轮其余 work；lease 过期后可被接管重试。
        logger.error("[runtime-dispatch-retry-worker] Session dispatch 失败", {
          sessionBindingId: claim.sessionBindingId,
          attemptId: claim.attemptId,
          error: String(error),
        });
      }
    }

    const commandCandidates = await scanDueInvocationCommandDispatches({
      now: clock(),
      limit: batchSize,
    });
    let commands = 0;
    for (const commandId of commandCandidates) {
      const claim = await claimInvocationCommandDispatch({
        commandId,
        leaseOwner: workerId,
        leaseDurationMs: RUNTIME_DISPATCH_RETRY_POLICY.leaseDurationMs,
        now: clock(),
      });
      if (!claim) continue;
      commands += 1;
      try {
        await dispatchCommand(claim.command, claim.claimToken);
      } catch (error) {
        logger.error("[runtime-dispatch-retry-worker] Command retry 失败", {
          commandId: claim.command.id,
          error: String(error),
        });
      }
    }

    // 维护 lane（R04 §3）：Workspace Writer 的物理 stop/drain 与 W 行收口。
    // 单个 work 失败不阻断本轮其余 lane；领取权过期后可被其他 Worker 接管。
    let writerReleases = 0;
    try {
      const summary = await releaseWorkspaceWriters();
      writerReleases = summary.scanned;
    } catch (error) {
      logger.error("[runtime-dispatch-retry-worker] Workspace Writer 释放 lane 失败", {
        error: String(error),
      });
    }

    // 维护 lane（R01 §3 `Owner expired`）：租约已到期的 Owner 由持久发现者收口。
    // 陈旧观察（续租/换代）在根锁内被丢弃，不误杀新 Owner（R03 §5）。
    let ownerRecoveries = 0;
    try {
      const summary = await recoverExpiredOwners();
      ownerRecoveries = summary.recovered;
    } catch (error) {
      logger.error("[runtime-dispatch-retry-worker] Owner 过期收口 lane 失败", {
        error: String(error),
      });
    }

    return { attempts, commands, writerReleases, ownerRecoveries };
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
