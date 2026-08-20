/**
 * Browser Executor lease 逻辑。
 *
 * 当 Server 向 Desktop 发送浏览器操作命令时，Server 端先获取该 thread 的 lease，
 * 确保同一时间只有一个设备能操作某个 thread 的浏览器。lease 有 TTL，过期后
 * 可被其他设备获取。
 *
 * Lease 管理器（LeaseManager）在 Server 端使用，Desktop 端只读验证。
 *
 * 安全约束：
 * - lease 绑定 threadId，防止跨 thread 操作
 * - 只有持有设备可以释放自己的 lease
 * - Server 可以强制撤销 lease（用于设备接管）
 * - 过期 lease 自动失效，不需要显式释放
 */

/**
 * Browser lease 结构。
 *
 * 持有者用 deviceRecordId（Device.id，内部唯一身份）标识，不按 deviceKey 全局索引——
 * 同一 deviceKey 可跨租户，内部路由必须用无歧义的 Device.id。
 */
export interface BrowserLease {
  /** 绑定的 thread ID */
  threadId: string;
  /** 持有 lease 的用户 ID */
  userId: string;
  /** 持有 lease 的设备内部 ID（Device.id） */
  deviceRecordId: string;
  /** 获取时间（epoch ms） */
  acquiredAt: number;
  /** 过期时间（epoch ms） */
  expiresAt: number;
}

/**
 * 默认 lease TTL：5 分钟。
 */
export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

/**
 * 检查 lease 是否有效（未过期）。
 *
 * @param lease 待检查的 lease
 * @param now 当前时间（epoch ms）
 * @returns 未过期返回 true，已过期返回 false
 */
export function isLeaseValid(lease: BrowserLease, now: number): boolean {
  return now < lease.expiresAt;
}

/**
 * 检查 lease 是否属于指定设备（按 Device.id，即 deviceRecordId）。
 *
 * @param lease 待检查的 lease
 * @param deviceRecordId 设备内部 ID（Device.id）
 * @returns 匹配返回 true
 */
export function isLeaseHeldBy(lease: BrowserLease, deviceRecordId: string): boolean {
  return lease.deviceRecordId === deviceRecordId;
}

/**
 * 检查 lease 是否匹配 userId + threadId。
 *
 * @param lease 待检查的 lease
 * @param userId 用户 ID
 * @param threadId thread ID
 * @returns 匹配返回 true
 */
export function isLeaseForUser(lease: BrowserLease, userId: string, threadId: string): boolean {
  return lease.userId === userId && lease.threadId === threadId;
}

/**
 * 检查 lease 是否需要续期（剩余时间 < 1/3 TTL）。
 *
 * @param lease 待检查的 lease
 * @param now 当前时间（epoch ms）
 * @returns 需要续期返回 true
 */
export function needsRenewal(lease: BrowserLease, now: number): boolean {
  const remaining = lease.expiresAt - now;
  if (remaining <= 0) {
    return true;
  }
  const ttl = lease.expiresAt - lease.acquiredAt;
  return remaining < ttl / 3;
}

/**
 * acquireLease 的返回类型。
 */
export type AcquireLeaseResult = { ok: true; lease: BrowserLease } | { ok: false; code: string };

/**
 * Lease 管理器（Server 端使用，Desktop 端只读验证）。
 *
 * 维护 threadId → lease 的映射，提供获取、释放、撤销、清理功能。
 */
export class LeaseManager {
  private leases = new Map<string, BrowserLease>();

  /**
   * 获取 lease（不存在返回 null）。
   *
   * @param threadId thread ID
   * @returns lease 或 null
   */
  getLease(threadId: string): BrowserLease | null {
    return this.leases.get(threadId) ?? null;
  }

  /**
   * 尝试获取 lease。
   *
   * 如果 threadId 没有有效 lease 或 lease 已过期，则获取成功。
   * 如果已有有效 lease 且持有设备不同，则返回 lease_held_by_other。
   * 如果已有有效 lease 且持有设备相同，则续期（更新 acquiredAt 和 expiresAt）。
   *
   * @param threadId thread ID
   * @param userId 用户 ID
   * @param deviceRecordId 设备内部 ID（Device.id）
   * @param ttlMs TTL（毫秒）
   * @param now 当前时间（epoch ms）
   * @returns 获取成功返回 lease，失败返回错误码
   */
  acquireLease(
    threadId: string,
    userId: string,
    deviceRecordId: string,
    ttlMs: number,
    now: number,
  ): AcquireLeaseResult {
    const existing = this.leases.get(threadId);
    if (existing) {
      // 已有 lease
      if (isLeaseValid(existing, now)) {
        // lease 仍然有效
        if (existing.deviceRecordId === deviceRecordId) {
          // 同一设备，允许续期
          const lease: BrowserLease = {
            threadId,
            userId,
            deviceRecordId,
            acquiredAt: now,
            expiresAt: now + ttlMs,
          };
          this.leases.set(threadId, lease);
          return { ok: true, lease };
        }
        // 不同设备持有有效 lease
        return { ok: false, code: "lease_held_by_other" };
      }
      // lease 已过期，清理后可获取
      this.leases.delete(threadId);
    }
    const lease: BrowserLease = {
      threadId,
      userId,
      deviceRecordId,
      acquiredAt: now,
      expiresAt: now + ttlMs,
    };
    this.leases.set(threadId, lease);
    return { ok: true, lease };
  }

  /**
   * 释放 lease（只有持有设备可以释放）。
   *
   * @param threadId thread ID
   * @param deviceRecordId 设备内部 ID（Device.id）
   * @param now 当前时间（epoch ms）
   * @returns 释放成功返回 true，非持有设备或不存在的 lease 返回 false
   */
  releaseLease(threadId: string, deviceRecordId: string, _now: number): boolean {
    const existing = this.leases.get(threadId);
    if (!existing) {
      return false;
    }
    if (existing.deviceRecordId !== deviceRecordId) {
      return false;
    }
    this.leases.delete(threadId);
    return true;
  }

  /**
   * 撤销 lease（Server 强制撤销，用于设备接管）。
   *
   * @param threadId thread ID
   * @returns 撤销成功返回 true，不存在的 lease 返回 false
   */
  revokeLease(threadId: string): boolean {
    if (!this.leases.has(threadId)) {
      return false;
    }
    this.leases.delete(threadId);
    return true;
  }

  /**
   * 过期清理。
   *
   * @param now 当前时间（epoch ms）
   * @returns 清理的 lease 数量
   */
  cleanupExpired(now: number): number {
    let cleaned = 0;
    for (const [key, lease] of this.leases) {
      if (!isLeaseValid(lease, now)) {
        this.leases.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * 获取所有活跃 lease（未过期）。
   *
   * 注意：调用方应先调用 cleanupExpired 清理过期 lease。
   * 本方法返回 Map 中当前的所有 lease。
   *
   * @returns 活跃 lease 数组
   */
  getActiveLeases(): BrowserLease[] {
    return Array.from(this.leases.values());
  }
}
