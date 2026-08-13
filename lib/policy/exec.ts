/**
 * ：policy hook 专用的 workspace 命令执行 seam。
 *
 * 与 agent 工具（runCommand/runTests）的执行**分离**——hook 是内部副作用（格式化 / 交付前
 * 验证），不应落 tool_runs、不应进 agent 契约。独立 seam 也便于测试 mock（避免单测里真起
 * shell 跑 prettier/npm test）。
 *
 * 设计为「reject:false + 显式 timedOut」——调用方据 exitCode/timedOut 自行决定 fail-open
 * 还是 fail-closed（）。execa 自身崩溃（如 cwd 不存在）才抛，由调用方 try/catch。
 */
import { workspaceRoot } from "@/lib/workspace";

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export async function runWorkspaceCommand(
  threadId: string,
  command: string,
  opts?: { timeoutMs?: number; maxBuffer?: number },
): Promise<ExecResult> {
  const { execa } = await import("execa");
  const result = await execa(command, {
    cwd: workspaceRoot(threadId),
    shell: true,
    timeout: opts?.timeoutMs ?? 30_000,
    reject: false,
    maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
  });
  return {
    // exitCode 可能为 null（信号终止等），归一为 -1 便于判空
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: Boolean(result.timedOut),
  };
}
