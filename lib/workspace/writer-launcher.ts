/**
 * A07 决策三：受管 Writer 的**启动屏障**——先登记、后放行。
 *
 * 顺序是契约的一部分（每一步的产物都是崩溃后可复用的持久事实）：
 *
 * ```text
 * 调用方持有 scope 内核锁并完成授权复核
 * ① 持久记录 spawn operation（phase = spawning）
 * ② 启动受控 wrapper（等待私有启动通道，**不运行用户 command**）
 * ③ 得到 PID / 进程组，持久化可回收定位并确认落盘（phase = running）
 * ④ 发 GO；用户 command 在已登记的受控进程组中启动
 * ```
 *
 * 三个崩溃窗口因此都有确定结论：
 *
 * | Broker 崩溃时点 | 结果 |
 * | --- | --- |
 * | ① 与 ② 之间 | 没有任何进程；记录为 spawning，按未确认停止处理 |
 * | ② 与 ③ 之间 | 管道随进程关闭 → wrapper 读到 EOF → **用户 command 从未开始** |
 * | ③ 与 ④ 之间 | 定位已落盘 → 恢复器可真实终止该 containment |
 * | ④ 之后 | 实际运行处在已登记的 containment（wrapper 进程组）中，可停止并排空 |
 *
 * 关键性质：
 * - wrapper 是进程组 leader（`detached: true`），用户 command 留在同一进程组，
 *   所以"停止该进程组"同时覆盖两者；
 * - 放行通道是私有 fd（`stdio[3]`），wrapper 在放行后显式关闭它，
 *   用户 command 不会继承这个管道；
 * - Broker 在放行前死亡（含 SIGKILL）→ 写端随进程关闭 → wrapper 读到 EOF → 不运行用户任务。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import {
  WRITER_GO_CHANNEL_FD,
  type WriterBootstrapPayload,
  writerBootstrapArgv,
  writerGoBytes,
} from "@/lib/workspace/writer-bootstrap";

/** 启动屏障无法建立：用户任务**没有**开始运行。 */
export class WriterBootstrapUnavailableError extends Error {
  readonly stableCode = "WriterBootstrapUnavailable";
  /**
   * `false` 表示"确定没有任何进程被创建"（可以收回启动意图记录）；
   * `true` 表示"进程可能已存在"（必须保留记录，按未确认停止处理）。
   */
  readonly containmentCreated: boolean;
  constructor(message: string, containmentCreated: boolean) {
    super(message);
    this.name = "WriterBootstrapUnavailable";
    this.containmentCreated = containmentCreated;
  }
}

// ─── 原子且持久的 JSON 替换 ─────────────────────────────────

/**
 * 原子**且持久**的 JSON 替换：写临时文件 → fsync 文件 → rename → fsync 父目录。
 *
 * 受管 Writer 的定位记录决定"崩溃后能不能找回真实写者"，因此不能只等一个 write Promise：
 * 断电时页缓存里的内容可能还没落到盘上。凡是"崩溃后必须能回读"的记录（containment 定位、
 * 停止证据、代际账本）都必须走这条路径，而不是普通的 `writeFile` + `rename`。
 */
export async function writeJsonDurable(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const staging = `${file}.${randomUUID()}.staging`;
  let handle: FileHandle | null = null;
  try {
    handle = await open(staging, "wx");
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(staging, file);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
  // 目录项本身的持久化：rename 只是原子替换，不等于父目录已同步。
  let directory: FileHandle | null = null;
  try {
    directory = await open(dir, "r");
    await directory.sync();
  } catch {
    // 并非所有平台/文件系统都允许 fsync 目录；失败不影响原子替换语义。
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

// ─── 受管 Writer 的持久归属记录 ─────────────────────────────

/**
 * 一次受管 Writer 启动的**持久可回收定位**。
 *
 * 这份形状是 Broker 与该启动流程之间唯一的交换面：Broker 只在其上追加"停止确认事实"，
 * 不重新定义定位字段。
 */
export interface ManagedWriterContainment {
  scopeDigest: string;
  writerGeneration: number;
  /** `spawning` = 只有启动意图，尚无 containment identity。 */
  phase: "spawning" | "running";
  pid: number | null;
  processGroupId: number | null;
  /** 本次启动的一次性放行令牌；`spawning` 阶段为 null。 */
  bootstrapToken: string | null;
  command: string;
  activityPath: string | null;
  registeredAt: string;
}

/** 读出归属记录；不存在或不可解析时返回 null（调用方按"未登记"处理）。 */
export async function readManagedWriterContainment<T extends ManagedWriterContainment>(
  recordPath: string,
): Promise<T | null> {
  try {
    return JSON.parse(await readFile(recordPath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 持久写入归属记录（走 `writeJsonDurable`，因此崩溃后一定可回读）。 */
export async function writeManagedWriterContainment(
  recordPath: string,
  containment: ManagedWriterContainment,
): Promise<void> {
  await writeJsonDurable(recordPath, containment);
}

// ─── 启动 / 放行 ────────────────────────────────────────────

export interface LaunchedManagedWriter {
  /** wrapper 的 PID；同时是进程组 ID（用户 command 在内）。 */
  pid: number;
  processGroupId: number;
  /** 本次启动的一次性放行令牌（持久化后可用于核对"这就是那次启动"）。 */
  bootstrapToken: string;
  /** 放行用户任务。放行后不可重复；放行前调用 `abandon` 是安全的。 */
  release(): void;
  /**
   * 放弃放行：关闭写端使 wrapper 读到 EOF 并退出，用户任务**从未开始**。
   *
   * 这是在"登记失败 / 授权复核失败 / 持久化失败"时必须走的路径 —— 不能只是
   * 停在那里等 GO 却不关闭通道，那会让 wrapper 一直悬着。
   */
  abandon(reason?: string): void;
  /** 是否已经做出"放行 / 放弃"的决定。 */
  isSettled(): boolean;
}

/**
 * 启动一个受控 wrapper（用户 command 尚被挡在启动通道之后）。
 *
 * 返回值给出 containment identity 与放行/放弃入口；调用方必须在**持久化定位
 * 并确认落盘之后**才调用 `release()`。
 */
export function launchManagedWriterProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  scopeDigest: string;
  writerGeneration: number;
}): LaunchedManagedWriter {
  const payload: WriterBootstrapPayload = {
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    scopeDigest: input.scopeDigest,
    writerGeneration: input.writerGeneration,
    goToken: randomUUID(),
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, writerBootstrapArgv(payload), {
      cwd: input.cwd,
      // 独立进程组：Broker 后续按**进程组**停止并排空，不需要猜单个 PID。
      detached: true,
      // fd 3 = 私有放行通道。Node 只把 stdio 里列出的 fd 交给该子进程，
      // 因此其它子进程不会继承这个写端（否则 EOF 永远不会到来）。
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new WriterBootstrapUnavailableError(
      `受控 wrapper 无法启动：${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
  const pid = child.pid;
  if (pid === undefined) {
    // `spawn` 返回但拿不到 PID：无法证明"没有进程"，因此按"可能已存在"报告。
    throw new WriterBootstrapUnavailableError("受控 wrapper 未返回 PID", true);
  }
  const channel = child.stdio[WRITER_GO_CHANNEL_FD] as Writable | null | undefined;
  if (!channel) {
    // 没有放行通道 = 没有屏障。此时绝不能"先跑起来再说"：直接收掉进程组。
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // 尚未进入进程组或已退出。
    }
    throw new WriterBootstrapUnavailableError("受控 wrapper 未建立私有放行通道", true);
  }
  // wrapper 的输出由 Broker 接走并排空，避免管道写满把 wrapper 卡住。
  child.stdout?.resume();
  child.stderr?.resume();
  child.unref();

  let settled = false;
  return {
    pid,
    processGroupId: pid,
    bootstrapToken: payload.goToken,
    isSettled: () => settled,
    release: () => {
      if (settled) return;
      settled = true;
      channel.write(writerGoBytes(payload));
      channel.end();
    },
    abandon: () => {
      if (settled) return;
      settled = true;
      // 只关闭写端：wrapper 读到 EOF 后按"未放行"退出，用户任务从未开始。
      channel.end();
    },
  };
}

/**
 * 完整的"先登记、后放行"：① spawning 意图 → ② 启动 wrapper → ③ 落 running 定位 → ④ 放行。
 *
 * 调用方必须已持有 scope 内核锁，并已完成 grant / freeze / 未停机旧写者的复核 ——
 * 本函数不做授权判断，只保证"用户 command 在定位落盘之前不会开始运行"。
 */
export async function startManagedWriter(input: {
  recordPath: string;
  scopeDigest: string;
  writerGeneration: number;
  command: string;
  args: string[];
  cwd: string;
  activityPath: string | null;
}): Promise<LaunchedManagedWriter> {
  const base = {
    scopeDigest: input.scopeDigest,
    writerGeneration: input.writerGeneration,
    command: [input.command, ...input.args].join(" "),
    activityPath: input.activityPath,
  };
  // ① 先落**启动意图**：spawn 成功到写 PID 之间被强杀，也不会留下"没有持久归属记录"的写者。
  await writeManagedWriterContainment(input.recordPath, {
    ...base,
    phase: "spawning",
    pid: null,
    processGroupId: null,
    bootstrapToken: null,
    registeredAt: new Date().toISOString(),
  });
  // ② 启动 wrapper：用户 command 被挡在私有启动通道之后，此刻尚未运行。
  let launched: LaunchedManagedWriter;
  try {
    launched = launchManagedWriterProcess({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      scopeDigest: input.scopeDigest,
      writerGeneration: input.writerGeneration,
    });
  } catch (error) {
    // 只有"进程根本没被创建"才能收回意图记录；无法确认时保留，按未确认停止处理。
    const created = error instanceof WriterBootstrapUnavailableError && error.containmentCreated;
    if (!created) await rm(input.recordPath, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    // ③ 持久化可回收定位，并确认落盘后才放行。
    await writeManagedWriterContainment(input.recordPath, {
      ...base,
      phase: "running",
      pid: launched.pid,
      processGroupId: launched.processGroupId,
      bootstrapToken: launched.bootstrapToken,
      registeredAt: new Date().toISOString(),
    });
  } catch (error) {
    // 定位未能落盘 → 绝不能放行：关闭通道让 wrapper 按"未放行"退出，用户任务从未开始。
    launched.abandon("containment_persist_failed");
    throw error;
  }
  // ④ 放行。此后用户 command 在**已登记**的受控进程组中运行。
  launched.release();
  return launched;
}
