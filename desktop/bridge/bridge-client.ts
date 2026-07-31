/**
 * V10 Phase 5：Agent Bridge WebSocket 客户端。
 *
 * Desktop 端通过 WebSocket 连接到 Server，完成设备认证后接收 RPC 请求并执行。
 * 连接经过严格的状态机管理，仅 authenticated 状态可收发 RPC。
 *
 * 核心流程：
 * 1. connect() → 建立 WebSocket（connecting → connected）
 * 2. 收到 challenge → 用设备私钥签名 challenge，发送 auth 消息
 * 3. 收到 auth_ok → authenticated，启动心跳
 * 4. 收到 rpc → 校验信封 + nonce 去重 → 执行命令 → 签名结果信封 → 发送
 * 5. 收到 heartbeat → 回复 heartbeat_ack，重置心跳看门狗
 * 6. 连接断开 → 指数退避重连（reconnecting → connected）
 *
 * 安全约束：
 * - RPC 请求必须通过 validateRpcEnvelope 完整校验（签名、版本、deviceId、过期等）
 * - nonce 去重防止重放攻击
 * - 结果信封用设备私钥签名，Server 可验签
 * - 收到 auth_failed 后进入 revoked 状态，不自动重连
 */
import { WebSocket } from "ws";
import { decideApproval } from "../../lib/desktop/approval";
import {
  type ClientMessage,
  type RpcRequestMessage,
  parseServerMessage,
  serializeMessage,
} from "../../lib/desktop/bridge-messages";
import { isActionCommand } from "../../lib/desktop/commands";
import { type ConnectionState, ConnectionStateMachine } from "../../lib/desktop/connection-state";
import { PROTOCOL_VERSION } from "../../lib/desktop/protocol";
import {
  type RpcRequestEnvelope,
  type RpcResultEnvelope,
  getResultSignPayload,
} from "../../lib/desktop/rpc-envelope";
import { NonceDeduplicator, validateRpcEnvelope } from "../../lib/desktop/rpc-security";
import { signData } from "../../lib/desktop/signing";
import type { AiLockManager } from "../browser/ai-lock";
import { executeActionCommand, executeReadCommand } from "./command-executor";
import type { BrowserActionTarget, BrowserCommandTarget } from "./command-executor";
import type { DeviceIdentity } from "./device-identity";

/**
 * Bridge 客户端配置。
 */
export interface BridgeClientConfig {
  /** Server WebSocket 地址（ws://host:port） */
  serverUrl: string;
  /** 设备身份（含 deviceId 和 ed25519 密钥对） */
  deviceIdentity: DeviceIdentity;
  /** 设备名称（展示用） */
  deviceName: string;
  /** Desktop 应用版本 */
  deviceVersion: string;
  /** 读取类命令执行目标（BrowserController 适配器） */
  commandTarget: BrowserCommandTarget;
  /** 操作类命令执行目标（BrowserController 适配器） */
  actionTarget: BrowserActionTarget;
  /** 心跳间隔（毫秒），默认 30000 */
  heartbeatIntervalMs?: number;
  /** 重连基础延迟（毫秒），默认 1000 */
  reconnectBaseDelayMs?: number;
  /** 重连最大延迟（毫秒），默认 30000 */
  reconnectMaxDelayMs?: number;
  /** 最大重连次数，0 = 无限重连 */
  reconnectMaxAttempts?: number;
  /** Server lease 的本地强制状态。 */
  aiLockManager?: AiLockManager;
}

/** RPC 结果信封中的错误结构 */
interface RpcResultError {
  code: string;
  message: string;
  detail: unknown;
}

/**
 * Bridge WebSocket 客户端。
 *
 * 管理 WebSocket 连接生命周期、认证握手、RPC 收发、心跳和重连。
 */
export class BridgeClient {
  private ws: WebSocket | null = null;
  private stateMachine = new ConnectionStateMachine();
  private nonceDedup = new NonceDeduplicator();
  private serverPublicKeyBase64: string | null = null;
  private config: BridgeClientConfig;
  private reconnectAttempts = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** 最近一次心跳时间（用于看门狗检测） */
  private lastHeartbeatAt = 0;
  /** 是否为主动断开（避免断开后自动重连） */
  private manualDisconnect = false;

  constructor(config: BridgeClientConfig) {
    this.config = config;
  }

  /**
   * 连接到 Server。
   *
   * 状态：disconnected → connecting；reconnecting 时直接建立 WebSocket。
   */
  connect(): void {
    const state = this.stateMachine.getState();
    if (state === "disconnected") {
      this.stateMachine.transition({ type: "connect" });
    } else if (state !== "reconnecting") {
      // 已在连接 / 已认证，忽略重复 connect
      return;
    }
    this.manualDisconnect = false;
    this.openWebSocket();
  }

  /**
   * 断开连接。
   *
   * 主动断开不会触发自动重连。
   */
  disconnect(): void {
    this.manualDisconnect = true;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.cleanupConnection();
    const state = this.stateMachine.getState();
    if (state !== "disconnected") {
      try {
        this.stateMachine.transition({ type: "disconnect" });
      } catch {
        // 状态转换失败时忽略（可能已在 disconnected）
      }
    }
  }

  /**
   * 获取当前连接状态。
   */
  getState(): ConnectionState {
    return this.stateMachine.getState();
  }

  /**
   * 是否已认证（可以执行 RPC）。
   */
  isReady(): boolean {
    return this.stateMachine.canSendRpc();
  }

  /**
   * 订阅状态变化。
   *
   * @param listener 回调函数，接收新状态
   * @returns 取消订阅函数
   */
  onStateChange(listener: (state: ConnectionState) => void): () => void {
    return this.stateMachine.subscribe((state) => {
      listener(state);
    });
  }

  // ──────────────────────────────────────────────
  // 内部：WebSocket 连接
  // ──────────────────────────────────────────────

  /**
   * 创建 WebSocket 并注册事件处理器。
   */
  private openWebSocket(): void {
    this.ws = new WebSocket(this.config.serverUrl);

    this.ws.on("open", () => {
      this.handleWsOpen();
    });

    this.ws.on("message", (raw: Buffer | string) => {
      try {
        const data: unknown =
          typeof raw === "string" ? JSON.parse(raw) : JSON.parse(raw.toString("utf8"));
        this.handleMessage(data);
      } catch (e) {
        console.error("[snowharness:bridge] 消息解析失败:", e);
      }
    });

    this.ws.on("close", () => {
      this.handleClose();
    });

    this.ws.on("error", (error: Error) => {
      this.handleError(error);
    });
  }

  /**
   * WebSocket 连接建立。
   *
   * 根据当前状态转换：connecting → connected；reconnecting → connected（reconnect_success）。
   */
  private handleWsOpen(): void {
    const state = this.stateMachine.getState();
    if (state === "connecting") {
      this.stateMachine.transition({ type: "connected" });
    } else if (state === "reconnecting") {
      this.stateMachine.transition({ type: "reconnect_success" });
    }
  }

  /**
   * 清理 WebSocket 连接（不触发状态转换）。
   */
  private cleanupConnection(): void {
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        if (this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
          this.ws.close();
        }
      } catch {
        // 关闭失败时忽略
      }
      this.ws = null;
    }
    this.serverPublicKeyBase64 = null;
  }

  // ──────────────────────────────────────────────
  // 内部：消息处理
  // ──────────────────────────────────────────────

  /**
   * 处理 Server → Desktop 消息。
   */
  private handleMessage(data: unknown): void {
    const parsed = parseServerMessage(data);
    if (!parsed.ok) {
      // 检查是否为协议版本不匹配（challenge 消息的 protocolVersion 与本地不一致）
      if (this.isChallengeProtocolMismatch(data)) {
        this.handleProtocolMismatch();
      }
      return;
    }
    const msg = parsed.message;
    switch (msg.type) {
      case "challenge":
        this.handleChallenge(msg.challenge, msg.serverPublicKey);
        break;
      case "auth_ok":
        this.handleAuthOk();
        break;
      case "auth_failed": {
        this.handleAuthFailed(msg.error.code, msg.error.message);
        break;
      }
      case "rpc":
        this.handleRpc((msg as RpcRequestMessage).envelope as RpcRequestEnvelope);
        break;
      case "heartbeat":
        this.handleHeartbeat(msg.timestamp);
        break;
      case "lease_revoked":
        this.handleLeaseRevoked(msg.threadId, msg.reason);
        break;
      case "lease_locked":
        this.handleLeaseLocked(msg);
        break;
      case "lease_released":
        this.config.aiLockManager?.release(
          msg.threadId,
          this.config.deviceIdentity.deviceId,
          msg.runId,
          Date.now(),
        );
        break;
      case "command_cancelled":
        this.config.aiLockManager?.release(
          msg.threadId,
          this.config.deviceIdentity.deviceId,
          msg.runId,
          Date.now(),
        );
        break;
      case "error":
        console.error(`[snowharness:bridge] Server 错误: ${msg.error.code} - ${msg.error.message}`);
        break;
    }
  }

  /**
   * 判断原始消息是否为协议版本不匹配的 challenge。
   */
  private isChallengeProtocolMismatch(data: unknown): boolean {
    if (typeof data !== "object" || data === null) {
      return false;
    }
    const obj = data as Record<string, unknown>;
    if (obj.type !== "challenge") {
      return false;
    }
    if (typeof obj.protocolVersion !== "number") {
      return false;
    }
    return obj.protocolVersion !== PROTOCOL_VERSION;
  }

  /**
   * 处理协议版本不匹配：转换到 protocol_mismatch 状态并断开。
   */
  private handleProtocolMismatch(): void {
    try {
      const state = this.stateMachine.getState();
      if (state === "connected" || state === "connecting") {
        this.stateMachine.transition({ type: "protocol_mismatch" });
      }
    } catch {
      // 状态转换失败时忽略
    }
    this.manualDisconnect = true;
    this.stopHeartbeat();
    this.cleanupConnection();
  }

  /**
   * 处理 challenge：用设备私钥签名 challenge，发送 auth 消息。
   */
  private handleChallenge(challenge: string, serverPublicKey: string): void {
    this.serverPublicKeyBase64 = serverPublicKey;
    const signature = signData(challenge, this.config.deviceIdentity.keyPair.privateKeyBase64);
    const authMessage: ClientMessage = {
      type: "auth",
      deviceId: this.config.deviceIdentity.deviceId,
      signature,
      version: this.config.deviceVersion,
      name: this.config.deviceName,
      protocolVersion: PROTOCOL_VERSION,
    };
    this.send(authMessage);
  }

  /**
   * 处理 auth_ok：状态转换为 authenticated，启动心跳，重置重连计数。
   */
  private handleAuthOk(): void {
    const state = this.stateMachine.getState();
    if (state === "connected") {
      this.stateMachine.transition({ type: "authenticated" });
    }
    this.reconnectAttempts = 0;
    this.startHeartbeat();
  }

  /**
   * 处理 auth_failed：进入 revoked 状态，不自动重连。
   */
  private handleAuthFailed(code: string, message: string): void {
    console.error(`[snowharness:bridge] 认证失败: ${code} - ${message}`);
    const state = this.stateMachine.getState();
    if (state === "connected") {
      this.stateMachine.transition({ type: "revoke" });
    }
    this.manualDisconnect = true;
    this.stopHeartbeat();
    this.cleanupConnection();
  }

  /**
   * 处理 RPC 请求：校验信封 → nonce 去重 → 执行命令 → 签名结果 → 发送。
   */
  private async handleRpc(envelope: RpcRequestEnvelope): Promise<void> {
    // 防御性提取 requestId（校验失败时仍可用于错误响应）
    const rawRequestId = (envelope as { requestId?: unknown })?.requestId;
    const requestId = typeof rawRequestId === "string" ? rawRequestId : "";

    // 1. 完整校验信封（schema / 版本 / deviceId / 过期 / 签名 / 命令 / payload）
    const lock = envelope.runId
      ? (this.config.aiLockManager?.getLock(envelope.threadId) ?? null)
      : null;
    if (
      envelope.runId &&
      (!lock || lock.runId !== envelope.runId || lock.deviceId !== envelope.deviceId)
    ) {
      this.sendRpcResult(requestId, false, null, {
        code: "lease_required",
        message: "缺少匹配的本地 AI lease",
        detail: null,
      });
      return;
    }
    const validation = validateRpcEnvelope(
      envelope,
      this.config.deviceIdentity.deviceId,
      lock?.userId ?? null,
      this.serverPublicKeyBase64 ?? "",
      Date.now(),
    );
    if (!validation.ok) {
      this.sendRpcResult(requestId, false, null, {
        code: validation.code,
        message: validation.message,
        detail: null,
      });
      return;
    }

    const approvalDecision = decideApproval(
      validation.envelope.command,
      validation.envelope.payload,
    );
    if (approvalDecision === "deny") {
      this.sendRpcResult(requestId, false, null, {
        code: "credential_denied",
        message: "Desktop 拒绝 AI 操作凭证字段",
        detail: null,
      });
      return;
    }
    if (approvalDecision === "require_approval" && !validation.envelope.approvalId) {
      this.sendRpcResult(requestId, false, null, {
        code: "approval_required",
        message: "Desktop 要求有效审批",
        detail: null,
      });
      return;
    }

    // 2. nonce 去重，防止重放
    if (!this.nonceDedup.checkAndAdd(validation.envelope.nonce, validation.envelope.expiresAt)) {
      this.sendRpcResult(validation.envelope.requestId, false, null, {
        code: "rpc_replay",
        message: "nonce 重放：请求已处理过",
        detail: null,
      });
      return;
    }

    // 3. 根据命令类型分发：操作类 → executeActionCommand，读取类 → executeReadCommand
    const result = isActionCommand(validation.envelope.command)
      ? await executeActionCommand({
          target: this.config.actionTarget,
          command: validation.envelope.command,
          payload: validation.envelope.payload,
          threadId: validation.envelope.threadId,
        })
      : await executeReadCommand({
          target: this.config.commandTarget,
          command: validation.envelope.command,
          payload: validation.envelope.payload,
          threadId: validation.envelope.threadId,
        });

    // 4. 签名并发送结果
    if (result.ok) {
      this.sendRpcResult(validation.envelope.requestId, true, result.result ?? null, null);
    } else {
      this.sendRpcResult(validation.envelope.requestId, false, null, {
        code: result.code ?? "unknown",
        message: result.message ?? "",
        detail: null,
      });
    }
  }

  /**
   * 处理心跳：回复 heartbeat_ack，重置看门狗。
   */
  private handleHeartbeat(timestamp: number): void {
    this.lastHeartbeatAt = Date.now();
    const ackMessage: ClientMessage = {
      type: "heartbeat_ack",
      timestamp,
    };
    this.send(ackMessage);
  }

  /**
   * 处理 lease 撤销：记录日志（Phase 5 不主动操作）。
   */
  private handleLeaseRevoked(threadId: string, reason: string): void {
    this.config.aiLockManager?.revoke(threadId);
    console.warn(`[snowharness:bridge] Lease 撤销: threadId=${threadId} reason=${reason}`);
  }

  private handleLeaseLocked(message: {
    threadId: string;
    deviceId: string;
    userId: string;
    runId: string;
    expiresAt: number;
  }): void {
    const now = Date.now();
    if (message.deviceId !== this.config.deviceIdentity.deviceId || message.expiresAt <= now)
      return;
    this.config.aiLockManager?.acquire({
      threadId: message.threadId,
      userId: message.userId,
      deviceId: message.deviceId,
      runId: message.runId,
      now,
      ttlMs: message.expiresAt - now,
    });
    const timer = setTimeout(
      () => {
        this.config.aiLockManager?.cleanupExpired(Date.now());
      },
      message.expiresAt - now + 1,
    );
    timer.unref();
  }

  /** 请求 Server 停止当前 AI 命令；收到确认前保持本地输入锁。 */
  cancelAndTakeOver(threadId: string): boolean {
    const lock = this.config.aiLockManager?.getLock(threadId);
    if (!lock || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.send({
      type: "cancel_command",
      threadId,
      runId: lock.runId,
      reason: "user_takeover",
    });
    return true;
  }

  // ──────────────────────────────────────────────
  // 内部：结果信封签名与发送
  // ──────────────────────────────────────────────

  /**
   * 构造并签名 RPC 结果信封，发送给 Server。
   *
   * 签名覆盖排除 signature 字段的结果信封规范序列化。
   */
  private sendRpcResult(
    requestId: string,
    ok: boolean,
    result: unknown,
    error: RpcResultError | null,
  ): void {
    const envelopeWithoutSig: Omit<RpcResultEnvelope, "signature"> = {
      requestId,
      deviceId: this.config.deviceIdentity.deviceId,
      ok,
      result: result ?? null,
      error,
      timestamp: Date.now(),
    };
    const signPayload = getResultSignPayload(envelopeWithoutSig);
    const signature = signData(signPayload, this.config.deviceIdentity.keyPair.privateKeyBase64);
    const signedEnvelope: RpcResultEnvelope = {
      ...envelopeWithoutSig,
      signature,
    };
    const message: ClientMessage = {
      type: "rpc_result",
      envelope: signedEnvelope,
    };
    this.send(message);
  }

  /**
   * 发送消息到 Server。
   *
   * WebSocket 未连接时静默丢弃（调用方应确保在 authenticated 状态发送）。
   */
  private send(message: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(serializeMessage(message));
  }

  // ──────────────────────────────────────────────
  // 内部：心跳
  // ──────────────────────────────────────────────

  /**
   * 启动心跳看门狗。
   *
   * 定期检查是否收到心跳，超过 2 倍间隔未收到则主动断开触发重连。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.config.heartbeatIntervalMs ?? 30000;
    this.lastHeartbeatAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastHeartbeatAt;
      if (elapsed > interval * 2) {
        console.warn("[snowharness:bridge] 心跳超时，主动断开触发重连");
        this.cleanupConnection();
        this.handleClose();
      }
    }, interval);
  }

  /**
   * 停止心跳看门狗。
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ──────────────────────────────────────────────
  // 内部：重连
  // ──────────────────────────────────────────────

  /**
   * 尝试重连（指数退避）。
   *
   * 延迟 = baseDelay * 2^attempts，上限为 maxDelay。
   * 达到最大次数后停止重连（maxAttempts=0 表示无限重连）。
   */
  private scheduleReconnect(): void {
    if (this.manualDisconnect) {
      return;
    }
    const maxAttempts = this.config.reconnectMaxAttempts ?? 0;
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      console.error(`[snowharness:bridge] 达到最大重连次数 ${maxAttempts}，停止重连`);
      return;
    }

    const baseDelay = this.config.reconnectBaseDelayMs ?? 1000;
    const maxDelay = this.config.reconnectMaxDelayMs ?? 30000;
    const delay = Math.min(baseDelay * 2 ** this.reconnectAttempts, maxDelay);
    this.reconnectAttempts++;

    // 转换到 reconnecting 状态（从 disconnected）
    try {
      if (this.stateMachine.getState() === "disconnected") {
        this.stateMachine.transition({ type: "reconnect" });
      }
    } catch {
      // 状态转换失败时忽略
    }

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * 处理 WebSocket 断开。
   */
  private handleClose(): void {
    this.stopHeartbeat();
    this.serverPublicKeyBase64 = null;

    // 转换到 disconnected（从 authenticated / connected / connecting）
    const state = this.stateMachine.getState();
    if (state !== "disconnected" && state !== "reconnecting") {
      try {
        this.stateMachine.transition({ type: "disconnect" });
      } catch {
        // 状态转换失败时忽略
      }
    }

    if (this.manualDisconnect) {
      return;
    }

    this.scheduleReconnect();
  }

  /**
   * 处理 WebSocket 错误。
   */
  private handleError(error: Error): void {
    console.error("[snowharness:bridge] WebSocket 错误:", error.message);
  }

  /**
   * 清理重连定时器。
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
