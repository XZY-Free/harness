/**
 * A07 测试支持：**真实**受管 Writer 与故障屏障进程（FILE-090）。
 *
 * 这里的每一件东西都是能被真实启动、真实强杀、真实探测的操作系统进程。
 * 它只服务测试装配，不参与生产路径，也**不**替代 Broker —— Broker 仍然自己
 * 探测进程组、自己采样写入活动；这里不提供任何 `stopped = true` 的注入点。
 */
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceWriterIdentity } from "@/lib/workspace/workspace-host";

/** 进程是否存活（真实 signal 0 探测；EPERM 说明存在但无权操作）。 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 进程退出不是瞬时的：断言"真的没了"必须轮询，否则会假失败。 */
export async function waitForProcessGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processAlive(pid);
}

/** 真实信号终止一个游离进程（测试收尾用；ESRCH 视为已完成）。 */
export function killByPid(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** `activityPath` 当前字节数；文件不存在返回 `null`。 */
export async function activitySize(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

/** 写入活动是否已经静止（采样窗口内大小不再变化）。 */
export async function waitForActivityIdle(file: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let previous = await activitySize(file);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const current = await activitySize(file);
    if (current === previous) return true;
    previous = current;
  }
  return false;
}

/** 等待文件出现（用于断言"用户任务真的跑起来了"）。 */
export async function waitForFileExists(file: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await activitySize(file)) !== null) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return (await activitySize(file)) !== null;
}

/** 文件在观察窗口内是否仍在增长（用于断言"写者仍在写"）。 */
export async function fileStillGrowing(file: string, windowMs = 200): Promise<boolean> {
  const before = await activitySize(file);
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const after = await activitySize(file);
  if (before === null || after === null) return false;
  return after > before;
}

// ─── 真实 Broker 进程探针（决策三的三个崩溃窗口） ─────────────

/** 探针脚本：用生产代码起一个受管 Writer，并在选定时刻停下不再往下走。 */
export const WRITER_BROKER_PROBE_PATH = path.join(
  process.cwd(),
  "lib",
  "workspace",
  "test-support",
  "writer-broker-probe.mts",
);

export interface WriterBrokerProbeConfig {
  mode: "pre-registration" | "post-registration" | "released";
  hostRoot: string;
  managedRoot: string;
  writerRoot: string;
  recordPath: string;
  markerPath: string;
  activityPath: string;
  writerGeneration: number;
}

export interface WriterBrokerProbe {
  /** 探针（模拟 Broker）自己的 PID —— 测试对它发真实 SIGKILL。 */
  pid: number;
  /** 受控 wrapper 的 PID（= 进程组 ID）。 */
  wrapperPid: number;
  bootstrapToken: string | null;
  /**
   * 探针那次激活的**精确归属身份**（A07 决策五）。
   *
   * 探针是真正执行 `activateWriter` 的调用方，因此由它交出身份；测试据此请求撤销，
   * 而不是自己拼一个 generation 数字 —— 后者在契约上已经不可表达。
   */
  identity: WorkspaceWriterIdentity;
  /** 探针的 stderr 累积内容（失败时用于诊断）。 */
  stderr(): string;
}

/**
 * 起一个**真实独立进程**扮演 Broker。
 *
 * 它必须与测试进程分离：只有"另一个进程真的死了"才能让 OS 关闭私有启动通道的写端。
 * 用 `--import tsx` 让该进程直接运行 TypeScript，从而调用的是生产代码本身，
 * 而不是测试里另写一份等价实现。
 */
export async function startWriterBrokerProbe(
  config: WriterBrokerProbeConfig,
  options: { timeoutMs?: number } = {},
): Promise<WriterBrokerProbe> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", WRITER_BROKER_PROBE_PATH, JSON.stringify(config)],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("Broker 探针未返回 PID");
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Broker 探针 ${timeoutMs}ms 内未就绪（stderr=${stderr || "<empty>"}）`));
    }, timeoutMs);
    const settle = (value: string) => {
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout?.on("data", () => {
      const first = stdout.split("\n")[0];
      if (first?.trim()) settle(first.trim());
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Broker 探针提前退出（code=${code}）stderr=${stderr || "<empty>"}`));
    });
  });
  const parsed = JSON.parse(line) as {
    wrapperPid: number;
    bootstrapToken?: string | null;
    identity: WorkspaceWriterIdentity;
  };
  return {
    pid,
    wrapperPid: parsed.wrapperPid,
    bootstrapToken: parsed.bootstrapToken ?? null,
    identity: parsed.identity,
    stderr: () => stderr,
  };
}

/**
 * 一个"真正在写工作区"的独立孙进程源码。
 *
 * 它先把自己的 PID 落到 `pidFile`（让测试能真实终止它），然后持续追加写入
 * `activityPath` —— 这就是 Broker 用来判断"写入活动是否排空"的那份物理活动。
 */
export function detachedWriterChildSource(input: {
  activityPath: string;
  pidFile: string;
  payload?: string;
}): string {
  const payload = input.payload ?? "detached-writer";
  return [
    "const fs = require('node:fs');",
    `const file = ${JSON.stringify(input.activityPath)};`,
    `fs.writeFileSync(${JSON.stringify(input.pidFile)}, String(process.pid));`,
    `const payload = ${JSON.stringify(payload)};`,
    "let n = 0;",
    "setInterval(() => { n += 1; fs.appendFileSync(file, `${payload}:${n}\\n`); }, 20);",
  ].join("\n");
}

/**
 * 启动参数：**父进程立刻退出**，把真实写入留给一个已 detached 的孙进程。
 *
 * 这是"受控停止边界"的物理形态：`spawnManagedWriter` 记录的是父进程的进程组，
 * 父退出后该组即为空，但孙进程（独立进程组）仍在写。于是
 * "进程组不存在" 与 "写入已排空" 第一次成为**两件不同的事实** ——
 * 只凭前者就宣布 `stopped = true` 的实现会在这里失败。
 */
export function detachedWriterArgs(input: { activityPath: string; pidFile: string }): string[] {
  const childSource = detachedWriterChildSource(input);
  const parentSource = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], {`,
    "  detached: true,",
    "  stdio: 'ignore',",
    "});",
    "child.unref();",
  ].join("\n");
  return ["-e", parentSource];
}

/** 读取孙进程写出的 PID（轮询到出现为止，超时抛错）。 */
export async function readDetachedWriterPid(pidFile: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = (await readFile(pidFile, "utf8")).trim();
      if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
    } catch {
      // 还没写出来。
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`游离 Writer 未在 ${timeoutMs}ms 内写出 PID：${pidFile}`);
}

/** 直接拉起一个游离写者（不经过 Broker）：用于测试侧的真实"操作者处置"。 */
export async function spawnDetachedWriterProcess(input: {
  activityPath: string;
  pidFile: string;
  payload?: string;
}): Promise<number> {
  const child = spawn(process.execPath, ["-e", detachedWriterChildSource(input)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return readDetachedWriterPid(input.pidFile);
}
