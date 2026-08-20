import type { ConnectionState } from "../../lib/desktop/connection-state";
import type { AiLockManager } from "../browser/ai-lock";
import { BridgeClient } from "./bridge-client";
/**
 * Desktop Bridge 生命周期控制器。
 *
 * 职责：
 * - 持有设备身份（identity）与 BridgeClient 动态创建/替换/状态订阅。
 * - 设备未注册（identity.tenantId === null）时不创建 BridgeClient，保持显式 disconnected，
 *   不伪造默认租户；注册成功（applyTenantId）后立即创建并连接，无需重启。
 * - 为 IPC 层提供统一入口：getState / connect / disconnect / onStateChange / cancelAndTakeOver，
 *   使 IPC handler 不再捕获一次性 optional BridgeClient，而是动态读取当前 client。
 * - 退出登录（clearTenant）后清空租户并销毁 client，下次注册重新走完整流程。
 *
 * 安全约束：
 * - tenantId 只由 Server 注册响应回填（applyTenantId 校验非空合法 UUID），本地不默认。
 * - 认证签名必须绑定 tenantId；未注册时任何 connect 调用都返回 false，不建立连接。
 */
import type { BrowserActionTarget, BrowserCommandTarget } from "./command-executor";
import type { DeviceIdentity } from "./device-identity";

/** 合法租户 UUID（v4）校验。tenantId 必须为显式非空合法 UUID。 */
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 判断租户 ID 是否为合法非空 UUID。 */
export function isValidTenantId(tenantId: string): boolean {
  return tenantId.length > 0 && TENANT_ID_PATTERN.test(tenantId);
}

/** DesktopBridgeLifecycle 依赖（由主进程在启动时装配）。 */
export interface DesktopBridgeLifecycleDeps {
  /** Server WebSocket 地址（ws://host:port）。 */
  serverUrl: string;
  /** 设备展示名称。 */
  deviceName: string;
  /** Desktop 应用版本。 */
  deviceVersion: string;
  /** 读取类命令执行目标（BrowserController 适配器）。 */
  commandTarget: BrowserCommandTarget;
  /** 操作类命令执行目标（BrowserController 适配器）。 */
  actionTarget: BrowserActionTarget;
  /** 本地 AI 输入锁（可选）。 */
  aiLockManager?: AiLockManager;
}

/**
 * Desktop Bridge 生命周期控制器。
 *
 * 动态持有 0..1 个 BridgeClient：未注册时 client 为 null（disconnected）；
 * applyTenantId 成功后创建并替换 client。状态变化通过 onStateChange 转发给订阅者。
 */
export class DesktopBridgeLifecycle {
  private client: BridgeClient | null = null;
  private clientUnsubscribe: (() => void) | null = null;
  private listeners = new Set<(state: ConnectionState) => void>();

  constructor(
    private readonly identity: DeviceIdentity,
    private readonly deps: DesktopBridgeLifecycleDeps,
  ) {}

  /** 当前设备身份（IPC 层读取 deviceId / publicKey 构造注册请求体）。 */
  getIdentity(): DeviceIdentity {
    return this.identity;
  }

  /** 是否已注册（tenantId 非空）。 */
  isRegistered(): boolean {
    return this.identity.tenantId !== null;
  }

  /** 获取当前连接状态；未注册 / 未创建 client 时恒为 disconnected。 */
  getState(): ConnectionState {
    return this.client?.getState() ?? "disconnected";
  }

  /** 订阅连接状态变化。返回取消订阅函数。 */
  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 已注册则创建（如需）并连接 Bridge。未注册返回 false。 */
  connect(): boolean {
    if (!this.isRegistered()) return false;
    this.createClientIfNeeded();
    this.client?.connect();
    return true;
  }

  /** 幂等连接：已注册则保证 Bridge 存在并连接，未注册返回 false。 */
  ensureConnected(): boolean {
    return this.connect();
  }

  /** 断开 Bridge（无 client 时仍返回 true）。 */
  disconnect(): boolean {
    this.client?.disconnect();
    return true;
  }

  /** 请求 Server 停止当前 AI 命令（转发给当前 client）。 */
  cancelAndTakeOver(threadId: string): boolean {
    return this.client?.cancelAndTakeOver(threadId) ?? false;
  }

  /**
   * 注册成功：回填 tenantId 并重建 client。
   *
   * 调用方应先持久化到 Keychain 再调用（或调用后立即持久化）。
   * 校验失败（非法 tenantId）返回 false，不改变任何状态。
   */
  applyTenantId(tenantId: string): boolean {
    if (!isValidTenantId(tenantId)) return false;
    this.identity.tenantId = tenantId;
    this.replaceClient();
    return true;
  }

  /** 退出登录：清空 tenantId 并销毁当前 client。 */
  clearTenant(): void {
    this.identity.tenantId = null;
    this.replaceClient();
  }

  // ──────────────────────────────────────────────
  // 内部
  // ──────────────────────────────────────────────

  /** 未创建 client 时创建一个（基于当前 identity.tenantId）。 */
  private createClientIfNeeded(): void {
    if (this.client !== null) return;
    this.replaceClient();
  }

  /** 销毁旧 client 并按当前 identity 创建新 client。 */
  private replaceClient(): void {
    this.clientUnsubscribe?.();
    this.clientUnsubscribe = null;
    this.client?.disconnect();
    this.client = null;
    if (this.identity.tenantId === null) {
      // 未注册：无 client，状态保持 disconnected
      this.emit(this.getState());
      return;
    }
    this.client = new BridgeClient({
      serverUrl: this.deps.serverUrl,
      deviceIdentity: this.identity,
      tenantId: this.identity.tenantId,
      deviceName: this.deps.deviceName,
      deviceVersion: this.deps.deviceVersion,
      commandTarget: this.deps.commandTarget,
      actionTarget: this.deps.actionTarget,
      aiLockManager: this.deps.aiLockManager,
    });
    this.clientUnsubscribe = this.client.onStateChange((state) => {
      this.emit(state);
    });
  }

  private emit(state: ConnectionState): void {
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
