import { quotaConfig } from "@/lib/config";
import type { ResourceQuota } from "./types";

/**
 * V3.8 Stage A：per-thread 资源配额解析。
 *
 * 配额继承全局默认(quotaConfig)，per-thread 覆盖**只能收紧不能放宽**：
 * - CPU/memory：取更小值（解析 "1.0"/"0.5" → 数值比较；"1g"/"512m" → 字节数比较）。
 * - timeoutMs/logCapBytes：取 Math.min。
 *
 * container 模式：docker `--memory` / `--cpus` 硬配额（cgroup 约束）。
 * host 模式：timeout + logCapBytes soft limit + 诚实标注 `quotaEnforced=false`。
 */

/** 解析 CPU 字符串为数值（"1.0" → 1.0, "0.5" → 0.5）。非法返回 0。 */
export function parseCpu(s: string): number {
  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 解析内存字符串为字节数（"1g" → 1073741824, "512m" → 536870912, "1024" → 1024）。非法返回 0。 */
export function parseMemory(s: string): number {
  const trimmed = s.trim().toLowerCase();
  const match = /^(?<num>[\d.]+)(?<unit>[kmgt]?)b?$/.exec(trimmed);
  if (!match?.groups) return 0;
  const num = Number.parseFloat(match.groups.num ?? "");
  if (!Number.isFinite(num) || num < 0) return 0;
  const multipliers: Record<string, number> = {
    "": 1,
    k: 1024,
    m: 1024 ** 2,
    g: 1024 ** 3,
    t: 1024 ** 4,
  };
  const unit = match.groups.unit ?? "";
  return Math.floor(num * (multipliers[unit] ?? 1));
}

/** 格式化字节数为可读内存字符串（用于 docker --memory）。 */
export function formatMemory(bytes: number): string {
  if (bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0) return `${bytes / 1024 ** 3}g`;
  if (bytes >= 1024 ** 2 && bytes % 1024 ** 2 === 0) return `${bytes / 1024 ** 2}m`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}k`;
  return `${bytes}`;
}

/** 取两个 CPU 值中更小的（收紧）。空/非法视为无穷大（不约束）。 */
function minCpu(base: string, override: string): string {
  const b = parseCpu(base);
  const o = parseCpu(override);
  if (b === 0 && o === 0) return base;
  if (b === 0) return override;
  if (o === 0) return base;
  return o <= b ? override : base;
}

/** 取两个内存值中更小的（收紧）。空/非法视为无穷大（不约束）。 */
function minMemory(base: string, override: string): string {
  const b = parseMemory(base);
  const o = parseMemory(override);
  if (b === 0 && o === 0) return base;
  if (b === 0) return override;
  if (o === 0) return base;
  return o <= b ? override : base;
}

/**
 * 合并配额：全局默认 + per-thread 覆盖（只能收紧不能放宽）。
 *
 * @param threadOverride per-thread 覆盖值。每个字段独立收紧：
 *   - cpu/memory：取更小值
 *   - timeoutMs/logCapBytes：取 Math.min
 */
export function tightenQuota(base: ResourceQuota, override: Partial<ResourceQuota>): ResourceQuota {
  const result: ResourceQuota = { ...base };
  if (override.cpu) result.cpu = minCpu(base.cpu ?? "", override.cpu);
  if (override.memory) result.memory = minMemory(base.memory ?? "", override.memory);
  if (override.timeoutMs !== undefined) {
    result.timeoutMs = Math.min(base.timeoutMs ?? Number.POSITIVE_INFINITY, override.timeoutMs);
  }
  if (override.logCapBytes !== undefined) {
    result.logCapBytes = Math.min(
      base.logCapBytes ?? Number.POSITIVE_INFINITY,
      override.logCapBytes,
    );
  }
  // S1（04-G2）：pidsLimit / openFilesLimit 只能收紧（取更小非零值；0=不限视为无穷大）。
  if (override.pidsLimit !== undefined) {
    const b = base.pidsLimit ?? 0;
    const o = override.pidsLimit;
    result.pidsLimit = b === 0 ? o : o === 0 ? b : Math.min(b, o);
  }
  if (override.openFilesLimit !== undefined) {
    const b = base.openFilesLimit ?? 0;
    const o = override.openFilesLimit;
    result.openFilesLimit = b === 0 ? o : o === 0 ? b : Math.min(b, o);
  }
  // S1（02-P1-6）：diskQuotaBytes 只能收紧
  if (override.diskQuotaBytes !== undefined) {
    const b = base.diskQuotaBytes ?? 0;
    const o = override.diskQuotaBytes;
    result.diskQuotaBytes = b === 0 ? o : o === 0 ? b : Math.min(b, o);
  }
  return result;
}

/**
 * 解析 per-thread 资源配额：继承全局 quotaConfig 默认 + 可选 thread 覆盖（只能收紧）。
 */
export function resolveQuota(opts?: {
  threadOverride?: Partial<ResourceQuota>;
}): ResourceQuota {
  const global: ResourceQuota = {
    cpu: quotaConfig.cpu,
    memory: quotaConfig.memory,
    timeoutMs: quotaConfig.timeoutMs,
    logCapBytes: quotaConfig.logCapBytes,
    pidsLimit: quotaConfig.pidsLimit,
    openFilesLimit: quotaConfig.openFilesLimit,
    diskQuotaBytes: quotaConfig.diskQuotaBytes,
  };
  if (!opts?.threadOverride) return global;
  return tightenQuota(global, opts.threadOverride);
}
