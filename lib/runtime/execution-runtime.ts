import { workspaceRoot } from "@/lib/workspace";
import { execInContainer } from "./container/docker-cli";
import { startContainer, touchActivity } from "./container/manager";
import { type SecretEnvMap, prepareContainerStartOptions } from "./container/start-options";
import { wrapWithHostRlimits } from "./rlimit";
import { buildSafeEnv } from "./safe-env";
import { wrapWithHostSandbox } from "./sandbox";
import type { ExecResult, ExecutionRuntime, NetworkPolicy, ResourceQuota } from "./types";

/**
 * HostExecutionRuntime——`ExecutionRuntime` 的宿主实现。
 *
 * 从 `lib/ai/tools.ts` 的 runCommand/runTests 抽出 execa 逻辑（零行为变更）：
 * - `execa(command, { shell:true, cwd: workspaceRoot, reject:false, maxBuffer: 1MB })`
 * - stdout / stderr 截断到 10000 字符（与现有 runCommand/runTests 一致）
 * - timeoutMs 默认 30000（runCommand），runTests 调用方传 60000
 * - spawn 级异常（ENOENT / timeout）内部 catch → `{ ok:false, exitCode:-1 }`，
 * 对齐现有 try/catch 兜底契约，不向上抛
 *
 * container 模式由 `ContainerExecutionRuntime` 提供：`docker exec` 进容器执行。
 */

/** stdout / stderr 截断上限（与现有 runCommand/runTests 一致）。 */
const MAX_OUTPUT = 10_000;
/** 默认命令超时（对齐现有 runCommand 的 30s）。 */
const DEFAULT_TIMEOUT_MS = 30_000;

export class HostExecutionRuntime implements ExecutionRuntime {
  /** 懒加载的 secret env（首次 exec 时解析，缓存后续复用）。 */
  private secretsCache?: SecretEnvMap;

  constructor(
    private readonly threadId: string,
    /** per-thread 资源配额（作为上限，只能收紧；undefined=零回归）。 */
    private readonly quota?: ResourceQuota,
    /** secret 解析回调（懒加载，首次 exec 时调）。 */
    private readonly secretResolver?: () => Promise<SecretEnvMap>,
  ) {}

  async exec(
    command: string,
    opts?: {
      timeoutMs?: number;
      logCapBytes?: number;
      onChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
      /** AbortSignal 注入，让 execa 子进程响应取消。 */
      signal?: AbortSignal;
    },
  ): Promise<ExecResult> {
    const cwd = workspaceRoot(this.threadId);
    // timeout 取 caller opts 与 quota 的 min（只能收紧，无 quota 零回归）。
    let timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (this.quota?.timeoutMs !== undefined) timeout = Math.min(timeout, this.quota.timeoutMs);
    // logCap 取 caller opts / quota / MAX_OUTPUT 的 min（只能收紧）。
    let cap = MAX_OUTPUT;
    if (opts?.logCapBytes !== undefined) cap = Math.min(cap, opts.logCapBytes);
    if (this.quota?.logCapBytes !== undefined) cap = Math.min(cap, this.quota.logCapBytes);
    // 懒加载 secret env（首次 exec 时解析）
    if (this.secretResolver && !this.secretsCache) {
      try {
        this.secretsCache = await this.secretResolver();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: `[secret] 解析失败（fail-closed）：${message}`,
          command,
        };
      }
    }
    try {
      const { execa } = await import("execa");
      // host Linux 用 prlimit 施加 nofile/nproc 软限（非 Linux 原样返回）。
      const limited = wrapWithHostRlimits(command, this.quota);
      // host Linux bwrap 沙箱（config-gated，默认 off，bwrap 不可用 fail-open）。
      const sandboxed = await wrapWithHostSandbox(limited, cwd);
      const subprocess = execa(sandboxed, {
        cwd,
        shell: true,
        timeout,
        reject: false,
        maxBuffer: 1024 * 1024, // 1MB
        // P1 修复(02-):env 白名单过滤,防 AI 命令 printenv 泄露平台 secret。
        // 白名单(PATH/HOME/NPM_CONFIG_* 等)+ 敏感关键字黑名单兜底;secretsCache 显式注入。
        env: buildSafeEnv(this.secretsCache),
        // 注入 AbortSignal，让 execa 子进程响应取消
        signal: opts?.signal,
      });
      // 流式回写——caller 传 onChunk 时逐块推送 stdout/stderr
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
      // spawn 级失败（ENOENT / timeout 等）——对齐现有 runCommand/runTests 的 catch 兜底
      return {
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        command,
      };
    }
  }
}

/**
 * ContainerExecutionRuntime——`ExecutionRuntime` 的容器实现。
 *
 * `docker exec snow-thread-{id} sh -lc "cd /workspace && {command}"`（经 docker-cli seam）。
 * 首次 exec 惰性 `startContainer`（含 ensureRuntimeImage），thread 内复用同一容器；
 * 每次 exec 后 `touchActivity` 刷新 idle TTL（ 回收依据）。
 * 超时 / buffer 截断 / 异常兜底与 HostExecutionRuntime 一致（docker-cli.execInContainer 内处理）。
 * 容器拉起级失败（ensureRuntimeImage / runContainer 抛）在此 catch 成 { ok:false }，
 * 不向上抛——对齐 host 的异常契约。
 */
export class ContainerExecutionRuntime implements ExecutionRuntime {
  /** 懒加载的 secret env（首次 exec 时解析，写入 --env-file，缓存复用）。 */
  private secretsCache?: SecretEnvMap;

  constructor(
    private readonly threadId: string,
    /** per-thread 资源配额（container 模式硬配额 docker --memory/--cpus）。 */
    private readonly quota?: ResourceQuota,
    /** per-thread 网络策略（container 模式 docker network 治理）。 */
    private readonly networkPolicy?: NetworkPolicy,
    /** secret 解析回调（懒加载，首次 exec 时调，写入 --env-file）。 */
    private readonly secretResolver?: () => Promise<SecretEnvMap>,
  ) {}

  async exec(
    command: string,
    opts?: {
      timeoutMs?: number;
      logCapBytes?: number;
      onChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
      /** AbortSignal 注入，让 execa 子进程响应取消。 */
      signal?: AbortSignal;
    },
  ): Promise<ExecResult> {
    try {
      const prepared = await prepareContainerStartOptions({
        threadId: this.threadId,
        quota: this.quota,
        networkPolicy: this.networkPolicy,
        secretResolver: this.secretResolver,
        existingSecrets: this.secretsCache,
      });
      try {
        this.secretsCache = prepared.secretsCache ?? this.secretsCache;
        const entry = await startContainer(this.threadId, prepared.startOptions);
        // quota 的 timeoutMs/logCapBytes 作为上限（只能收紧）。无 quota 时透传 opts（零回归）。
        let execOpts = opts;
        if (this.quota?.timeoutMs !== undefined || this.quota?.logCapBytes !== undefined) {
          execOpts = { ...opts };
          if (this.quota?.timeoutMs !== undefined) {
            execOpts.timeoutMs =
              opts?.timeoutMs !== undefined
                ? Math.min(opts.timeoutMs, this.quota.timeoutMs)
                : this.quota.timeoutMs;
          }
          if (this.quota?.logCapBytes !== undefined) {
            execOpts.logCapBytes =
              opts?.logCapBytes !== undefined
                ? Math.min(opts.logCapBytes, this.quota.logCapBytes)
                : this.quota.logCapBytes;
          }
        }
        // 透传 signal 给 execInContainer
        const result = await execInContainer(entry.containerName, command, execOpts);
        touchActivity(this.threadId);
        return result;
      } finally {
        await prepared.cleanup();
      }
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
}
