/**
 * ：Agent Bridge WebSocket 消息协议。
 *
 * 定义 Server 和 Desktop 之间 WebSocket 通信的所有消息类型。每条消息是 JSON
 * 对象，包含 `type` 字段标识消息类型。所有消息通过 zod schema 校验。
 *
 * 消息流：
 * 1. Desktop 连接 → Server 发送 challenge
 * 2. Desktop 签名 challenge → Server 验证
 * 3. 认证成功 → 双方进入 RPC 通信模式
 * 4. Server 发送 RPC 信封 → Desktop 执行 → Desktop 返回 RPC 结果
 * 5. 定期 heartbeat 保持连接
 */
import { z } from "zod";
import { PROTOCOL_VERSION } from "./protocol";

// ──────────────────────────────────────────────
// Server → Desktop 消息
// ──────────────────────────────────────────────

/** 认证挑战 */
export const challengeMessageSchema = z.object({
  type: z.literal("challenge"),
  /** 随机挑战值（base64，32 字节） */
  challenge: z.string().min(1),
  /** Server ed25519 公钥（base64），Desktop 用于验证后续 RPC 签名 */
  serverPublicKey: z.string().min(1),
  /** Server 支持的协议版本 */
  protocolVersion: z.literal(PROTOCOL_VERSION),
});

/** 认证成功 */
export const authOkMessageSchema = z.object({
  type: z.literal("auth_ok"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  /** 设备在 Server 的内部 ID */
  deviceRecordId: z.string().min(1),
  /** 当前 Server 时间（epoch ms） */
  serverTime: z.number().int().positive(),
});

/** 认证失败 */
export const authFailedMessageSchema = z.object({
  type: z.literal("auth_failed"),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

/** RPC 请求（Server → Desktop） */
export const rpcRequestMessageSchema = z.object({
  type: z.literal("rpc"),
  envelope: z.unknown(), // RpcRequestEnvelope，在 rpc-envelope.ts 中定义
});

/** 心跳 ping */
export const heartbeatMessageSchema = z.object({
  type: z.literal("heartbeat"),
  timestamp: z.number().int().positive(),
});

/** Lease 撤销通知 */
export const leaseRevokedMessageSchema = z.object({
  type: z.literal("lease_revoked"),
  threadId: z.string().min(1),
  reason: z.string(),
});

/**
 * Lease 锁定通知（Server → Desktop）。
 *
 * Server acquire lease 后通知 Desktop：AI 即将执行命令，Desktop 应：
 * 1. 在本地 AiLockManager 中 acquire 同等锁（绑定 runId）
 * 2. 显示 WebContents overlay 阻止用户输入
 *
 * ：实现双重强制 — Server lease + Desktop 本地锁。
 */
export const leaseLockedMessageSchema = z.object({
  type: z.literal("lease_locked"),
  threadId: z.string().min(1),
  /** 持有锁的设备 ID */
  deviceId: z.string().min(1),
  /** 持有锁的用户 ID */
  userId: z.string().min(1),
  /** 绑定的 ThreadRun ID（AI 锁标识） */
  runId: z.string().min(1),
  /** 锁过期时间（epoch ms） */
  expiresAt: z.number().int().positive(),
});

/**
 * Lease 释放通知（Server → Desktop）。
 *
 * Server 在 RPC 完成（成功/失败/超时）后通知 Desktop：AI 命令已结束，Desktop 应：
 * 1. 在本地 AiLockManager 中 release 对应 runId 的锁
 * 2. 移除 WebContents overlay，恢复用户输入
 *
 * 与 lease_locked 配对使用。Desktop 收到此消息后应立即释放本地锁，
 * 避免锁持续到 TTL 过期（默认 5 分钟）而阻塞用户输入。
 *
 * 注意：cancel 场景使用 command_cancelled 消息而非 lease_released。
 */
export const leaseReleasedMessageSchema = z.object({
  type: z.literal("lease_released"),
  threadId: z.string().min(1),
  /** 要释放的 ThreadRun ID */
  runId: z.string().min(1),
});

/**
 * 命令取消通知（Server → Desktop）。
 *
 * Server 收到 cancel 请求后：
 * 1. 释放 Server lease
 * 2. 向 Desktop 发送 command_cancelled
 * Desktop 收到后应取消当前正在执行的 RPC 命令（如果有），并释放本地锁。
 *
 * 迟到的取消通知（命令已完成）Desktop 应忽略。
 */
export const commandCancelledMessageSchema = z.object({
  type: z.literal("command_cancelled"),
  threadId: z.string().min(1),
  /** 被取消的 runId */
  runId: z.string().min(1),
  /** 取消原因（user_takeover / server_shutdown / timeout） */
  reason: z.string(),
});

/** 通用错误消息 */
export const serverErrorMessageSchema = z.object({
  type: z.literal("error"),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ──────────────────────────────────────────────
// Desktop → Server 消息
// ──────────────────────────────────────────────

/** 认证响应（签名挑战） */
export const authMessageSchema = z.object({
  type: z.literal("auth"),
  /** 设备标识（Desktop 本地生成） */
  deviceId: z.string().min(1),
  /** 对 challenge 的 ed25519 签名（base64） */
  signature: z.string().min(1),
  /** Desktop 应用版本 */
  version: z.string().min(1),
  /** 设备名称 */
  name: z.string().min(1),
  /** Desktop 支持的协议版本 */
  protocolVersion: z.literal(PROTOCOL_VERSION),
});

/** RPC 结果（Desktop → Server） */
export const rpcResultMessageSchema = z.object({
  type: z.literal("rpc_result"),
  envelope: z.unknown(), // RpcResultEnvelope
});

/** 心跳 pong */
export const heartbeatAckMessageSchema = z.object({
  type: z.literal("heartbeat_ack"),
  timestamp: z.number().int().positive(),
});

/** 请求获取 Thread 的 lease */
export const leaseRequestMessageSchema = z.object({
  type: z.literal("lease_request"),
  threadId: z.string().min(1),
});

/** 释放 Thread 的 lease */
export const leaseReleaseMessageSchema = z.object({
  type: z.literal("lease_release"),
  threadId: z.string().min(1),
});

/**
 * 取消命令请求（Desktop → Server）。
 *
 * 用户点击"停止并接管"时，Desktop 先发送此消息到 Server：
 * 1. Desktop 释放本地 AI 锁（立即阻止 AI 继续操作）
 * 2. Desktop 发送 cancel_command 到 Server
 * 3. Server 释放 lease 并广播 command_cancelled
 * 4. AI 当前正在执行的 RPC 收到 interrupted 错误
 *
 * 注意：Desktop 释放本地锁在先（立即阻止用户输入被覆盖），
 * Server 释放 lease 在后（保证 RPC 不会被路由到该设备）。
 */
export const cancelCommandMessageSchema = z.object({
  type: z.literal("cancel_command"),
  threadId: z.string().min(1),
  /** 要取消的 runId */
  runId: z.string().min(1),
  /** 取消原因 */
  reason: z.string(),
});

// ──────────────────────────────────────────────
// 消息联合类型
// ──────────────────────────────────────────────

/** Server → Desktop 消息 schema 联合 */
export const serverMessageSchema = z.discriminatedUnion("type", [
  challengeMessageSchema,
  authOkMessageSchema,
  authFailedMessageSchema,
  rpcRequestMessageSchema,
  heartbeatMessageSchema,
  leaseRevokedMessageSchema,
  leaseLockedMessageSchema,
  leaseReleasedMessageSchema,
  commandCancelledMessageSchema,
  serverErrorMessageSchema,
]);

/** Desktop → Server 消息 schema 联合 */
export const clientMessageSchema = z.discriminatedUnion("type", [
  authMessageSchema,
  rpcResultMessageSchema,
  heartbeatAckMessageSchema,
  leaseRequestMessageSchema,
  leaseReleaseMessageSchema,
  cancelCommandMessageSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ChallengeMessage = z.infer<typeof challengeMessageSchema>;
export type AuthOkMessage = z.infer<typeof authOkMessageSchema>;
export type AuthFailedMessage = z.infer<typeof authFailedMessageSchema>;
export type RpcRequestMessage = z.infer<typeof rpcRequestMessageSchema>;
export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;
export type LeaseRevokedMessage = z.infer<typeof leaseRevokedMessageSchema>;
export type LeaseLockedMessage = z.infer<typeof leaseLockedMessageSchema>;
export type LeaseReleasedMessage = z.infer<typeof leaseReleasedMessageSchema>;
export type CommandCancelledMessage = z.infer<typeof commandCancelledMessageSchema>;
export type ServerErrorMessage = z.infer<typeof serverErrorMessageSchema>;

export type AuthMessage = z.infer<typeof authMessageSchema>;
export type RpcResultMessage = z.infer<typeof rpcResultMessageSchema>;
export type HeartbeatAckMessage = z.infer<typeof heartbeatAckMessageSchema>;
export type LeaseRequestMessage = z.infer<typeof leaseRequestMessageSchema>;
export type LeaseReleaseMessage = z.infer<typeof leaseReleaseMessageSchema>;
export type CancelCommandMessage = z.infer<typeof cancelCommandMessageSchema>;

/**
 * 序列化消息为 JSON 字符串。
 */
export function serializeMessage(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}

/**
 * 解析 Server → Desktop 消息。
 */
export function parseServerMessage(
  raw: unknown,
): { ok: true; message: ServerMessage } | { ok: false; error: string } {
  const result = serverMessageSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, message: result.data };
  }
  return { ok: false, error: result.error.message };
}

/**
 * 解析 Desktop → Server 消息。
 */
export function parseClientMessage(
  raw: unknown,
): { ok: true; message: ClientMessage } | { ok: false; error: string } {
  const result = clientMessageSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, message: result.data };
  }
  return { ok: false, error: result.error.message };
}
