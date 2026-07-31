import type { ResourceQuota } from "./types";

/**
 * S1 修复（04-G2 长期方案）：子代理/命令资源隔离的 rlimit / docker ulimit 封装。
 *
 * 短期方案（已落地）：HEAVY_COMMAND_TOOLS 全局互斥，防父子 runTests/runCommand 抢资源。
 * 长期方案（本模块）：进程数（nproc/pids）+ 文件描述符（nofile）硬限。
 *
 * - host 模式（仅 Linux）：用 `prlimit` 包裹命令。macOS/其他平台跳过（诚实 no-op，不伪装）。
 *   内存隔离需 cgroup（root），host 模式不提供，仅限 fd/进程数。
 * - container 模式：docker `--pids-limit` + `--ulimit nofile` 硬限（cgroup，无需 root）。
 *   内存/CPU 已由 docker `--memory`/`--cpus` 治理。
 */

/** 最小 shell 单引号转义（供 sh -c 传参，防注入）。 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 用 prlimit 包裹 host 命令，施加 nofile/nproc 软限。
 *
 * 产物形如 `prlimit --nofile=1024 --nproc=256 -- sh -c '<command>'`，配合 execa shell:true
 * （外层 sh 启动 prlimit，prlimit 设限后 exec 内层 sh 解析原命令，子进程继承限额）。
 *
 * 非 Linux 平台或 quota 无限额 → 原样返回（不伪装有限额）。
 */
export function wrapWithHostRlimits(command: string, quota?: ResourceQuota): string {
  if (process.platform !== "linux") return command;
  const nofile = quota?.openFilesLimit ?? 0;
  const nproc = quota?.pidsLimit ?? 0;
  if ((nofile ?? 0) <= 0 && (nproc ?? 0) <= 0) return command;
  const args: string[] = [];
  if (nofile > 0) args.push(`--nofile=${nofile}`);
  if (nproc > 0) args.push(`--nproc=${nproc}`);
  // prlimit 设自身限额后 exec `sh -c '<command>'`；原命令可能含管道/&&，必须经 sh 解析。
  return `prlimit ${args.join(" ")} -- sh -c ${shQuote(command)}`;
}

/**
 * 生成 container 模式的 docker `--pids-limit` / `--ulimit nofile` 参数。
 *
 * 返回追加到 `docker run` 的参数数组（如 `["--pids-limit", "256", "--ulimit", "nofile=1024:1024"]`）。
 * 无限额返回空数组。
 */
export function dockerResourceArgs(quota?: ResourceQuota): string[] {
  const args: string[] = [];
  const pids = quota?.pidsLimit ?? 0;
  const nofile = quota?.openFilesLimit ?? 0;
  if (pids > 0) {
    args.push("--pids-limit", String(pids));
  }
  if (nofile > 0) {
    // nofile=soft:hard；docker ulimit 语法
    args.push("--ulimit", `nofile=${nofile}:${nofile}`);
  }
  return args;
}
