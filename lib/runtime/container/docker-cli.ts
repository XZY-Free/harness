import { dockerResourceArgs } from "../rlimit";
import type { ExecResult } from "../types";

/**
 * docker CLI seam——封装所有 docker 命令调用。
 *
 * 实现选择：用 execa 调 docker CLI（而非 dockerode 程序化 API）。理由：
 * - 与 HostExecutionRuntime 的 execa 风格一致，exec 复用同一套超时/buffer/异常兜底
 * - plan 任务 B3/B5 给的就是 `docker run` / `docker exec` CLI 命令形式
 * - 测试只需 mock 本 seam 模块，不必解析 dockerode stream
 * - 减少依赖（不引入 dockerode）；ExecutionRuntime 接口不变，后续可替换实现
 *
 * 所有命令用 args 数组（非 shell:true），避免 shell 注入；用户命令经 `sh -lc` 单 arg 传递。
 * 本模块是测试 mock 边界：单测 mock `@/lib/runtime/container/docker-cli`，
 * integration 测试（skipIf !hasDocker）走真实 docker。
 */

const MAX_OUTPUT = 10_000;

/** docker info 是否可用（退出 0）。 */
export async function dockerInfo(): Promise<boolean> {
  try {
    const { execa } = await import("execa");
    const result = await execa("docker", ["info"], {
      reject: false,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** 镜像是否已存在（`docker images -q` 输出非空）。 */
export async function imageExists(image: string): Promise<boolean> {
  const { execa } = await import("execa");
  const result = await execa("docker", ["images", "-q", image], {
    reject: false,
    timeout: 10_000,
  });
  return result.stdout.trim().length > 0;
}

/** 构建镜像（`docker build -t image dir`）。失败抛错（caller 提示 pnpm build:runtime）。 */
export async function buildImage(image: string, dockerfileDir: string): Promise<void> {
  const { execa } = await import("execa");
  const result = await execa("docker", ["build", "-t", image, dockerfileDir], {
    reject: false,
    timeout: 300_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `docker build 失败（exit ${result.exitCode}）：${result.stderr.slice(0, 500)}。请运行 pnpm build:runtime`,
    );
  }
}

export interface RunContainerOpts {
  name: string;
  image: string;
  threadId: string;
  hostPath: string;
  port: number;
  memory: string;
  cpus: string;
  env: string[];
  /** docker network 模式（如 "none"）。undefined=默认 bridge。 */
  networkMode?: string;
  /** 额外 docker run 参数（如 --add-host）。 */
  extraArgs?: string[];
  /** secret env 文件路径（--env-file，不写命令行防泄露）。 */
  envFile?: string;
  /** 进程数上限 → docker --pids-limit。0/undefined=不限。 */
  pidsLimit?: number;
  /** 文件描述符上限 → docker --ulimit nofile。0/undefined=不限。 */
  openFilesLimit?: number;
  /** 容器 rootfs 磁盘配额（bytes）→ docker --storage-opt size=。0/undefined=不限。 */
  diskQuotaBytes?: number;
}

/** 拉起容器（`docker run -d ...`），返回 containerId。 */
export async function runContainer(opts: RunContainerOpts): Promise<string> {
  const { execa } = await import("execa");
  const args = [
    "run",
    "-d",
    "--name",
    opts.name,
    "--label",
    `snow-harness.threadId=${opts.threadId}`,
    "-v",
    `${opts.hostPath}:/workspace`,
    "-p",
    `127.0.0.1:${opts.port}:${opts.port}`,
    "--memory",
    opts.memory,
    "--cpus",
    opts.cpus,
    ...opts.env.flatMap((e) => ["-e", e]),
  ];
  // 网络策略 --network（disabled=none；open/allowlist=默认 bridge 不加）
  if (opts.networkMode) {
    args.push("--network", opts.networkMode);
  }
  // secret env 文件（--env-file，不写命令行防泄露）
  if (opts.envFile) {
    args.push("--env-file", opts.envFile);
  }
  // 进程数 + 文件描述符硬限（cgroup，无需 root）。
  // 复用 rlimit.dockerResourceArgs，消除双轨（手写参数组装 vs 封装函数）。
  args.push(
    ...dockerResourceArgs({
      pidsLimit: opts.pidsLimit ?? 0,
      openFilesLimit: opts.openFilesLimit ?? 0,
    }),
  );
  // 容器 rootfs 磁盘配额（需 overlay2/devicemapper 配额支持，不支持时 docker 报错）
  if (opts.diskQuotaBytes && opts.diskQuotaBytes > 0) {
    args.push("--storage-opt", `size=${opts.diskQuotaBytes}`);
  }
  // 额外 docker run 参数（如 --add-host）
  if (opts.extraArgs) {
    args.push(...opts.extraArgs);
  }
  args.push(opts.image, "sleep", "infinity");

  const result = await execa("docker", args, { reject: false, timeout: 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(`docker run 失败（exit ${result.exitCode}）：${result.stderr.slice(0, 500)}`);
  }
  return result.stdout.trim();
}

/** 停止容器。 */
export async function stopContainer(name: string): Promise<void> {
  const { execa } = await import("execa");
  await execa("docker", ["stop", name], { reject: false, timeout: 30_000 });
}

/** 删除容器（-f 强制，容器可能仍在运行）。 */
export async function removeContainer(name: string): Promise<void> {
  const { execa } = await import("execa");
  await execa("docker", ["rm", "-f", name], { reject: false, timeout: 30_000 });
}

/** 按标签查询容器名列表。 */
export async function listContainersByLabel(
  labelKey: string,
  labelValue: string,
): Promise<string[]> {
  const { execa } = await import("execa");
  const result = await execa(
    "docker",
    ["ps", "-a", "--filter", `label=${labelKey}=${labelValue}`, "--format", "{{.Names}}"],
    { reject: false, timeout: 10_000 },
  );
  return result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── R07 受管 Environment 实例原语（真实创建 + 真实回读）──────────────
//
// 受管 Environment 必须"实际建立资源并回读实际配置"。以下原语只暴露原始事实
// （container inspect / image inspect / 显式 args 的 run），合规判定在
// lib/environment/environment-instance-backend.ts，本模块不做任何策略假设。

/** `docker inspect` 中与本平台合规判定相关的字段子集。 */
export interface DockerContainerInspect {
  Id: string;
  Image: string;
  Name: string;
  State: { Status: string; Running: boolean; Pid: number; Dead: boolean; ExitCode: number };
  Config: {
    Image: string;
    Entrypoint: string[] | null;
    Cmd: string[] | null;
    Env: string[] | null;
    WorkingDir: string;
    Labels: Record<string, string> | null;
  };
  HostConfig: {
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    PidsLimit: number | null;
    NetworkMode: string;
    PidMode: string;
    ReadonlyRootfs: boolean;
    Privileged: boolean;
    StorageOpt: Record<string, string> | null;
    Ulimits: Array<{ Name: string; Soft: number; Hard: number }> | null;
  };
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean; Mode: string }>;
}

/** `docker image inspect` 的字段子集。 */
export interface DockerImageInspect {
  Id: string;
  RepoDigests: string[] | null;
  Config: { Entrypoint: string[] | null; Cmd: string[] | null } | null;
}

/** 真实回读容器；容器不存在返回 null（不抛错——"不存在"是合法事实）。 */
export async function inspectContainer(name: string): Promise<DockerContainerInspect | null> {
  const { execa } = await import("execa");
  const result = await execa("docker", ["inspect", name], { reject: false, timeout: 15_000 });
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as DockerContainerInspect[];
    return parsed[0] ?? null;
  } catch {
    return null;
  }
}

/** 真实回读镜像；镜像不存在返回 null。 */
export async function inspectImage(reference: string): Promise<DockerImageInspect | null> {
  const { execa } = await import("execa");
  const result = await execa("docker", ["image", "inspect", reference], {
    reject: false,
    timeout: 15_000,
  });
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as DockerImageInspect[];
    return parsed[0] ?? null;
  } catch {
    return null;
  }
}

export interface RunManagedContainerOpts {
  name: string;
  /** 镜像引用（repo@sha256:… 或 repo:tag）。 */
  image: string;
  /** 固定入口（首元素经 `--entrypoint` 覆盖，其余与 args 一起作为容器命令）。 */
  entrypoint: string[];
  args: string[];
  labels: Record<string, string>;
  /** 内存上限（字节）；0/undefined=不设。 */
  memoryBytes?: number;
  /** CPU 配额（纳核，1e9 = 1 CPU）；0/undefined=不设。 */
  nanoCpus?: number;
  pidsLimit?: number;
  openFilesLimit?: number;
  /** 容器 rootfs 只读。 */
  readOnlyRootfs?: boolean;
  /** docker `--network` 值；undefined=默认 bridge。 */
  networkMode?: string;
  mounts: Array<{ source: string; target: string; readOnly: boolean }>;
  workdir?: string;
  /** 已解析的 secret（经 `--env-file` 注入，不写命令行防泄露）。 */
  envFilePath?: string;
}

/**
 * 受管容器创建：全部参数显式来自调用方（不做平台默认假设）。
 * 与 `runContainer` 的区别：不强制发布端口、不强制 `/workspace` 挂载、不强制 `sleep infinity`，
 * 且入口/资源/网络/文件系统/secret 全部由外部策略决定——正是"实际应用固定策略"所需。
 */
export async function runManagedContainer(opts: RunManagedContainerOpts): Promise<string> {
  const { execa } = await import("execa");
  const args = ["run", "-d", "--name", opts.name];
  for (const [key, value] of Object.entries(opts.labels)) {
    args.push("--label", `${key}=${value}`);
  }
  const entrypointBinary = opts.entrypoint[0];
  if (!entrypointBinary) {
    throw new Error("受管容器必须指定固定入口（entrypoint 不能为空）");
  }
  args.push("--entrypoint", entrypointBinary);
  if (opts.memoryBytes && opts.memoryBytes > 0) args.push("--memory", String(opts.memoryBytes));
  if (opts.nanoCpus && opts.nanoCpus > 0) args.push("--cpus", String(opts.nanoCpus / 1e9));
  if (opts.pidsLimit && opts.pidsLimit > 0) args.push("--pids-limit", String(opts.pidsLimit));
  if (opts.openFilesLimit && opts.openFilesLimit > 0) {
    args.push("--ulimit", `nofile=${opts.openFilesLimit}:${opts.openFilesLimit}`);
  }
  if (opts.readOnlyRootfs) args.push("--read-only");
  if (opts.networkMode) args.push("--network", opts.networkMode);
  if (opts.workdir) args.push("--workdir", opts.workdir);
  if (opts.envFilePath) args.push("--env-file", opts.envFilePath);
  for (const mount of opts.mounts) {
    args.push("-v", `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`);
  }
  args.push(opts.image, ...opts.entrypoint.slice(1), ...opts.args);

  const result = await execa("docker", args, { reject: false, timeout: 120_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `docker run（受管 Environment）失败（exit ${result.exitCode}）：${result.stderr.slice(0, 500)}`,
    );
  }
  return result.stdout.trim();
}

/** 在容器内后台执行命令（`docker exec -d name sh -lc "cd /workspace && {command}"`）。立即返回，不等输出。
 * 供 DevServerPreviewRuntime 启动长驻 dev server（npm run dev）。 */
export async function execDetached(name: string, command: string): Promise<void> {
  const { execa } = await import("execa");
  await execa("docker", ["exec", "-d", name, "sh", "-lc", `cd /workspace && ${command}`], {
    reject: false,
    timeout: 15_000,
  });
}

export interface DetachedPidInfo {
  pidFile: string;
  logPath: string;
}

/**
 * 在容器内后台执行命令，并把 long-running 进程 PID 写入文件。
 * 使用 `execDetached` 启动包装脚本：echo $$ > pidFile && exec command > logPath 2>&1 &。
 * 这样停止时可以精确 kill PID，避免 pkill -f 误杀/漏杀。
 */
/** 最小 shell 单引号转义（供容器内路径/命令传参，防注入）。。 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export async function execDetachedWithPid(
  name: string,
  taskId: string,
  command: string,
): Promise<DetachedPidInfo> {
  // pidFile/logPath 经 shQuote 转义（taskId 虽为 UUID 安全，但路径拼接入 shell
  // 字符串一律转义，防未来 taskId 来源变化或路径注入）。
  const pidFile = `/workspace/.snow/runtime/tasks/${taskId}.pid`;
  const logPath = `/workspace/.snow/runtime/tasks/${taskId}.log`;
  const tasksDir = shQuote("/workspace/.snow/runtime/tasks");
  const wrapped = `mkdir -p ${tasksDir} && (echo $$ > ${shQuote(pidFile)} && exec ${command}) > ${shQuote(logPath)} 2>&1 &`;
  await execDetached(name, wrapped);
  return { pidFile, logPath };
}

/** 在容器内执行命令（`docker exec name sh -lc "cd /workspace && {command}"`）。 */
export async function execInContainer(
  name: string,
  command: string,
  opts?: {
    timeoutMs?: number;
    logCapBytes?: number;
    /** 流式回写回调。 */
    onChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
    /** AbortSignal 注入，让 docker exec 子进程响应取消。 */
    signal?: AbortSignal;
  },
): Promise<ExecResult> {
  const timeout = opts?.timeoutMs ?? 30_000;
  // logCapBytes 只能收紧（与 MAX_OUTPUT 取 min），不放宽。
  const cap = opts?.logCapBytes !== undefined ? Math.min(MAX_OUTPUT, opts.logCapBytes) : MAX_OUTPUT;
  try {
    const { execa } = await import("execa");
    const subprocess = execa("docker", ["exec", name, "sh", "-lc", `cd /workspace && ${command}`], {
      reject: false,
      timeout,
      maxBuffer: 1024 * 1024,
      // 注入 AbortSignal
      signal: opts?.signal,
    });
    // 流式回写
    if (opts?.onChunk) {
      const onChunk = opts.onChunk;
      subprocess.stdout?.on("data", (d: Buffer) => onChunk("stdout", d.toString()));
      subprocess.stderr?.on("data", (d: Buffer) => onChunk("stderr", d.toString()));
    }
    const result = await subprocess;
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode ?? null,
      stdout: result.stdout.slice(0, cap),
      stderr: result.stderr.slice(0, cap),
      command,
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      command,
    };
  }
}

// ─── 远程浏览器运行时容器（当前）──────────────────────────────────

// V9 远程浏览器容器专属扩展已删除。
// 原 BROWSER_CONTAINER_LABELS / RunBrowserContainerOpts / runBrowserContainer /
// listBrowserContainersByLabel 仅供 RemoteBrowserManager 使用，随 V9 链路移除。
// inspectContainerLabels / isContainerRunning / listContainersByLabelKey 保留，
// 通用容器能力仍需使用。
