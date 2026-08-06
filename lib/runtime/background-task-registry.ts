import { readFile } from "node:fs/promises";
import { type RuntimeType, backgroundTaskConfig } from "@/lib/config";
import {
 appendThreadEvent,
 createBackgroundTask,
 getBackgroundTask,
 listActiveBackgroundTasks,
 listActiveBackgroundTasksByThread,
 listBackgroundTasksByThread,
 markOrphanBackgroundTasksOnStartup,
 updateBackgroundTask,
} from "@/lib/db/queries";
import type { BackgroundTask, BackgroundTaskKind } from "@/lib/db/schema";
import {
 type ReadLogOpts,
 type ReadLogResult,
 appendLog,
 readLog,
 relativeLogPath,
 resolveContainerLogPath,
 resolveHostLogPath,
 resolveLogPath,
} from "./background-task-logs";

/**
 * Stage A：BackgroundTask registry——进程内 Map + DB 双层（蓝图 §12 / plan §4 / §5）。
 *
 * DB 行是可审计、可列表、进程重启标记孤儿的真实来源；进程内 `Map<taskId, LiveEntry>` 只缓存
 * pid / stop handle / runtimeType 供 stop 用，**不持久化**。
 *
 * 状态流转：
 * - `registerStart` → DB `starting` + 创建日志文件 → 返回 taskId（start 调用经 executeToolRun 立即返回）。
 * - `markRunning` → DB `running` + `task.started` 事件（的 startBackground 在拿到 pid 后调）。
 * - `markStopped` → DB `stopped`/`failed` + `task.stopped`/`task.failed` 事件，清 Map。
 * reason=crash → failed + task.failed；其余 → stopped + task.stopped。
 * - `stopAllByThread` → 逐个 stop active 任务（thread_end 用）。
 * - `markOrphansOnStartup` → 进程重启时把所有 starting/running 行诚实标 orphaned。
 *
 * stop 回调（tree-kill / pkill）由 的 ExecutionRuntime.stopBackground 经
 * `attachStopHandle` 注入；本层不直接杀进程。无 handle 的任务（DB-only / orphan）markStopped 只更 DB。
 */

/** stop 回调签名：尽力停止进程树，返回后由 registry 标 DB。 */
export type StopHandle = () => Promise<void>;

/** 新增 process_exit，区分「进程退出清理」与「thread 结束」。 */
export type TaskStopReason = "manual" | "idle" | "thread_end" | "crash" | "process_exit";

interface LiveEntry {
 threadId: string;
 runtimeType: RuntimeType;
 command: string;
 /** 注入的真实 stop 回调；缺省时 markStopped 只更 DB。 */
 stop?: StopHandle;
}

const liveTasks = new Map<string, LiveEntry>();

/** 注册一个后台任务起始：写 DB starting 行 + 创建日志文件，返回 taskId 与相对 logPath。 */
export async function registerStart(params: {
 threadId: string;
 toolRunId?: string | null;
 kind: BackgroundTaskKind;
 command: string;
 runtimeType: RuntimeType;
 port?: number | null;
}): Promise<{ taskId: string; logPath: string }> {
 // 先拿 taskId（DB 行 id 即 taskId），构造相对 logPath，再落 DB
 const row = await createBackgroundTask({
 threadId: params.threadId,
 toolRunId: params.toolRunId ?? null,
 kind: params.kind,
 command: params.command,
 runtimeType: params.runtimeType,
 logPath: "", // 占位，下面回填
 port: params.port ?? null,
 });
 const taskId = row.id;
 const logPath = relativeLogPath(params.threadId, taskId);
 await updateBackgroundTask(taskId, { logPath });

 liveTasks.set(taskId, {
 threadId: params.threadId,
 runtimeType: params.runtimeType,
 command: params.command,
 });

 // 预创建日志文件（host/container 各自绝对路径），保证后续 appendLog 可写
 const abs = resolveAbsLogPath(params.runtimeType, params.threadId, taskId);
 await appendLog(abs, "");

 return { taskId, logPath };
}

/** 标记任务 running：回填 pid/containerName/port，写 task.started 事件。 */
export async function markRunning(
 taskId: string,
 info: {
 pid?: number | null;
 containerName?: string | null;
 port?: number | null;
 },
): Promise<BackgroundTask | null> {
 const updated = await updateBackgroundTask(taskId, {
 status: "running",
 pid: info.pid ?? null,
 containerName: info.containerName ?? null,
 port: info.port ?? null,
 });
 if (!updated) return null;
 await appendThreadEvent(updated.threadId, "task.started", {
 taskId,
 kind: updated.kind,
 command: updated.command,
 runtimeType: updated.runtimeType,
 pid: updated.pid,
 port: updated.port,
 });
 return updated;
}

/**
 * 标记任务终止：reason=crash → failed + task.failed；其余 → stopped + task.stopped。清 Map。
 * 若有 stop handle，先调 stop（尽力），失败不掩盖标记。
 */
export async function markStopped(
 taskId: string,
 info: {
 exitCode?: number | null;
 reason: TaskStopReason;
 error?: string;
 },
): Promise<BackgroundTask | null> {
 const live = liveTasks.get(taskId);
 if (live?.stop) {
 try {
 await live.stop();
 } catch {
 // best-effort：stop 失败不掩盖终止标记
 }
 }
 const existing = await getBackgroundTask(taskId);
 if (!existing) {
 liveTasks.delete(taskId);
 return null;
 }
 const isCrash = info.reason === "crash";
 const status = isCrash ? "failed" : "stopped";
 const updated = await updateBackgroundTask(taskId, {
 status,
 exitCode: info.exitCode ?? null,
 finishedAt: new Date(),
 });
 liveTasks.delete(taskId);
 await appendThreadEvent(existing.threadId, isCrash ? "task.failed" : "task.stopped", {
 taskId,
 exitCode: info.exitCode ?? null,
 reason: info.reason,
 ...(info.error ? { error: info.error } : {}),
 });
 return updated ?? existing;
}

/** 停止 thread 下所有 active 后台任务（thread_end 用）。逐个调 stop + markStopped。 */
export async function stopAllByThread(threadId: string, reason: TaskStopReason): Promise<void> {
 const active = await listActiveBackgroundTasksByThread(threadId);
 // P2-11: allSettled——单任务 markStopped 失败不阻断其余任务清理,防孤儿 host 进程残留
 await Promise.allSettled(active.map((t) => markStopped(t.id, { reason })));
}

/** 列 thread 全部后台任务（按 startedAt desc）。 */
export async function listByThread(threadId: string): Promise<BackgroundTask[]> {
 return listBackgroundTasksByThread(threadId);
}

/** 按 id 取后台任务。 */
export async function getTask(taskId: string): Promise<BackgroundTask | null> {
 return getBackgroundTask(taskId);
}

/**
 * 读取任务日志片段。校验 taskId 存在；按 runtimeType 解析绝对路径；受 maxLogReadBytes 限长。
 */
export async function readTaskLogs(
 taskId: string,
 opts: ReadLogOpts = {},
): Promise<ReadLogResult | null> {
 const task = await getBackgroundTask(taskId);
 if (!task) return null;
 const abs = resolveLogPath(task.logPath, task.runtimeType, task.threadId);
 // touch lastActivityAt（读取也算活跃，供 idle sweep 判断）
 await updateBackgroundTask(taskId, {}).catch(() => {});
 return readLog(abs, opts);
}

/**
 * 进程启动时把所有 starting/running 行标 orphaned（诚实标记，不 reattach）。
 * 返回被标记的任务（调用方可记日志 / 通知 Studio）。
 *
 * 对带 pid 的孤儿进程 best-effort 发 SIGTERM（防资源泄漏）。
 * : kill 前读 /proc/{pid}/cmdline 校验 pid 仍是同一进程(防 PID 复用误杀非自己起的进程)。
 * 容器态任务的进程在容器内，host 侧 kill(pid) 无效，仅 host 态 pid 生效。
 */
async function isSameProcess(pid: number, taskId: string): Promise<boolean> {
 try {
 const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
 // host 态后台任务 command 含 taskId(pidFile 路径 /workspace/.snow/runtime/tasks/${taskId}.pid)
 return cmdline.replace(/\0/g, " ").includes(taskId);
 } catch {
 // /proc 不可读(darwin/非 Linux)或 pid 不存在 → 不校验,保持原 best-effort 行为
 return true;
 }
}

export async function markOrphansOnStartup(): Promise<BackgroundTask[]> {
 const orphans = await markOrphanBackgroundTasksOnStartup();
 // 进程内 Map 在新进程本就为空，清一次防御
 liveTasks.clear();
 // best-effort 杀 host 态孤儿 pid（容器态 pid 在容器内，host kill 无效）
 for (const t of orphans) {
 if (t.runtimeType === "host" && typeof t.pid === "number" && t.pid > 0) {
 try {
 process.kill(t.pid, 0); // 探活：仍存活才发信号
 // : 校验 pid 仍是同一进程,防 PID 复用误杀
 if (!(await isSameProcess(t.pid, t.id))) continue;
 process.kill(t.pid, "SIGTERM");
 } catch {
 // pid 已死或不归本进程管——忽略（best-effort）
 }
 }
 }
 return orphans;
}

// ─── 退出清理 / idle sweep（Stage B/E 接入） ────────────────

/** 进程退出时停止所有 active 后台任务（best-effort，不阻塞退出）。reason=process_exit。 */
export async function closeAllBackgroundTasks(): Promise<void> {
 const active = await listActiveBackgroundTasks();
 // P2-11: allSettled——进程退出时单任务清理失败不阻断其余,防孤儿 host 进程残留
 await Promise.allSettled(active.map((t) => markStopped(t.id, { reason: "process_exit" })));
}

/**
 * idle sweep：扫描 active 后台任务，lastActivityAt 超 idleTtlMs → stop(reason=idle)。
 * 由 lib/runtime/container/manager.startIdleSweep 复用模式调用。
 */
export async function sweepIdleBackgroundTasks(): Promise<void> {
 const active = await listActiveBackgroundTasks();
 const now = Date.now();
 const ttl = backgroundTaskConfig.idleTtlMs;
 for (const t of active) {
 const last =
 t.lastActivityAt instanceof Date ? t.lastActivityAt.getTime() : Number(t.lastActivityAt);
 if (Number.isFinite(last) && now - last > ttl) {
 await markStopped(t.id, { reason: "idle" });
 }
 }
}

/**
 * 注入真实 stop 回调（tree-kill / pkill）。
 *
 * 增加 threadId 校验——只允许该 taskId 所属 thread 注入 stop handle，
 * 防止跨 thread 误注入（liveTasks 是全局 Map，原实现只查 taskId 不校验 threadId）。
 */
export function attachStopHandle(taskId: string, stop: StopHandle, threadId?: string): void {
 const entry = liveTasks.get(taskId);
 if (!entry) return;
 if (threadId !== undefined && entry.threadId !== threadId) return;
 entry.stop = stop;
}

/** 读绝对日志路径辅助（测试可直查）。 */
export function resolveAbsLogPath(
 runtimeType: RuntimeType,
 threadId: string,
 taskId: string,
): string {
 return runtimeType === "container"
 ? resolveContainerLogPath(threadId, taskId)
 : resolveHostLogPath(threadId, taskId);
}

/** 仅供测试：清空进程内 Map（不触 DB）。 */
export function __clearBackgroundTaskRegistryForTest(): void {
 liveTasks.clear();
}
