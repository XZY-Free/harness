import {
  type BrowserLease,
  DEFAULT_LEASE_TTL_MS,
  LeaseManager,
  isLeaseValid,
} from "../desktop/lease";
/**
 * V10 Phase 5：Lease 服务。
 *
 * 包装 LeaseManager，集成 DeviceRegistry 查询：在 acquireLease 前校验设备是否在线
 * 且已认证，确保 lease 不会发给离线/未认证设备。
 *
 * 安全约束：
 * - lease 持有设备必须在线且已认证（不持有幽灵 lease）
 * - 释放/检查 lease 时校验 deviceId 身份
 * - revokeLease 由 Server 强制调用（设备接管场景）
 */
import type { DeviceRegistry } from "./device-registry";

/**
 * acquireLease 返回类型。
 */
export type LeaseAcquireResult = { ok: true; lease: BrowserLease } | { ok: false; code: string };

/**
 * Lease 服务。
 */
export class LeaseService {
  private leaseManager = new LeaseManager();
  private registry: DeviceRegistry;

  constructor(registry: DeviceRegistry) {
    this.registry = registry;
  }

  /**
   * 请求获取 lease（检查设备是否在线且已认证）。
   *
   * 流程：
   * 1. 通过 deviceId 在 registry 查询设备
   * 2. 设备不存在或未认证 → 返回相应错误码
   * 3. 设备 userId 必须与请求 userId 匹配
   * 4. 调用 LeaseManager.acquireLease 获取 lease
   *
   * @param params.threadId thread ID
   * @param params.userId 用户 ID
   * @param params.deviceId 设备 ID
   * @param params.now 当前时间（epoch ms）
   * @param params.ttlMs TTL（毫秒），默认 5 分钟
   * @returns 获取成功返回 lease，失败返回错误码
   */
  acquireLease(params: {
    threadId: string;
    userId: string;
    deviceId: string;
    now: number;
    ttlMs?: number;
  }): LeaseAcquireResult {
    const { threadId, userId, deviceId, now, ttlMs = DEFAULT_LEASE_TTL_MS } = params;
    // 1. 检查设备是否在线
    const dev = this.registry.getByDeviceId(deviceId);
    if (!dev) {
      return { ok: false, code: "desktop_unavailable" };
    }
    // 2. 检查设备是否已认证
    if (!dev.authenticated) {
      return { ok: false, code: "desktop_unauthorized" };
    }
    // 3. 校验 userId 一致
    if (dev.userId !== userId) {
      return { ok: false, code: "desktop_unauthorized" };
    }
    // 4. 调用 LeaseManager 获取 lease
    const result = this.leaseManager.acquireLease(threadId, userId, deviceId, ttlMs, now);
    if (!result.ok) {
      return { ok: false, code: result.code };
    }
    return { ok: true, lease: result.lease };
  }

  /**
   * 释放 lease（检查设备身份）。
   *
   * @param threadId thread ID
   * @param deviceId 设备 ID
   * @param now 当前时间（epoch ms）
   * @returns 释放成功返回 true，非持有设备或不存在的 lease 返回 false
   */
  releaseLease(threadId: string, deviceId: string, now: number): boolean {
    return this.leaseManager.releaseLease(threadId, deviceId, now);
  }

  /**
   * 检查设备是否持有有效 lease。
   *
   * @param threadId thread ID
   * @param deviceId 设备 ID
   * @param now 当前时间（epoch ms）
   * @returns 持有未过期 lease 返回 true
   */
  holdsLease(threadId: string, deviceId: string, now: number): boolean {
    const lease = this.leaseManager.getLease(threadId);
    if (!lease) {
      return false;
    }
    if (!isLeaseValid(lease, now)) {
      return false;
    }
    return lease.deviceId === deviceId;
  }

  /**
   * 获取持有 lease 的设备。
   *
   * 注意：返回的 lease 可能已过期，调用方应自行检查 isLeaseValid。
   *
   * @param threadId thread ID
   * @returns lease 或 null
   */
  getLeaseHolder(threadId: string): BrowserLease | null {
    return this.leaseManager.getLease(threadId);
  }

  /**
   * 撤销 lease（Server 强制撤销）。
   *
   * @param threadId thread ID
   * @returns 撤销成功返回 true，不存在的 lease 返回 false
   */
  revokeLease(threadId: string): boolean {
    return this.leaseManager.revokeLease(threadId);
  }

  /**
   * 清理过期 lease。
   *
   * @param now 当前时间（epoch ms）
   * @returns 清理的 lease 数量
   */
  cleanupExpired(now: number): number {
    return this.leaseManager.cleanupExpired(now);
  }

  /**
   * 获取当前 lease 总数（含已过期未清理的）。
   *
   * 用于状态报告，不修改状态。如需精确的活跃数量，调用方应先 cleanupExpired。
   *
   * @returns lease 总数
   */
  getActiveLeaseCount(): number {
    return this.leaseManager.getActiveLeases().length;
  }
}
