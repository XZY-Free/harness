import { runtimeConfig } from "@/lib/config";
import { workspaceRoot } from "@/lib/workspace";
import {
  closeAllBackgroundTasks,
  stopAllByThread,
  sweepIdleBackgroundTasks,
} from "../background-task-registry";
import { dockerNetworkMode } from "../network-policy";
import type { NetworkPolicy, ResourceQuota } from "../types";
import { listContainersByLabel, removeContainer, runContainer, stopContainer } from "./docker-cli";
import { ensureRuntimeImage } from "./image";
import { allocatePort, releasePort } from "./ports";
import { cleanupSecretFileCache } from "./start-options";

/**
 * Phase 5 Stage B：容器生命周期管理（单机 docker daemon）。
 *
 * 进程内 `Map<threadId, ContainerEntry>` 单例——容器态不持久化（plan Rejected），
 * 进程重启后 Map 清空，下次访问惰性重拉（先清理同名旧容器再 run）。
 *
 * 生命周期：
 * - 拉起：`startContainer(threadId)` 惰性（首次 exec / startPreview 前），thread 内复用
 * - 回收：`stopContainer(threadId)` 主动停删；idle TTL 回收在 Stage E 实现
 * - 退出：`closeAllContainers()` 进程退出时清所有容器
 *
 * 容器名 `snow-thread-{threadId}`，标签 `snow-harness.threadId={threadId}` 便于查询。
 */

export interface ContainerEntry {
  containerName: string;
  containerId: string;
  port: number;
  state: "running" | "stopped";
  lastActivityAt: number;
}

const containers = new Map<string, ContainerEntry>();

function containerName(threadId: string): string {
  return `snow-thread-${threadId}`;
}

/** 拉起容器（已存在则复用）。惰性：Map 无则清理同名旧容器 + run 新容器。 */
export async function startContainer(
  threadId: string,
  opts?: {
    quota?: ResourceQuota;
    networkPolicy?: NetworkPolicy;
    /** V3.8：secret env 文件路径（--env-file，不写命令行防泄露）。 */
    secretEnvFile?: string;
    /** S1（02-P2-5）：额外 docker run 参数（如 --add-host），透传 runContainer。 */
    extraArgs?: string[];
  },
): Promise<ContainerEntry> {
  const existing = containers.get(threadId);
  if (existing && existing.state === "running") {
    existing.lastActivityAt = Date.now();
    return existing;
  }

  const name = containerName(threadId);
  // 惰性重拉：清理同名旧容器（进程重启后 docker 里可能残留；-f 对不存在容器不报错）
  await removeContainer(name);
  await ensureRuntimeImage();

  // V3.8：per-thread 配额覆盖全局默认（memory/cpus）。quota 在 resolveQuota 已保证只能收紧。
  const memory = opts?.quota?.memory ?? runtimeConfig.memoryLimit;
  const cpus = opts?.quota?.cpu ?? runtimeConfig.cpus;
  // S1（04-G2）：进程数 + 文件描述符限额（docker --pids-limit / --ulimit nofile）。
  const pidsLimit = opts?.quota?.pidsLimit ?? 0;
  const openFilesLimit = opts?.quota?.openFilesLimit ?? 0;
  // S1（02-P1-6）：容器 rootfs 磁盘配额（docker --storage-opt size=）
  const diskQuotaBytes = opts?.quota?.diskQuotaBytes ?? 0;
  const port = allocatePort(threadId);

  // V3.8：网络策略（S1 方案 B：只 disabled | open）
  const policy = opts?.networkPolicy ?? { mode: "open" as const };
  const networkMode = dockerNetworkMode(policy);
  const env: string[] = [`PORT=${port}`];

  let containerId: string;
  try {
    containerId = await runContainer({
      name,
      image: runtimeConfig.runtimeImage,
      threadId,
      hostPath: workspaceRoot(threadId),
      port,
      memory,
      cpus,
      env,
      networkMode,
      envFile: opts?.secretEnvFile,
      pidsLimit,
      openFilesLimit,
      diskQuotaBytes,
      extraArgs: opts?.extraArgs,
    });
  } catch (error) {
    releasePort(threadId);
    throw error;
  }

  const entry: ContainerEntry = {
    containerName: name,
    containerId,
    port,
    state: "running",
    lastActivityAt: Date.now(),
  };
  containers.set(threadId, entry);
  return entry;
}

/** 读容器 entry（未启动返回 null）。 */
export function getContainer(threadId: string): ContainerEntry | null {
  return containers.get(threadId) ?? null;
}

/** 更新最近活动时间（exec / preview 探活时调，供 idle TTL 回收判断）。 */
export function touchActivity(threadId: string): void {
  const entry = containers.get(threadId);
  if (entry) entry.lastActivityAt = Date.now();
}

/**
 * 停删单个容器 + 释放端口 + 关闭 egress proxy。
 *
 * S1 修复（02-P1-3）：先停该 thread 的所有后台任务（防止容器停止后 task 进程变孤儿、
 * stop handle 失效）。closeAllContainers 路径已先调 closeAllBackgroundTasks，此处再调是
 * 幂等兜底（已 markStopped 的任务 listActive 不返回）。
 */
export async function stopContainerById(threadId: string): Promise<void> {
  const entry = containers.get(threadId);
  if (!entry) return;
  try {
    await stopAllByThread(threadId, "thread_end");
  } catch {
    // best-effort：后台任务清理失败不阻塞容器停删
  }
  await stopContainer(entry.containerName);
  await removeContainer(entry.containerName);
  releasePort(threadId);
  // S1（02-P1-9）：清理缓存的 secret env 文件（容器停止，下次 start 重新写入）
  await cleanupSecretFileCache(threadId).catch(() => {});
  containers.delete(threadId);
}

/** 进程退出时关闭所有容器。先回收所有后台任务（tree-kill/pkill），再停删容器。 */
export async function closeAllContainers(): Promise<void> {
  // V3.2：先停所有后台任务（进程树回收），避免容器停止时留下孤儿进程记录。
  // 防御：测试用部分 mock 时 closeAllBackgroundTasks 可能为 undefined，optional call 避免 teardown 抛错。
  try {
    await closeAllBackgroundTasks?.().catch(() => {});
  } catch {
    // best-effort：退出清理不阻塞
  }
  const ids = [...containers.keys()];
  await Promise.all(ids.map((id) => stopContainerById(id).catch(() => {})));
}

// ─── idle TTL 回收（Phase 5 Stage E）──────────────────────────────

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * 启动 idle 回收定时器：扫描 containers，`lastActivityAt` 超 `runtimeConfig.idleTtlMs`
 * （默认 10min）的 thread 停删容器 + 释放端口。进程退出自动停止（unref）。
 * host 模式下 containers 恒空，sweep 空跑无副作用。instrumentation 启动时调一次。
 */
export function startIdleSweep(intervalMs = 60_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    const ttl = runtimeConfig.idleTtlMs;
    for (const [tid, entry] of containers) {
      if (now - entry.lastActivityAt > ttl) {
        void stopContainerById(tid).catch(() => {});
      }
    }
    // V3.2：同步扫后台任务 idle（lastActivityAt 超 TTL → stop(reason=idle)），复用同一定时器
    void sweepIdleBackgroundTasks().catch(() => {});
    // S1（09-P1-4）：轮询 deploying 状态的 deployment（防永远停在 deploying）
    void import("@/lib/deploy/cicd-target").then((m) => m.sweepDeployingStatuses()).catch(() => {});
    // V6-M1-4：扫描 delivering 状态超时的 thread，回退为 failed（防状态机悬空）
    void import("@/lib/delivery/sweep")
      .then((m) => m.sweepStaleDeliveringThreads())
      .catch(() => {});
  }, intervalMs);
  sweepTimer.unref?.();
}

/**
 * 进程退出清理：best-effort（不阻塞退出）。
 * Note：Stage E 引入 idle TTL 定时回收；此处只做退出清理。
 */
if (!globalThis.__snowContainerCleanup) {
  globalThis.__snowContainerCleanup = true;
  const trigger = () => {
    void closeAllContainers();
  };
  process.once("SIGTERM", trigger);
  process.once("SIGINT", trigger);
  process.once("beforeExit", trigger);
}

/** 按标签查询容器（诊断/清理用）。 */
export async function listThreadContainers(threadId: string): Promise<string[]> {
  return listContainersByLabel("snow-harness.threadId", threadId);
}

/** 仅供测试：清空内存 registry（不触 docker）。 */
export function __clearContainerRegistryForTest(): void {
  containers.clear();
}

declare global {
  // eslint-disable-next-line no-var
  var __snowContainerCleanup: boolean | undefined;
}
