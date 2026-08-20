/**
 * 已连接设备注册表。
 *
 * 维护 WebSocket 连接 ↔ 设备 的双向映射，支持按 ws / deviceRecordId / (tenantId, deviceKey)
 * 快速查找。全部状态在内存中（进程级），不持久化：进程重启后所有连接必须重新认证。
 *
 * 线程安全：所有方法同步执行，无 async 操作。
 * 并发安全：Node.js 单线程事件循环，无需锁。
 *
 * 索引设计（无歧义，杜绝按 deviceKey 全局索引）：
 * - byWs：ws → 设备（连接主索引）
 * - byDeviceRecordId：Device.id（正式内部唯一身份）→ 设备
 * - byKey：复合键 (tenantId, deviceKey) → 设备（外部认证/撤销定位键）
 *
 * 同一 deviceKey 可存在于不同租户。注册时以复合键 (tenantId, deviceKey) 定位，因此
 * 重连同一台设备只替换自身，绝不驱逐另一租户的相同 deviceKey。
 *
 * 安全约束：
 * - 同一 ws 重新注册会覆盖原设备信息（断开重连场景）
 * - 设备认证状态默认 false，必须显式 markAuthenticated
 * - 内部路由一律用 deviceRecordId（Device.id），wire 协议才用 deviceKey
 */
/**
 * 已连接的 Desktop 设备。
 */
export interface ConnectedDevice {
  /** WebSocket 实例（unknown 避免依赖 ws 类型） */
  ws: unknown;
  /** 外部设备标识（Desktop 本地生成，即正式模型的 deviceKey） */
  deviceKey: string;
  /** 设备所属租户（正式 Device 唯一键 (tenantId, deviceKey) 的一部分） */
  tenantId: string;
  /** DB 中 Device.id（内部唯一身份，路由/lease/cancel 一律用此） */
  deviceRecordId: string;
  /** 所属用户 ID（UserIdentity id） */
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
 * 复合键 (tenantId, deviceKey) 的编码，避免与设备内部 id 混淆。
 */
function compositeKey(tenantId: string, deviceKey: string): string {
  return JSON.stringify([tenantId, deviceKey]);
}

/**
 * 已连接设备注册表。
 *
 * 维护 ws / deviceRecordId / (tenantId, deviceKey) 三个索引。
 */
export class DeviceRegistry {
  private byWs = new Map<unknown, ConnectedDevice>();
  private byDeviceRecordId = new Map<string, ConnectedDevice>();
  private byKey = new Map<string, ConnectedDevice>();

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
   * 按 Device.id（deviceRecordId）查找设备。
   *
   * 内部路由（lease / RPC / cancel）一律用此定位，设备内部唯一身份是 Device.id，
   * 不按 deviceKey 全局索引（同一 deviceKey 可跨租户，无法唯一定位）。
   *
   * @param deviceRecordId Device.id
   * @returns 设备信息或 null
   */
  getByDeviceRecordId(deviceRecordId: string): ConnectedDevice | null {
    return this.byDeviceRecordId.get(deviceRecordId) ?? null;
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
   * 以复合键 (tenantId, deviceKey) 定位：同一复合键（同一台设备）重连只替换自身，
   * 绝不驱逐另一租户的相同 deviceKey。同一 ws 重新注册会覆盖原设备信息。
   *
   * @param ws WebSocket 实例
   * @param tenantId 设备所属租户
   * @param deviceKey 设备标识（正式模型的 deviceKey）
   * @param deviceRecordId DB 中的设备记录 ID（Device.id）
   * @param userId 用户 ID
   * @param serverPublicKeyBase64 Server 公钥（base64）
   * @returns 新建的 ConnectedDevice
   */
  register(
    ws: unknown,
    tenantId: string,
    deviceKey: string,
    deviceRecordId: string,
    userId: string,
    serverPublicKeyBase64: string,
  ): ConnectedDevice {
    const key = compositeKey(tenantId, deviceKey);
    // 清理同一 ws 的旧注册（断开重连）
    const existingByWs = this.byWs.get(ws);
    if (existingByWs) {
      this.removeEntry(existingByWs);
    }
    // 清理同一复合键 (tenantId, deviceKey) 的旧注册（同一台设备重连，可能用新 ws）。
    // 只替换自身：不同租户的相同 deviceKey 复合键不同，不会被驱逐。
    const existingByKey = this.byKey.get(key);
    if (existingByKey && existingByKey.ws !== ws) {
      this.removeEntry(existingByKey);
    }
    const now = Date.now();
    const dev: ConnectedDevice = {
      ws,
      tenantId,
      deviceKey,
      deviceRecordId,
      userId,
      authenticated: false,
      connectedAt: now,
      lastHeartbeat: now,
      serverPublicKeyBase64,
    };
    this.byWs.set(ws, dev);
    this.byDeviceRecordId.set(deviceRecordId, dev);
    this.byKey.set(key, dev);
    return dev;
  }

  /**
   * 按 (tenantId, deviceKey) 复合键查找设备。
   *
   * 外部认证 / 撤销定位键。同一 deviceKey 可存在于不同租户，复合键保证租户隔离，
   * 避免跨租户误踢 / 误路由。
   *
   * @returns 设备信息或 null
   */
  getByKey(tenantId: string, deviceKey: string): ConnectedDevice | null {
    return this.byKey.get(compositeKey(tenantId, deviceKey)) ?? null;
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
    this.removeEntry(dev);
    return dev;
  }

  /**
   * 从全部索引中移除一个设备条目（幂等）。
   */
  private removeEntry(dev: ConnectedDevice): void {
    const byWs = this.byWs.get(dev.ws);
    if (byWs === dev) {
      this.byWs.delete(dev.ws);
    }
    const byRecord = this.byDeviceRecordId.get(dev.deviceRecordId);
    if (byRecord === dev) {
      this.byDeviceRecordId.delete(dev.deviceRecordId);
    }
    const byKey = this.byKey.get(compositeKey(dev.tenantId, dev.deviceKey));
    if (byKey === dev) {
      this.byKey.delete(compositeKey(dev.tenantId, dev.deviceKey));
    }
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
        this.removeEntry(dev);
        void ws;
      }
    }
    return stale;
  }
}
