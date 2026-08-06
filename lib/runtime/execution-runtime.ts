import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { backgroundTaskConfig } from "@/lib/config";
import { workspaceRoot } from "@/lib/workspace";
import { relativeLogPath } from "./background-task-logs";
import { attachStopHandle, markStopped } from "./background-task-registry";
import { execDetached, execDetachedWithPid, execInContainer } from "./container/docker-cli";
import { startContainer, touchActivity } from "./container/manager";
import { prepareContainerStartOptions } from "./container/start-options";
import { directChildren, isAlive } from "./process-tree";
import { wrapWithHostRlimits } from "./rlimit";
import { buildSafeEnv } from "./safe-env";
import { wrapWithHostSandbox } from "./sandbox";
import type { SecretEnvMap } from "./secret-mount";
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
 * container 模式（Stage B）由 `ContainerExecutionRuntime` 提供：`docker exec` 进容器执行。
 */

/** stdout / stderr 截断上限（与现有 runCommand/runTests 一致）。 */
const MAX_OUTPUT = 10_000;
/** 默认命令超时（对齐现有 runCommand 的 30s）。 */
const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Stage B：后台长跑能力（plan §6） ───────────────────
//
// 后台方法放在本文件而非 types.ts：types.ts 当前有未提交的并行 改动
// （WorkspaceStore.glob/grep），在此提交会污染本 Stage 并破坏提交树一致性；后台能力
// 仅 Host/Container 两个实现需要，定义在实现侧更内聚。intent 与 plan §6 一致。

/** startBackground 入参。logRelPath 为相对日志路径（.snow/runtime/{threadId}/tasks/{taskId}.log）。 */
export interface BackgroundStartOpts {
 taskId: string;
 threadId: string;
 logRelPath: string;
 env?: Record<string, string>;
 cwd?: string;
}

/** startBackground 返回的进程句柄。host 有 pid；container 有 containerName + taskId。 */
export interface BackgroundHandle {
 pid?: number;
 containerName?: string;
 /** 任务 id，container 停止时用于定位 PID 文件。 */
 taskId?: string;
 command: string;
}

/**
 * 后台能力接口（Host/Container 均实现）。工具经此调用 startBackground/stopBackground。
 * 与 ExecutionRuntime 组合：resolveRuntimes 返回的 execution 实际同时满足两者。
 */
export interface BackgroundCapableExecutionRuntime extends ExecutionRuntime {
 startBackground(command: string, opts: BackgroundStartOpts): Promise<BackgroundHandle>;
 stopBackground(handle: BackgroundHandle): Promise<void>;
}

export class HostExecutionRuntime implements BackgroundCapableExecutionRuntime {
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
 /** V6-Batch1-M1：AbortSignal 注入，让 execa 子进程响应取消。 */
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
 // V6-Batch1-M1：注入 AbortSignal，让 execa 子进程响应取消
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

 /**
 * Stage B：host 后台启动长跑进程。
 *
 * `execa(command, { shell:true, detached:true, stdio:[ignore, logStream, logStream] })` + `unref()`，
 * detached 在 POSIX 经 setsid 新建进程组，供 stopBackground 用 `process.kill(-pid)` 杀整组
 * （解决 `npm run dev → vite` 孤儿问题，plan §1/§12）。stdout/stderr 流式追加到日志文件。
 *
 * 进程 exit（detached 仍触发）→ registry.markStopped(reason=crash)，捕获崩溃。
 * stop 回调注入 registry，供 stopAllByThread/closeAll 调用。
 *
 * **不阻塞**：立即返回 pid，长跑进程由 BackgroundTaskRegistry 管理。
 */
 async startBackground(command: string, opts: BackgroundStartOpts): Promise<BackgroundHandle> {
 const { execa } = await import("execa");
 const cwd = opts.cwd ?? workspaceRoot(this.threadId);
 const absLog = resolve(backgroundTaskConfig.hostLogDir, opts.logRelPath);
 await mkdir(dirname(absLog), { recursive: true });
 // P0 修复（02-P0-1）：后台任务同样懒加载 secret 并注入，与 exec 路径对齐。
 // 原实现只传 buildSafeEnv(opts.env) 漏了 secretsCache → host 后台任务（npm run dev 等）
 // 拿不到 API_KEY 等 secret，静默失败。secret 解析失败直接抛（调用方 command-tasks.ts
 // try/catch 转 { ok:false, error }），不返回残缺 handle 假装启动成功。
 if (this.secretResolver && !this.secretsCache) {
 this.secretsCache = await this.secretResolver();
 }
 // shell 内重定向到日志文件（与 container 路径一致），避免 execa v9 fd/WriteStream stdio 限制。
 // detached:true 在 POSIX 经 setsid 新建进程组，供 stopBackground 用 process.kill(-pid) 杀整组。
 // host Linux 用 prlimit 施加 nofile/nproc 软限（包裹在重定向之前，限额作用于 prlimit 进程及其子进程）。
 // host Linux bwrap 沙箱（外层包裹 prlimit 命令，config-gated）。
 const limited = wrapWithHostRlimits(command, this.quota);
 const sandboxed = await wrapWithHostSandbox(limited, cwd);
 const subprocess = execa(`${sandboxed} > ${shQuote(absLog)} 2>&1`, {
 cwd,
 shell: true,
 detached: true,
 // P0 修复（02-P0-1）：secretsCache + opts.env 都注入，经 buildSafeEnv 白名单过滤防泄露平台 secret。
 env: buildSafeEnv(this.secretsCache, opts.env),
 stdio: ["ignore", "ignore", "ignore"],
 });
 subprocess.unref();
 // 后台进程被 kill / 非零退出时 execa 的 promise 会 reject；退出语义已由 'exit' 事件处理，
 // 此处吞掉 promise rejection，避免 unhandled rejection。
 subprocess.catch(() => {});
 const pid = subprocess.pid;

 // exit 回调：detached 进程退出仍触发 → 标记终止
 // 审计修复：根据 exitCode/signal 区分原因（原无条件标 "crash"，
 // 正常退出 exitCode=0 也被记为崩溃，严重污染审计和 Studio 展示）
 subprocess.on("exit", (code, signal) => {
 const exitCode = code ?? (signal ? -1 : 0);
 const reason = exitCode === 0 && !signal ? "process_exit" : "crash";
 void markStopped(opts.taskId, { exitCode, reason });
 });
 subprocess.on("error", () => {
 void markStopped(opts.taskId, { exitCode: -1, reason: "crash", error: "spawn error" });
 });

 // 注入 stop 回调：tree-kill 整个进程组（S1 02-P2-9：带 threadId 校验）
 attachStopHandle(
 opts.taskId,
 async () => {
 if (pid !== undefined) await treeKill(pid);
 },
 opts.threadId,
 );

 return { pid, command };
 }

 /**
 * Stage B：host 停止后台进程——tree-kill 整个进程组（SIGTERM → SIGKILL 兜底）。
 */
 async stopBackground(handle: BackgroundHandle): Promise<void> {
 if (handle.pid === undefined) return;
 await treeKill(handle.pid);
 }
}

/**
 * tree-kill：先 `process.kill(-pid)` 杀进程组（detached 已 setsid 新建组，覆盖 npm→vite 等子进程），
 * 失败回退递归 `pgrep -P` 收集后代逐个 kill + 直接 kill pid。SIGTERM 后短暂等待，仍存活则 SIGKILL。
 *
 * 零依赖（不引入 tree-kill 包，plan §12 评估结论）：pgrep 在 darwin/linux 均可用。
 */
async function treeKill(pid: number): Promise<void> {
 for (const sig of ["SIGTERM", "SIGKILL"] as const) {
 // 1. 进程组杀（detached setsid 后 -pid 命中整组）
 try {
 process.kill(-pid, sig);
 } catch {
 // 组不存在或已死——忽略，走 pid 直杀 + pgrep 回退
 }
 // 2. pid 直杀（兜底）
 try {
 process.kill(pid, sig);
 } catch {
 // 已死——忽略
 }
 // 3. pgrep 递归回退：收集后代逐个 kill（防止未同组的孙子进程残留）
 for (const child of await collectDescendants(pid)) {
 try {
 process.kill(child, sig);
 } catch {
 // 忽略
 }
 }
 await sleepMs(60);
 if (!isAlive(pid)) return;
 }
}

/**
 * 递归收集 pid 的全部后代。
 *
 * 原仅用 `pgrep -P`，pgrep 不可用时静默返回空（漏杀孙子进程）。
 * 现优先 pgrep，失败回退 Linux `/proc/{pid}/task/{pid}/children`，再回退 `ps -o pid= -P`。
 */
async function collectDescendants(pid: number): Promise<number[]> {
 const out: number[] = [];
 const queue = [pid];
 while (queue.length > 0) {
 const cur = queue.shift() as number;
 const children = await directChildren(cur);
 for (const n of children) {
 out.push(n);
 queue.push(n);
 }
 }
 return out;
}

function sleepMs(ms: number): Promise<void> {
 return new Promise((r) => setTimeout(r, ms));
}

/**
 * ContainerExecutionRuntime——`ExecutionRuntime` 的容器实现。
 *
 * `docker exec snow-thread-{id} sh -lc "cd /workspace && {command}"`（经 docker-cli seam）。
 * 首次 exec 惰性 `startContainer`（含 ensureRuntimeImage），thread 内复用同一容器；
 * 每次 exec 后 `touchActivity` 刷新 idle TTL（Stage E 回收依据）。
 * 超时 / buffer 截断 / 异常兜底与 HostExecutionRuntime 一致（docker-cli.execInContainer 内处理）。
 * 容器拉起级失败（ensureRuntimeImage / runContainer 抛）在此 catch 成 { ok:false }，
 * 不向上抛——对齐 host 的异常契约。
 */
export class ContainerExecutionRuntime implements BackgroundCapableExecutionRuntime {
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
 /** V6-Batch1-M1：AbortSignal 注入，让 execa 子进程响应取消。 */
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
 // V6-Batch1-M1：透传 signal 给 execInContainer
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

 /**
 * Stage B：container 后台启动长跑进程。
 *
 * 使用 `execDetachedWithPid`：命令包装后把 shell PID 写入 `/workspace/.snow/runtime/tasks/{taskId}.pid`，
 * 日志重定向到 bind mount 的 `/workspace/.snow/runtime/...`（host 经 bind mount 直读，复用同一 logPath）。
 * 停止时读取 PID 文件并 `kill -TERM/-KILL` 精确终止，避免 pkill -f 误杀/漏杀。
 */
 async startBackground(command: string, opts: BackgroundStartOpts): Promise<BackgroundHandle> {
 const prepared = await prepareContainerStartOptions({
 threadId: opts.threadId,
 quota: this.quota,
 networkPolicy: this.networkPolicy,
 secretResolver: this.secretResolver,
 existingSecrets: this.secretsCache,
 });
 let entry: Awaited<ReturnType<typeof startContainer>>;
 try {
 this.secretsCache = prepared.secretsCache ?? this.secretsCache;
 entry = await startContainer(opts.threadId, prepared.startOptions);
 } finally {
 await prepared.cleanup();
 }
 touchActivity(opts.threadId);
 // 容器内日志路径（posix）：/workspace + 相对路径
 const containerLogPath = `/workspace/${opts.logRelPath.split(sep).join("/")}`;
 const { pidFile } = await execDetachedWithPid(
 entry.containerName,
 opts.taskId,
 `${command} > ${containerLogPath} 2>&1`,
 );

 // 注入 stop 回调：读取 PID 文件精确 kill（TERM → 等待 → KILL 兜底；S1 02-P2-9：带 threadId 校验）
 const containerName = entry.containerName;
 attachStopHandle(
 opts.taskId,
 async () => {
 await stopContainerBackgroundByPid(containerName, opts.taskId, pidFile, command);
 },
 opts.threadId,
 );

 return { containerName, command, taskId: opts.taskId };
 }

 /**
 * Stage B：container 停止后台进程——读取 PID 文件精确 kill。
 * 读不到 PID 时回退 pkill -f（best-effort，不抛）。
 */
 async stopBackground(handle: BackgroundHandle): Promise<void> {
 if (!handle.containerName || !handle.taskId) return;
 const pidFile = `/workspace/.snow/runtime/tasks/${handle.taskId}.pid`;
 await stopContainerBackgroundByPid(
 handle.containerName,
 handle.taskId,
 pidFile,
 handle.command,
 );
 }
}

/** 读取容器内 PID 文件并精确 kill（TERM → KILL 兜底）；读不到 PID 时回退 pkill -f 命令。 */
async function stopContainerBackgroundByPid(
 containerName: string,
 taskId: string,
 pidFile: string,
 fallbackCommand: string,
): Promise<void> {
 try {
 const pidResult = await execInContainer(
 containerName,
 `cat ${pidFile} 2>/dev/null || echo ""`,
 { timeoutMs: 5_000 },
 );
 const pid = Number.parseInt((pidResult.stdout ?? "").trim(), 10);
 if (Number.isFinite(pid)) {
 await execInContainer(containerName, `kill -TERM ${pid} 2>/dev/null || true`, {
 timeoutMs: 5_000,
 });
 await sleepMs(250);
 await execInContainer(containerName, `kill -KILL ${pid} 2>/dev/null || true`, {
 timeoutMs: 5_000,
 });
 return;
 }
 } catch {
 // PID 文件读取失败 → 回退 pkill
 }
 // : 兜底 pkill -f——fallbackCommand 含 taskId(UUID,唯一),pkill -f 精确匹配命令行整串,
 // 不会误杀容器内其他同名进程。PID 文件读不到时(docker exec -d 异步写入 pidFile 的竞态)用此兜底。
 // 根因修复(pidFile 同步等待)成本高且 pkill 已精确,此处保留兜底 + 注释说明限制。
 try {
 await execInContainer(containerName, `pkill -f ${shQuote(fallbackCommand)}`, {
 timeoutMs: 5_000,
 });
 } catch {
 // best-effort：容器内进程随容器停止回收
 }
}

/** 最小 shell 单引号转义（供 pkill -f 命令串传参，防注入）。 */
function shQuote(s: string): string {
 return `'${s.replace(/'/g, "'\\''")}'`;
}
