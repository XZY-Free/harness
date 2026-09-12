import type { ExecResult } from "./types";

/** Web Host 与 Desktop 共用的本机子进程实现；环境与目录必须由可信调用方提供。 */
export async function executeLocalCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  logCapBytes: number;
  env: Record<string, string>;
  signal?: AbortSignal;
  onChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
}): Promise<ExecResult> {
  const { command, cwd, timeoutMs: timeout, logCapBytes: cap } = input;
  try {
    const { execa } = await import("execa");
    const subprocess = execa(input.command, {
      cwd,
      shell: true,
      // Unix 上建立独立进程组，timeout 时可以连同 shell 派生的子进程一起终止。
      detached: process.platform !== "win32",
      timeout,
      reject: false,
      maxBuffer: 1024 * 1024, // 1MB
      // timeout 后最多等待 1s 再强制终止，避免 shell 子进程让调用超过 timeout 太久。
      forceKillAfterDelay: 1_000,
      // P1 修复(02-):env 白名单过滤,防 AI 命令 printenv 泄露平台 secret。
      // 白名单(PATH/HOME/NPM_CONFIG_* 等)+ 敏感关键字黑名单兜底;secretsCache 显式注入。
      env: input.env,
      // execa 默认继承 process.env；否则白名单会被宿主环境重新补回。
      extendEnv: false,
      // 注入 AbortSignal，让 execa 子进程响应取消
      cancelSignal: input.signal,
    });
    const killProcessGroup = () => {
      if (process.platform === "win32" || !subprocess.pid) return;
      try {
        process.kill(-subprocess.pid, "SIGKILL");
      } catch {
        /* 已退出的进程组无需清理。 */
      }
    };
    input.signal?.addEventListener("abort", killProcessGroup, { once: true });
    if (input.signal?.aborted) killProcessGroup();
    // 流式回写——caller 传 onChunk 时逐块推送 stdout/stderr
    if (input.onChunk) {
      const onChunk = input.onChunk;
      subprocess.stdout?.on("data", (d: Buffer) => onChunk("stdout", d.toString()));
      subprocess.stderr?.on("data", (d: Buffer) => onChunk("stderr", d.toString()));
    }
    // execa 的 timeout 只 kill 外层 shell；独立进程组兜底清理其派生进程，避免管道仍被
    // 子进程持有而让 Promise 延迟到子进程自然退出。
    const processGroupKillTimer =
      process.platform !== "win32" && timeout > 0
        ? setTimeout(() => {
            killProcessGroup();
          }, timeout + 1_000)
        : undefined;
    try {
      const result = await subprocess;
      return {
        ok: result.exitCode === 0,
        exitCode: result.exitCode ?? null,
        stdout: result.stdout.slice(0, cap),
        stderr: result.stderr.slice(0, cap),
        command,
      };
    } finally {
      input.signal?.removeEventListener("abort", killProcessGroup);
      if (processGroupKillTimer) clearTimeout(processGroupKillTimer);
    }
  } catch {
    return { ok: false, exitCode: -1, stdout: "", stderr: "命令未取得确定退出状态", command };
  }
}
