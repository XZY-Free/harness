/**
 * A03 测试支持：**真实** Hosted Supervisor 子进程（FILE-089）。
 *
 * 存在的理由只有一个：A03 的核心断言是"两个**进程**各自读到同一 active Owner/Session 时，
 * 只能有一个成为执行者"。用两份模块实例或注入 `proc-a`/`proc-b` 都替代不了它：
 *
 * - 模块实例共享同一进程的 `globalThis`（实例身份、`liveRunners` 都在那里），
 *   并不能证明"跨进程身份与领取"；
 * - 注入实例 id 就把"生产默认身份"从被测对象里摘掉了 —— 而被修复的缺陷恰好是
 *   **默认身份本身**（`pid:<pid>` 在容器里会碰撞）。
 *
 * 因此这里的子进程**不注入实例身份**：它调用的就是生产默认工厂
 * （`createConfiguredHostedRuntimeApplicationService`），实例身份由
 * `workerInstanceId()` 在子进程里按进程启动生成。唯一被压到测试尺度的是等待窗口。
 *
 * 子进程只在 stdout 输出一行一个的 JSON 事件，父测试据此得到**每个进程自己观察到的**
 * 事实（PID、实例 id、动作执行次数、决策次数）。动作执行次数是关键判据：
 * 执行器只会被"真正在跑的 Loop"调用，所以它是"这个进程里是否真有一个执行者"的
 * 行为证据，而不是对某个辅助函数的 spy 计数。
 *
 * 被固定成同一个实例身份（`fixedInstanceId`）的那条路径只用于**反向对照**：
 * 复现"两个容器 PID 相同 ⇒ 身份字符串相同"的形态，断言此时仍然只有一方执行。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 子进程入口标记：只有带上它才执行真实的 Supervisor，避免被当作普通 import。 */
const ENTRY_FLAG = "--supervisor-process-entry";

export interface SupervisorProcessConfig {
  tenantId: string;
  invocationId: string;
  authority: {
    invocationId: string;
    runtimeRevisionId: string;
    attemptId: string;
    ownershipId: string;
    leaseEpoch: string;
    sessionBindingId: string;
  };
  /** 被等待的在途子调用动作 id（与父测试种下的 Ledger 事实一致）。 */
  inFlightActionId: string;
  leaseMs: number;
  renewIntervalMs: number;
  pendingPollIntervalMs: number;
  pendingWaitLimitMs: number;
  loopWindowMs: number;
  /**
   * 仅反向对照使用：把实例身份固定成给定字符串，用来复现"PID 相同导致身份碰撞"。
   * 生产默认路径**不得**设置它。
   */
  fixedInstanceId?: string;
}

/** 子进程自报的观察事实（全部来自它自己的运行，不是父进程的推测）。 */
export interface SupervisorProcessReport {
  pid: number;
  instanceId: string;
  startStatus: string | null;
  /** 本进程内真实执行器被调用次数 —— 直接反映"这里是否有一个在跑的执行者"。 */
  actionExecutions: number;
  /** 本进程内决策端口被调用次数 —— 在途子调用未终态时必须是 0。 */
  decisionCalls: number;
  error: string | null;
}

export interface SupervisorProcessHandle {
  pid: number;
  /**
   * 就绪事实：子进程已经起来，并且**它自报的身份**正是父测试要用的那份。
   *
   * 反向对照（"两个容器 PID 相同 ⇒ 身份字符串相同"）必须先拿到发起方的身份，
   * 才能构造出"完全相同"的第二份身份；因此就绪与收敛是两个不同的等待点。
   */
  ready: Promise<{ pid: number; instanceId: string }>;
  /** 进程退出后解析出的报告。 */
  report: Promise<SupervisorProcessReport>;
  stderr: () => string;
  kill: (signal?: NodeJS.Signals) => void;
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * 子进程主入口。仅在带 `ENTRY_FLAG` 时执行（见文件末尾的守卫）。
 */
async function runSupervisorProcessEntry(config: SupervisorProcessConfig): Promise<void> {
  const { closeDbPool } = await import("@/lib/db/client");
  const { workerInstanceId } = await import("@/lib/workers/worker-instance-identity");
  const { createConfiguredHostedRuntimeApplicationService } = await import(
    "@/lib/runtime/application/runtime-resume"
  );
  const instanceId = workerInstanceId();
  let actionExecutions = 0;
  let decisionCalls = 0;

  const service = createConfiguredHostedRuntimeApplicationService({
    decisionPort: {
      async decideNextAction() {
        decisionCalls += 1;
        // 在途子调用未终态时进入决策就是重复决策：让它在报告里可见，而不是静默通过。
        throw new Error("A03 夹具：在途子调用未终态，不得进入决策");
      },
    },
    finalResponsePort: {
      async generateFinalResponse() {
        return "";
      },
    },
    actionExecutors: {
      "tool.call": async () => {
        actionExecutions += 1;
        return {
          authorityRef: `tool-call:${config.inFlightActionId}`,
          pending: {
            kind: "tool_call" as const,
            callId: config.inFlightActionId,
            state: "running" as const,
          },
        };
      },
    },
    transientEventBatchSink: async () => undefined,
    supervisor: {
      leaseMs: config.leaseMs,
      renewIntervalMs: config.renewIntervalMs,
      pendingPollIntervalMs: config.pendingPollIntervalMs,
      pendingWaitLimitMs: config.pendingWaitLimitMs,
      loopWindowMs: config.loopWindowMs,
      // 生产默认路径不传：实例身份由本进程启动时生成。反向对照才固定它。
      ...(config.fixedInstanceId ? { instanceId: config.fixedInstanceId } : {}),
    },
  });

  // 就绪行：父测试据此确认"这个真实进程已经起来并且用的是哪份身份"。
  emit({ event: "ready", pid: process.pid, instanceId });

  // 看门狗：子进程"起来了但一直不收敛"时，父测试只能看到超时，看不到它卡在**什么**上。
  // 这里周期性自报仍然活跃的资源类型（socket / timer / 文件句柄），把"卡在等待里"
  // 变成可观测事实；`unref()` 保证它自己不会拖住进程退出。
  let watchdogTicks = 0;
  const watchdog = setInterval(() => {
    watchdogTicks += 1;
    emit({
      event: "alive",
      pid: process.pid,
      ticks: watchdogTicks,
      resources: process.getActiveResourcesInfo(),
    });
  }, 5_000);
  watchdog.unref();

  let startStatus: string | null = null;
  let error: string | null = null;
  try {
    const result = await service.start({
      tenantId: config.tenantId,
      invocationId: config.invocationId,
      idempotencyKey: `start:${config.authority.ownershipId}`,
      authority: config.authority,
    });
    startStatus = result.status;
  } catch (cause) {
    error = cause instanceof Error ? `${cause.name}:${cause.message}` : String(cause);
  } finally {
    // 子进程必须**显式**关掉数据库连接池才能退出：报告由父进程消费，而父进程是在
    // `exit` 事件上解析报告的（见 `spawnSupervisorProcess`）。mysql2 的连接 socket 是
    // ref'd 句柄，只要池还开着，事件循环就永远有活干 —— 一个**已经完成任务**的子进程
    // 会永远不退出，父测试只能看到超时，把"完成"误判成"卡死"。
    // 先关池再发报告：这样 emit 之后仅剩 stdout 管道，进程在刷写完成后自然退出。
    await closeDbPool().catch(() => undefined);
  }
  emit({
    event: "settled",
    pid: process.pid,
    instanceId,
    startStatus,
    actionExecutions,
    decisionCalls,
    error,
  });
}

/**
 * 拉起一个**真实** Supervisor 进程。
 *
 * 环境完全继承父进程（`DATABASE_URL`、身份夹具开关、`SNOWHARNESS_*` 签名密钥都在里面），
 * 因此子进程连的是同一个真实 MySQL —— 它和父测试共享的只有数据库，这正是要证明的边界。
 */
export async function spawnSupervisorProcess(
  config: SupervisorProcessConfig,
  options: { timeoutMs?: number } = {},
): Promise<SupervisorProcessHandle> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ENTRY_FLAG, JSON.stringify(config)],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error("Supervisor 子进程未返回 PID");

  let stdout = "";
  let stderr = "";
  let readyResolve: (value: { pid: number; instanceId: string }) => void;
  const ready = new Promise<{ pid: number; instanceId: string }>((resolve) => {
    readyResolve = resolve;
  });
  const report = new Promise<SupervisorProcessReport>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Supervisor 子进程 ${pid} 在 ${timeoutMs}ms 内未收敛` +
            `（stdout=${stdout.trim() || "<empty>"} stderr=${stderr.trim() || "<empty>"}）`,
        ),
      );
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed.event === "ready") {
          readyResolve({ pid: Number(parsed.pid), instanceId: String(parsed.instanceId) });
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const settledLine = stdout
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((parsed): parsed is Record<string, unknown> => parsed !== null)
        .findLast((parsed) => parsed.event === "settled");
      if (!settledLine) {
        reject(
          new Error(
            `Supervisor 子进程 ${pid} 退出（code=${code}）但没有报告收敛结果；stderr=${stderr || "<empty>"}`,
          ),
        );
        return;
      }
      resolve({
        pid: Number(settledLine.pid),
        instanceId: String(settledLine.instanceId),
        startStatus: settledLine.startStatus === null ? null : String(settledLine.startStatus),
        actionExecutions: Number(settledLine.actionExecutions),
        decisionCalls: Number(settledLine.decisionCalls),
        error: settledLine.error === null ? null : String(settledLine.error),
      });
    });
  });

  // 就绪是"进程真的起来了"的证据；收敛结果才是断言对象。两者都不能吞掉失败。
  await Promise.race([ready, report.then(() => undefined)]);
  return {
    pid,
    ready,
    report,
    stderr: () => stderr,
    kill: (signal: NodeJS.Signals = "SIGKILL") => {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    },
  };
}

if (process.argv.includes(ENTRY_FLAG)) {
  const payload = process.argv[process.argv.indexOf(ENTRY_FLAG) + 1];
  if (!payload) {
    process.stderr.write("缺少 Supervisor 子进程配置\n");
    process.exit(2);
  }
  // 这里刻意**不使用顶层 await**：本文件由 `--import tsx` 直接执行，而 tsx 在该解析模式下
  // 产出 CJS，esbuild 会以 "Top-level await is currently not supported with the cjs output
  // format" 拒绝装载 —— 子进程会在跑到业务代码之前就崩掉，父测试只能看到"退出但没有报告"。
  // 改为显式 promise 链，并把失败变成非零退出码 + stderr，让真实原因可见。
  runSupervisorProcessEntry(JSON.parse(payload) as SupervisorProcessConfig).catch(
    (cause: unknown) => {
      process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
      process.exit(1);
    },
  );
}
