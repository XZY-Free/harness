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
 * 5. 维护 lane：Checkpoint Gate 的 `stuck gate` 与 `releasing 资源` 收口（R05 §5 / R09 §2 步骤 8）
 * 6. sleep poll interval
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
import { runDueUndispatchedIntentRecoveries } from "@/lib/runtime/retry/undispatched-intent-lane";
import {
  type CheckpointReleaseRecoveryReport,
  type StuckCheckpointGateReport,
  runCheckpointMaintenanceLane,
} from "@/lib/workspace/checkpoint-release";
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
  /** 维护 lane 覆盖（测试注入）：Checkpoint Gate 的 stuck gate / releasing 资源收口。 */
  runCheckpointMaintenance?: () => Promise<{
    stuckGates: StuckCheckpointGateReport;
    releases: CheckpointReleaseRecoveryReport;
  }>;
  /** 维护 lane 覆盖（测试注入）：半程意图（accepted Turn / 无 Session 的 Invocation）恢复。 */
  recoverUndispatchedIntents?: typeof runDueUndispatchedIntentRecoveries;
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
    /** 本轮收口的 stuck Checkpoint Gate 数。 */
    stuckCheckpointGates: number;
    /** 本轮收口的 Checkpoint 解冻行数（Backend 腿 + 据实关闭的 Runtime 腿）。 */
    checkpointReleases: number;
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
  const runCheckpointMaintenance =
    deps.runCheckpointMaintenance ?? (() => runCheckpointMaintenanceLane({ limit: batchSize }));
  const recoverUndispatchedIntents =
    deps.recoverUndispatchedIntents ??
    ((input: { now: Date; batchSize: number }) => runDueUndispatchedIntentRecoveries(input));

  async function tick(): Promise<{
    attempts: number;
    commands: number;
    writerReleases: number;
    ownerRecoveries: number;
    stuckCheckpointGates: number;
    checkpointReleases: number;
    undispatchedTurns: number;
    undispatchedInvocations: number;
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

    // 维护 lane（R05 §5 `stuck gate` + `releasing 资源`；R09 §2 步骤 8）。
    // 这一步是"解冻不能只在 finally 里做"的生产承载点：安全点请求后 Crash 会留下
    // 被持有的 Gate，Checkpoint 提交后 Crash 会留下未确认的解冻两条腿，二者都必须
    // 由持久维护 lane 续做，而不是依赖进程内异常处理。
    let stuckCheckpointGates = 0;
    let checkpointReleases = 0;
    try {
      const summary = await runCheckpointMaintenance();
      stuckCheckpointGates = summary.stuckGates.abandoned;
      checkpointReleases = summary.releases.backendReleased + summary.releases.runtimeClosed;
    } catch (error) {
      logger.error("[runtime-dispatch-retry-worker] Checkpoint 维护 lane 失败", {
        error: String(error),
      });
    }

    // 维护 lane（R01 §3 半程意图）：Turn 已 accepted 而无 Invocation，以及 Invocation
    // 已 queued 但没有任何 Session/Owner（进程死在 Session 写入之前）—— 这两类状态
    // 在本次修复前没有任何发现者，会永久停在半程（客户端永远看不到终态）。
    let undispatchedTurns = 0;
    let undispatchedInvocations = 0;
    try {
      const summary = await recoverUndispatchedIntents({ now: clock(), batchSize });
      undispatchedTurns = summary.turns.recovered;
      undispatchedInvocations = summary.invocations.recovered;
    } catch (error) {
      logger.error("[runtime-dispatch-retry-worker] 半程意图恢复 lane 失败", {
        error: String(error),
      });
    }

    return {
      attempts,
      commands,
      writerReleases,
      ownerRecoveries,
      stuckCheckpointGates,
      checkpointReleases,
      undispatchedTurns,
      undispatchedInvocations,
    };
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
