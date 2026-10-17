/**
 * 记忆 TTL 归档 sweep（⑥ 遗忘的真实触发）。
 *
 * 背景：`archiveExpiredMemoryEntries`（memory-queries）此前**无调用方**——
 * TTL 策略写了但从不执行，过期记忆永远留在检索集里（"遗忘"功能空转）。
 *
 * 本模块按既有 `startIdleSweep()` 范式，在 `instrumentation.ts` 启动一个
 * **低频定时器**（默认 1 小时；`unref` 不阻塞进程退出），周期性归档已过期记忆。
 *
 * 语义：**归档不物理删**（memoryState: active → archived），保留历史、退出检索。
 * 幂等：只扫 active 且 expiresAt 已过期的行；重复执行不会重复归档。
 */
import { contextConfig } from "@/lib/config";
import { archiveExpiredMemoryEntries } from "@/lib/context/memory-queries";
import { logger } from "@/lib/logger";

/** sweep 间隔（ms）；env 可配，默认 1 小时。 */
function sweepIntervalMs(): number {
  return (
    Number.parseInt(process.env.NEX_MEMORY_TTL_SWEEP_MS ?? String(60 * 60 * 1000), 10) ||
    60 * 60 * 1000
  );
}

/** 单次归档批次上限。 */
function sweepBatchLimit(): number {
  return Number.parseInt(process.env.NEX_MEMORY_TTL_SWEEP_BATCH ?? "500", 10) || 500;
}

/**
 * 跑一轮 TTL 归档（可独立调用，供测试与手动触发）。
 *
 * @returns 归档条数
 */
export async function runMemoryTtlSweep(): Promise<number> {
  try {
    const archived = await archiveExpiredMemoryEntries({ limit: sweepBatchLimit() });
    if (archived > 0) {
      logger.info(`[memory-ttl] 归档过期记忆 ${archived} 条`);
    }
    return archived;
  } catch (err) {
    logger.warn(`[memory-ttl] 归档失败（下轮重试）：${err instanceof Error ? err.message : err}`);
    return 0;
  }
}

/** 已启动标记（避免热重载重复起定时器）。 */
let started = false;

/**
 * 启动记忆 TTL sweep 定时器（对标 `startIdleSweep`：`unref` 不阻塞退出）。
 */
export function startMemoryTtlSweep(): void {
  if (started) return;
  started = true;
  const interval = sweepIntervalMs();
  const timer = setInterval(() => {
    void runMemoryTtlSweep();
  }, interval);
  // 不阻塞进程退出
  timer.unref?.();
  logger.info(
    `[memory-ttl] TTL 归档 sweep 已启动（间隔 ${Math.round(interval / 1000)}s，阈值 expiresAt ≤ now）`,
  );
}

/** 供可观测的配置快照。 */
export function memoryTtlSweepConfigSnapshot(): { intervalMs: number; batchLimit: number } {
  return { intervalMs: sweepIntervalMs(), batchLimit: sweepBatchLimit() };
}

/** 记忆 TTL 策略快照（与 resolveMemoryTtl 对应，供可观测）。 */
export const MEMORY_TTL_SWEEP_DEFAULTS = {
  feedbackDays: 30,
  decisionDays: 180,
  userProjectReferenceNever: true,
} as const;

/** 引用 contextConfig（保持与压缩/flush 同一配置来源）。 */
export function memoryTtlContextSnapshot(): { budgetThreshold: number } {
  return { budgetThreshold: contextConfig.budgetThreshold };
}
