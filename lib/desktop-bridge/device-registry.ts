/**
 * ：已连接设备注册表。
 *
 * 维护 WebSocket 连接 ↔ 设备 的双向映射，支持按 ws / deviceId / userId 快速查找。
 * 全部状态在内存中（进程级），不持久化：进程重启后所有连接必须重新认证。
 *
 * 线程安全：所有方法同步执行，无 async 操作。
 * 并发安全：Node.js 单线程事件循环，无需锁。
 *
 * 安全约束：
 * - 同一 ws 重新注册会覆盖原设备信息（断开重连场景）
 * - 设备认证状态默认 false，必须显式 markAuthenticated
 */
/**
 * 已连接的 Desktop 设备。
 */
export interface ConnectedDevice {
  /** WebSocket 实例（unknown 避免依赖 ws 类型） */
  ws: unknown;
  /** 设备标识（Desktop 本地生成） */
  deviceId: string;
  /** DB 中 DesktopDevice.id */
  deviceRecordId: string;
  /** 所属用户 ID */
  userId: string;
  /** 是否已通过认证 */
  authenticated: boolean;
  /** 连接建立时间（epoch ms） */
  connectedAt: number;
  /** 最后心跳时间（epoch ms） */
  lastHeartbeat: number;
  /** Desktop 收到的 Server 公钥（base64） */
  serverPublicKeyBase64: string;
}

/**
 * 已连接设备注册表。
 *
 * 维护 ws → ConnectedDevice 和 deviceId → ConnectedDevice 的索引。
 */
export class DeviceRegistry {
  private byWs = new Map<unknown, ConnectedDevice>();
  private byDeviceId = new Map<string, ConnectedDevice>();

  /**
   * 按 WebSocket 实例查找设备。
   *
   * @param ws WebSocket 实例
   * @returns 设备信息或 null
   */
  getByWs(ws: unknown): ConnectedDevice | null {
    return this.byWs.get(ws) ?? null;
  }

  /**
   * 按 deviceId 查找设备。
   *
   * @param deviceId 设备 ID
   * @returns 设备信息或 null
   */
  getByDeviceId(deviceId: string): ConnectedDevice | null {
    return this.byDeviceId.get(deviceId) ?? null;
  }

  /**
   * 获取用户的所有在线设备。
   *
   * @param userId 用户 ID
   * @returns 该用户的所有在线设备（未排序）
   */
  getByUserId(userId: string): ConnectedDevice[] {
    const result: ConnectedDevice[] = [];
    for (const dev of this.byWs.values()) {
      if (dev.userId === userId) {
        result.push(dev);
      }
    }
    return result;
  }

  /**
   * 注册设备（WebSocket 连接后调用）。
   *
   * 同一 ws 重新注册会覆盖原设备信息，并清理原 deviceId 索引。
   *
   * @param ws WebSocket 实例
   * @param deviceId 设备 ID
   * @param deviceRecordId DB 中的设备记录 ID
   * @param userId 用户 ID
   * @param serverPublicKeyBase64 Server 公钥（base64）
   * @returns 新建的 ConnectedDevice
   */
  register(
    ws: unknown,
    deviceId: string,
    deviceRecordId: string,
    userId: string,
    serverPublicKeyBase64: string,
  ): ConnectedDevice {
    // 清理同一 ws 的旧注册（断开重连）
    const existingByWs = this.byWs.get(ws);
    if (existingByWs) {
      this.byDeviceId.delete(existingByWs.deviceId);
      this.byWs.delete(ws);
    }
    // 清理同一 deviceId 的旧注册（设备重新连接，可能用新 ws）
    const existingByDeviceId = this.byDeviceId.get(deviceId);
    if (existingByDeviceId) {
      this.byWs.delete(existingByDeviceId.ws);
      this.byDeviceId.delete(deviceId);
    }
    const now = Date.now();
    const dev: ConnectedDevice = {
      ws,
      deviceId,
      deviceRecordId,
      userId,
      authenticated: false,
      connectedAt: now,
      lastHeartbeat: now,
      serverPublicKeyBase64,
    };
    this.byWs.set(ws, dev);
    this.byDeviceId.set(deviceId, dev);
    return dev;
  }

  /**
   * 标记设备已认证。
   *
   * @param ws WebSocket 实例
   * @returns 成功返回 true，未注册返回 false
   */
  markAuthenticated(ws: unknown): boolean {
    const dev = this.byWs.get(ws);
    if (!dev) {
      return false;
    }
    dev.authenticated = true;
    return true;
  }

  /**
   * 更新心跳时间。
   *
   * @param ws WebSocket 实例
   * @param now 当前时间（epoch ms）
   * @returns 成功返回 true，未注册返回 false
   */
  updateHeartbeat(ws: unknown, now: number): boolean {
    const dev = this.byWs.get(ws);
    if (!dev) {
      return false;
    }
    dev.lastHeartbeat = now;
    return true;
  }

  /**
   * 移除设备（断开连接时调用）。
   *
   * @param ws WebSocket 实例
   * @returns 被移除的设备或 null
   */
  remove(ws: unknown): ConnectedDevice | null {
    const dev = this.byWs.get(ws);
    if (!dev) {
      return null;
    }
    this.byWs.delete(ws);
    // 注意：deviceId 索引可能已被新 ws 覆盖，仅当仍指向同一 dev 时才删除
    const cur = this.byDeviceId.get(dev.deviceId);
    if (cur === dev) {
      this.byDeviceId.delete(dev.deviceId);
    }
    return dev;
  }

  /**
   * 获取所有在线且已认证的设备。
   *
   * @returns 已认证设备数组
   */
  getAuthenticatedDevices(): ConnectedDevice[] {
    const result: ConnectedDevice[] = [];
    for (const dev of this.byWs.values()) {
      if (dev.authenticated) {
        result.push(dev);
      }
    }
    return result;
  }

  /**
   * 获取设备总数。
   *
   * @returns 当前在线设备数
   */
  size(): number {
    return this.byWs.size;
  }

  /**
   * 清理过期设备（心跳超时）。
   *
   * @param now 当前时间（epoch ms）
   * @param timeoutMs 心跳超时阈值（毫秒）
   * @returns 被清理的设备数组
   */
  cleanupStale(now: number, timeoutMs: number): ConnectedDevice[] {
    const stale: ConnectedDevice[] = [];
    const cutoff = now - timeoutMs;
    for (const [ws, dev] of this.byWs) {
      if (dev.lastHeartbeat < cutoff) {
        stale.push(dev);
        this.byWs.delete(ws);
        const cur = this.byDeviceId.get(dev.deviceId);
        if (cur === dev) {
          this.byDeviceId.delete(dev.deviceId);
        }
      }
    }
    return stale;
  }
}
