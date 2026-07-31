import { runtimeConfig } from "@/lib/config";

/**
 * Phase 5 Stage B：容器 port mapping 分配 registry。
 *
 * 进程内单例 `Map<threadId, port>`：从 `runtimeConfig.portRangeStart` 递增分配，
 * `usedPorts` Set 去重。容器态不持久化（plan §0.1 / Rejected），进程重启清空，
 * 下次访问惰性重拉容器（新端口）。
 *
 * 简化：仅进程内去重，不探测系统端口占用（单机单进程假设）；多 thread 并行由本模块
 * 保证分配不同 port。真实端口冲突（系统其他进程占用）由 docker run 失败暴露。
 */

const allocation = new Map<string, number>();
const usedPorts = new Set<number>();
let cursor = runtimeConfig.portRangeStart;

/** 为 thread 分配端口（已分配则复用）。端口耗尽抛错。 */
export function allocatePort(threadId: string): number {
  const existing = allocation.get(threadId);
  if (existing !== undefined) return existing;

  const end = runtimeConfig.portRangeEnd;
  while (usedPorts.has(cursor)) {
    cursor++;
  }
  if (cursor > end) {
    throw new Error(
      `[runtime] 端口耗尽（${runtimeConfig.portRangeStart}-${end}）；请提高 SNOW_RUNTIME_PORT_END 或回收空闲 thread`,
    );
  }
  const port = cursor;
  cursor++;
  allocation.set(threadId, port);
  usedPorts.add(port);
  return port;
}

/** 读 thread 已分配端口（未分配返回 undefined）。 */
export function getPort(threadId: string): number | undefined {
  return allocation.get(threadId);
}

/** 释放 thread 端口（容器回收时调）。 */
export function releasePort(threadId: string): void {
  const p = allocation.get(threadId);
  if (p !== undefined) {
    allocation.delete(threadId);
    usedPorts.delete(p);
  }
}

/** 仅供测试 / 进程退出：清空全部分配。 */
export function clearPorts(): void {
  allocation.clear();
  usedPorts.clear();
  cursor = runtimeConfig.portRangeStart;
}
