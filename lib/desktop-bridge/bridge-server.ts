import { getDeviceByDeviceId, touchDevice } from "@/lib/db/desktop-device-queries";
/**
 * V10 Phase 5：Agent Bridge WebSocket 服务器。
 *
 * 整合认证、设备注册表、lease 服务、RPC 分发等模块，提供完整的 WebSocket
 * 服务器实现。Server 启动时调用 start()，Desktop 通过 WebSocket 连接并完成
 * 认证后即可收发 RPC 信封。
 *
 * 消息流：
 * 1. Desktop 连接 → Server 发送 challenge
 * 2. Desktop 签名 challenge → Server 验证签名
 * 3. 认证成功 → 双方进入 RPC 通信模式
 * 4. Server 发送 RPC 信封 → Desktop 执行 → Desktop 返回 RPC 结果
 * 5. 定期 heartbeat 保持连接
 *
 * 安全约束：
 * - 每个连接必须先完成 challenge-response 认证
 * - RPC 信封必须签名且未过期
 * - lease 持有设备才能接收 thread 的 RPC
 * - 心跳超时的设备会被清理
 */
import { WebSocket, WebSocketServer } from "ws";
import {
  type AuthMessage,
  type CancelCommandMessage,
  type ClientMessage,
  type ServerMessage,
  parseClientMessage,
  serializeMessage,
} from "../desktop/bridge-messages";
import { PROTOCOL_VERSION } from "../desktop/protocol";
import { CancelService } from "./cancel-service";
import { generateChallenge, generateServerKeyPair, verifyAuthResponse } from "./challenge-auth";
import { DeviceRegistry } from "./device-registry";
import { LeaseService } from "./lease-service";
import { type DispatchParams, prepareDispatch } from "./rpc-dispatcher";
import { routeRpc } from "./rpc-router";

/**
 * V10 Phase 6：BridgeServer 单例。
 *
 * instrumentation.ts 启动时 setBridgeServer(server)，工具层 getBridgeServer() 获取实例。
 * 开发/测试环境不启动 BridgeServer → getBridgeServer() 返回 null → 浏览器工具返回 desktop_unavailable。
 */
let serverInstance: BridgeServer | null = null;

/**
 * 设置 BridgeServer 单例（instrumentation.ts 启动时调用）。
 */
export function setBridgeServer(server: BridgeServer | null): void {
  serverInstance = server;
}

/**
 * 获取 BridgeServer 单例（工具层调用）。
 *
 * 返回 null 表示 Bridge 未启动（开发/测试环境），浏览器工具应返回 desktop_unavailable。
 */
export function getBridgeServer(): BridgeServer | null {
  return serverInstance;
}

/**
 * Bridge 服务器配置。
 */
export interface BridgeServerConfig {
  /** WebSocket 监听端口 */
  port: number;
  /** 心跳间隔（毫秒），默认 30000 */
  heartbeatIntervalMs?: number;
  /** 心跳超时阈值（毫秒），默认 90000 */
  heartbeatTimeoutMs?: number;
}

/**
 * 待响应 RPC 请求的 resolver。
 */
interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** 关联的 threadId，用于 cancel 时查找 */
  threadId: string;
  /** 关联的 runId，用于 cancel 时查找（可能为 null） */
  runId: string | null;
}

/**
 * 默认 RPC 超时：30 秒。
 */
const DEFAULT_RPC_TIMEOUT_MS = 30000;

/**
 * Agent Bridge WebSocket 服务器。
 */
export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private registry = new DeviceRegistry();
  private leaseService = new LeaseService(this.registry);
  private cancelService = new CancelService(this.leaseService);
  private serverKeyPair = generateServerKeyPair();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private config: BridgeServerConfig;
  // 连接级挑战：ws → challenge（用于在认证时验证签名）
  private pendingChallenges = new Map<WebSocket, string>();
  // 待响应 RPC：requestId → resolver
  private pendingRpcs = new Map<string, PendingRpc>();
  private running = false;

  constructor(config: BridgeServerConfig) {
    this.config = {
      heartbeatIntervalMs: 30000,
      heartbeatTimeoutMs: 90000,
      ...config,
    };
  }

  /**
   * 启动 WebSocket 服务器。
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.config.port });
      this.wss = wss;
      wss.on("connection", (ws) => this.handleConnection(ws));
      wss.on("error", (err) => {
        if (!this.running) {
          reject(err);
        }
      });
      wss.on("listening", () => {
        this.running = true;
        // 启动心跳定时器
        this.heartbeatTimer = setInterval(
          () => this.checkHeartbeats(),
          this.config.heartbeatIntervalMs,
        );
        this.heartbeatTimer.unref();
        resolve();
      });
    });
  }

  /**
   * 停止服务器。
   */
  async stop(): Promise<void> {
    if (!this.running || !this.wss) {
      return;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // 拒绝所有待响应 RPC
    for (const [requestId, pending] of this.pendingRpcs) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge server stopped"));
      this.pendingRpcs.delete(requestId);
    }
    // 关闭所有客户端连接
    for (const client of this.wss.clients) {
      client.close();
    }
    return new Promise((resolve) => {
      this.wss?.close(() => {
        this.wss = null;
        this.running = false;
        resolve();
      });
    });
  }

  /**
   * 向指定设备发送 RPC 请求。
   *
   * 流程：
   * 1. 查找设备（必须在线且已认证）
   * 2. 准备签名信封
   * 3. 发送给目标设备
   * 4. 等待对应 requestId 的响应
   *
   * @param deviceId 目标设备 ID
   * @param command 命令字符串
   * @param payload 命令 payload
   * @param params.userId 用户 ID
   * @param params.threadId thread ID
   * @param params.tabId 可选 tab ID
   * @param params.runId 可选 run ID
   * @param params.approvalId 可选 approval ID（操作类命令需审批后传入）
   * @returns RPC 结果
   */
  async sendRpc(
    deviceId: string,
    command: string,
    payload: unknown,
    params: {
      userId: string;
      threadId: string;
      tabId?: string | null;
      runId?: string | null;
      approvalId?: string | null;
    },
  ): Promise<{ ok: boolean; result?: unknown; code?: string; message?: string }> {
    if (!this.running) {
      return { ok: false, code: "desktop_unavailable", message: "Bridge 未运行" };
    }
    const dev = this.registry.getByDeviceId(deviceId);
    if (!dev) {
      return { ok: false, code: "desktop_unavailable", message: "设备离线" };
    }
    if (!dev.authenticated) {
      return { ok: false, code: "desktop_unauthorized", message: "设备未认证" };
    }
    const now = Date.now();
    const dispatchParams: DispatchParams = {
      deviceId,
      userId: params.userId,
      threadId: params.threadId,
      command,
      payload,
      serverPrivateKeyBase64: this.serverKeyPair.privateKeyBase64,
      tabId: params.tabId ?? null,
      runId: params.runId ?? null,
      approvalId: params.approvalId ?? null,
    };
    const dispatch = prepareDispatch(dispatchParams, now);
    if (!dispatch.ok) {
      return { ok: false, code: dispatch.code, message: dispatch.message };
    }
    const envelope = dispatch.envelope;
    const ws = dev.ws as WebSocket;
    if (ws.readyState !== WebSocket.OPEN) {
      return { ok: false, code: "desktop_disconnected", message: "WebSocket 已断开" };
    }
    // 注册 pending RPC，等待响应
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(envelope.requestId);
        resolve({
          ok: false,
          code: "rpc_timeout",
          message: `RPC 请求超时（requestId=${envelope.requestId}）`,
        });
      }, DEFAULT_RPC_TIMEOUT_MS);
      this.pendingRpcs.set(envelope.requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          this.pendingRpcs.delete(envelope.requestId);
          resolve({ ok: true, result });
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pendingRpcs.delete(envelope.requestId);
          resolve({ ok: false, code: "browser_internal", message: err.message });
        },
        timer,
        threadId: params.threadId,
        runId: params.runId ?? null,
      });
      // 发送 RPC 请求消息
      const message: ServerMessage = { type: "rpc", envelope };
      ws.send(serializeMessage(message));
    });
  }

  /**
   * 向 threadId 的 lease 持有设备发送 RPC 请求。
   *
   * Phase 6：浏览器工具层调用此方法，无需手动查找 lease holder。
   * 内部复用 routeRpc 路由逻辑：lease 存在 + 有效 + userId 匹配 + 设备在线已认证。
   *
   * Phase 6-5 双重强制：
   * - 发送 RPC 前先发 lease_locked 通知 Desktop acquire 本地 AI 锁（显示 overlay）
   * - RPC 完成或失败后发 lease_release 通知 Desktop release 本地锁（移除 overlay）
   * - 如果 runId 已被 cancel，立即返回 interrupted，不发送 RPC
   *
   * @param params.threadId thread ID
   * @param params.userId 用户 ID
   * @param params.command 命令字符串
   * @param params.payload 命令 payload
   * @param params.runId 可选 run ID
   * @param params.approvalId 可选 approval ID
   * @returns RPC 结果（路由失败返回相应 code）
   */
  async sendRpcToThread(params: {
    threadId: string;
    userId: string;
    command: string;
    payload: unknown;
    runId?: string | null;
    approvalId?: string | null;
  }): Promise<{ ok: boolean; result?: unknown; code?: string; message?: string }> {
    if (!this.running) {
      return { ok: false, code: "desktop_unavailable", message: "Bridge 未运行" };
    }
    const now = Date.now();
    // 检查 runId 是否已被 cancel（防迟到 RPC 进入 Agent 上下文）
    if (params.runId && this.cancelService.isCancelled(params.threadId, params.runId, now)) {
      return { ok: false, code: "interrupted", message: "命令已被取消" };
    }
    const route = routeRpc({
      registry: this.registry,
      leaseService: this.leaseService,
      userId: params.userId,
      threadId: params.threadId,
      now,
    });
    if (!route.ok) {
      return { ok: false, code: route.code, message: route.message };
    }
    // Phase 6-5：发送 lease_locked 通知 Desktop acquire 本地锁（双重强制）
    if (params.runId) {
      this.sendLeaseLocked({
        deviceId: route.deviceId,
        threadId: params.threadId,
        userId: params.userId,
        runId: params.runId,
        now,
      });
    }
    const result = await this.sendRpc(route.deviceId, params.command, params.payload, {
      userId: params.userId,
      threadId: params.threadId,
      runId: params.runId ?? null,
      approvalId: params.approvalId ?? null,
    });
    // Phase 6-5：RPC 完成后释放 Desktop 本地锁
    if (params.runId) {
      this.sendLeaseReleased({
        deviceId: route.deviceId,
        threadId: params.threadId,
        runId: params.runId,
      });
    }
    return result;
  }

  /**
   * 向 Desktop 发送 lease_locked 消息（通知 acquire 本地 AI 锁）。
   */
  private sendLeaseLocked(params: {
    deviceId: string;
    threadId: string;
    userId: string;
    runId: string;
    now: number;
  }): void {
    const dev = this.registry.getByDeviceId(params.deviceId);
    if (!dev || !dev.authenticated) return;
    const ws = dev.ws as WebSocket;
    if (ws.readyState !== WebSocket.OPEN) return;
    const message: ServerMessage = {
      type: "lease_locked",
      threadId: params.threadId,
      deviceId: params.deviceId,
      userId: params.userId,
      runId: params.runId,
      expiresAt: params.now + DEFAULT_RPC_TIMEOUT_MS,
    };
    try {
      ws.send(serializeMessage(message));
    } catch {
      // 忽略发送错误，RPC 主流程会处理设备离线
    }
  }

  /**
   * 向 Desktop 发送 lease_released 消息（释放本地 AI 锁）。
   *
   * Server 在 RPC 完成（成功/失败/超时）后调用此方法，通知 Desktop 释放
   * 对应 runId 的本地 AI 锁，移除 WebContents overlay 恢复用户输入。
   *
   * 与 sendLeaseLocked 配对使用。如果发送失败（设备离线等），Desktop 的
   * 本地锁会通过 TTL 自然过期（默认 5 分钟），不会永久阻塞。
   */
  private sendLeaseReleased(params: {
    deviceId: string;
    threadId: string;
    runId: string;
  }): void {
    const dev = this.registry.getByDeviceId(params.deviceId);
    if (!dev || !dev.authenticated) return;
    const ws = dev.ws as WebSocket;
    if (ws.readyState !== WebSocket.OPEN) return;
    const message: ServerMessage = {
      type: "lease_released",
      threadId: params.threadId,
      runId: params.runId,
    };
    try {
      ws.send(serializeMessage(message));
    } catch {
      // 忽略发送错误，Desktop 本地锁会通过 TTL 过期
    }
  }

  /**
   * 处理 Desktop 发来的 cancel_command 消息（用户"停止并接管"）。
   *
   * 流程：
   * 1. CancelService.requestCancel 释放 lease + 标记 runId cancelled
   * 2. 向 Desktop 发送 command_cancelled 通知
   * 3. 取消 pending RPC（如果在等待）
   */
  private async handleCancelCommand(params: {
    ws: WebSocket;
    threadId: string;
    runId: string;
    reason: string;
  }): Promise<void> {
    const dev = this.registry.getByWs(params.ws);
    if (!dev || !dev.authenticated) return;
    const now = Date.now();
    const result = await this.cancelService.requestCancel({
      threadId: params.threadId,
      runId: params.runId,
      reason: params.reason,
      deviceId: dev.deviceId,
      now,
    });
    if (result.cancelled) {
      // 通知 Desktop 命令已取消（Desktop 应释放本地 AI 锁）
      const message: ServerMessage = {
        type: "command_cancelled",
        threadId: params.threadId,
        runId: params.runId,
        reason: params.reason,
      };
      try {
        params.ws.send(serializeMessage(message));
      } catch {
        // 忽略发送错误
      }
      // 拒绝该 runId 的 pending RPC（如果存在）
      this.rejectPendingRpcByRunId(params.threadId, params.runId, "interrupted", "命令已被取消");
    }
  }

  /**
   * 拒绝指定 runId 的 pending RPC（cancel 场景）。
   *
   * 遍历 pendingRpcs 查找匹配 threadId + runId 的 entry，立即 reject。
   * 这样 cancel 后正在等待的 RPC 不会继续阻塞 Agent，也不会将迟到结果送入上下文。
   */
  private rejectPendingRpcByRunId(
    threadId: string,
    runId: string,
    code: string,
    message: string,
  ): void {
    for (const [requestId, pending] of this.pendingRpcs) {
      if (pending.threadId === threadId && pending.runId === runId) {
        clearTimeout(pending.timer);
        this.pendingRpcs.delete(requestId);
        pending.reject(new Error(message));
      }
    }
    void code;
  }

  /**
   * 获取服务器状态。
   */
  getStatus(): {
    running: boolean;
    connectedDevices: number;
    authenticatedDevices: number;
    activeLeases: number;
  } {
    return {
      running: this.running,
      connectedDevices: this.registry.size(),
      authenticatedDevices: this.registry.getAuthenticatedDevices().length,
      activeLeases: this.leaseService.getActiveLeaseCount(),
    };
  }

  /**
   * Phase 8：按 deviceId 主动断开已连接设备的 WebSocket。
   *
   * 用于设备撤销场景——HTTP revoke route 更新 DB 后立即调用此方法，
   * 断开已建立的 WS 连接，避免 revoked 设备在重连前继续接收 RPC。
   * handleDisconnect 会自动清理 registry 和 pendingChallenges。
   *
   * @returns 设备在线并已断开返回 true，设备不在线返回 false
   */
  kickDevice(deviceId: string): boolean {
    const dev = this.registry.getByDeviceId(deviceId);
    if (!dev) return false;
    const ws = dev.ws as WebSocket;
    try {
      // 发送 close 帧让客户端知道是被服务端主动断开
      ws.close(4001, "device_revoked");
    } catch {
      // ws 已断开或状态异常——静默忽略，registry 仍由 handleDisconnect 清理
    }
    return true;
  }

  /**
   * 内部：处理新连接。
   *
   * 生成 challenge 并发送给客户端，等待 auth 消息。
   */
  private handleConnection(ws: WebSocket): void {
    const challenge = generateChallenge();
    this.pendingChallenges.set(ws, challenge);
    const message: ServerMessage = {
      type: "challenge",
      challenge,
      serverPublicKey: this.serverKeyPair.publicKeyBase64,
      protocolVersion: PROTOCOL_VERSION,
    };
    ws.send(serializeMessage(message));
    ws.on("message", (data) => this.handleMessage(ws, data));
    ws.on("close", () => this.handleDisconnect(ws));
    ws.on("error", () => this.handleDisconnect(ws));
  }

  /**
   * 内部：处理认证消息。
   */
  private async handleAuth(ws: WebSocket, message: AuthMessage): Promise<void> {
    const challenge = this.pendingChallenges.get(ws);
    if (!challenge) {
      this.sendAuthFailed(ws, "desktop_unauthorized", "无待验证 challenge");
      ws.close();
      return;
    }
    // 协议版本检查
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      this.sendAuthFailed(ws, "protocol_mismatch", "协议版本不兼容");
      ws.close();
      return;
    }
    // 查询 DB 中的设备记录
    const device = await getDeviceByDeviceId(message.deviceId);
    if (!device) {
      this.sendAuthFailed(ws, "desktop_unauthorized", "设备未注册");
      ws.close();
      return;
    }
    if (device.status !== "active") {
      this.sendAuthFailed(ws, "desktop_revoked", "设备已撤销");
      ws.close();
      return;
    }
    // 验证签名
    const ok = verifyAuthResponse({
      challenge,
      signature: message.signature,
      deviceId: message.deviceId,
      devicePublicKeyBase64: device.publicKey,
    });
    if (!ok) {
      this.sendAuthFailed(ws, "rpc_invalid_signature", "认证签名验证失败");
      ws.close();
      return;
    }
    // 刷新设备活动时间
    await touchDevice(message.deviceId);
    // 注册到 DeviceRegistry
    this.registry.register(
      ws,
      message.deviceId,
      device.id,
      device.userId,
      this.serverKeyPair.publicKeyBase64,
    );
    this.registry.markAuthenticated(ws);
    // 清理 pending challenge
    this.pendingChallenges.delete(ws);
    // 发送认证成功
    const authOk: ServerMessage = {
      type: "auth_ok",
      protocolVersion: PROTOCOL_VERSION,
      deviceRecordId: device.id,
      serverTime: Date.now(),
    };
    ws.send(serializeMessage(authOk));
  }

  /**
   * 内部：处理消息分发。
   */
  private handleMessage(ws: WebSocket, data: unknown): void {
    let raw: unknown;
    if (typeof data === "string") {
      raw = data;
    } else if (Buffer.isBuffer(data)) {
      raw = data.toString("utf8");
    } else if (Array.isArray(data)) {
      // ws 库的二进制分片数组
      raw = Buffer.concat(data as Buffer[]).toString("utf8");
    } else {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw as string);
    } catch {
      return;
    }
    const result = parseClientMessage(parsed);
    if (!result.ok) {
      return;
    }
    const message = result.message as ClientMessage;
    switch (message.type) {
      case "auth":
        // 异步处理认证，错误内部消化
        this.handleAuth(ws, message as AuthMessage).catch((err) => {
          console.error("[bridge] handleAuth 失败:", err);
          this.sendAuthFailed(ws, "browser_internal", "认证处理异常");
          ws.close();
        });
        break;
      case "rpc_result": {
        // 转发 RPC 结果给 pending resolver
        const envelope = (message as { envelope: unknown }).envelope as {
          requestId: string;
          ok: boolean;
          result: unknown;
          error?: { code: string; message: string };
        };
        const pending = this.pendingRpcs.get(envelope.requestId);
        if (!pending) break;
        // Phase 6-5：cancel 后到达的迟到 RPC 结果不进入 Agent 上下文
        if (
          pending.runId &&
          this.cancelService.shouldDropRpcResult(pending.threadId, pending.runId)
        ) {
          this.pendingRpcs.delete(envelope.requestId);
          clearTimeout(pending.timer);
          pending.reject(new Error("命令已被取消"));
          break;
        }
        if (envelope.ok) {
          pending.resolve(envelope.result);
        } else {
          pending.reject(new Error(envelope.error?.message ?? "RPC 执行失败"));
        }
        break;
      }
      case "heartbeat_ack": {
        // 更新心跳时间
        this.registry.updateHeartbeat(ws, Date.now());
        break;
      }
      case "lease_request": {
        // Desktop 请求获取 lease（结果由后续 RPC 路由判断，不主动 ack）
        const dev = this.registry.getByWs(ws);
        if (!dev || !dev.authenticated) {
          return;
        }
        const threadId = (message as { threadId: string }).threadId;
        this.leaseService.acquireLease({
          threadId,
          userId: dev.userId,
          deviceId: dev.deviceId,
          now: Date.now(),
        });
        break;
      }
      case "lease_release": {
        // Desktop 释放 lease
        const dev = this.registry.getByWs(ws);
        if (!dev || !dev.authenticated) {
          return;
        }
        const threadId = (message as { threadId: string }).threadId;
        this.leaseService.releaseLease(threadId, dev.deviceId, Date.now());
        break;
      }
      case "cancel_command": {
        // 用户"停止并接管"：Desktop 请求取消指定 runId 的命令
        const dev = this.registry.getByWs(ws);
        if (!dev || !dev.authenticated) {
          return;
        }
        const cancelMsg = message as CancelCommandMessage;
        this.handleCancelCommand({
          ws,
          threadId: cancelMsg.threadId,
          runId: cancelMsg.runId,
          reason: cancelMsg.reason,
        }).catch((err) => {
          console.error("[bridge] handleCancelCommand 失败:", err);
        });
        break;
      }
    }
  }

  /**
   * 内部：处理断开连接。
   *
   * 从 DeviceRegistry 移除，清理 pending challenge。
   * lease 不在此处自动释放（让 lease TTL 自然过期，避免连接抖动时频繁切换）。
   */
  private handleDisconnect(ws: WebSocket): void {
    this.pendingChallenges.delete(ws);
    const dev = this.registry.remove(ws);
    if (dev) {
      // 撤销该设备持有的所有 lease
      // 这里简单处理：通过 leaseService.revokeLease 撤销该设备持有的 lease
      // 由于 LeaseManager 没有 byDeviceId 索引，跳过主动撤销，依赖 TTL 过期
    }
  }

  /**
   * 内部：心跳检查。
   *
   * 向所有已连接的设备发送 heartbeat，清理心跳超时的设备。
   */
  private checkHeartbeats(): void {
    if (!this.wss) {
      return;
    }
    const now = Date.now();
    // 清理心跳超时设备
    const stale = this.registry.cleanupStale(now, this.config.heartbeatTimeoutMs ?? 90000);
    for (const dev of stale) {
      const ws = dev.ws as WebSocket;
      try {
        ws.close();
      } catch {
        // 忽略关闭错误
      }
    }
    // 清理过期 lease
    this.leaseService.cleanupExpired(now);
    // 向所有在线设备发送 heartbeat
    const message: ServerMessage = {
      type: "heartbeat",
      timestamp: now,
    };
    const payload = serializeMessage(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /**
   * 内部：发送认证失败消息。
   */
  private sendAuthFailed(ws: WebSocket, code: string, message: string): void {
    const msg: ServerMessage = {
      type: "auth_failed",
      error: { code, message },
    };
    try {
      ws.send(serializeMessage(msg));
    } catch {
      // 忽略发送错误
    }
  }
}
