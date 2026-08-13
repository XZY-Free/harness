/**
 * ：RPC 安全校验。
 *
 * Desktop 收到 Server 发来的 RPC 请求后，必须经过完整的安全校验才能执行：
 * 1. schema 解析（字段完整、类型正确）
 * 2. 协议版本检查（兼容当前版本）
 * 3. deviceId 匹配（请求目标设备正确）
 * 4. userId 匹配（可选，绑定用户会话时启用）
 * 5. 过期检查（防止重放过期请求）
 * 6. 签名验证（防止伪造或篡改）
 * 7. 命令白名单检查（仅允许已注册命令）
 * 8. payload schema 校验（参数类型正确）
 *
 * NonceDeduplicator 用于防止 nonce 重放：每个 nonce 在有效期内只能使用一次。
 */
import { isAllowedCommand, validateCommandPayload } from "./commands";
import { isCompatibleVersion } from "./protocol";
import {
  type RpcRequestEnvelope,
  getEnvelopeSignPayload,
  rpcRequestEnvelopeSchema,
} from "./rpc-envelope";
import { verifySignature } from "./signing";

/**
 * RPC 校验结果类型。
 */
export type RpcValidationResult =
  | { ok: true; envelope: RpcRequestEnvelope }
  | { ok: false; code: string; message: string };

/**
 * Nonce 去重器（有界窗口）。
 *
 * 维护一个 nonce → expiresAt 的映射，超过 maxSize 时淘汰最旧条目。
 * 调用 cleanup() 可主动清理过期 nonce。
 */
export class NonceDeduplicator {
  private nonces = new Map<string, number>();
  private maxSize: number;

  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  /**
   * 检查并记录 nonce。
   *
   * @param nonce 待检查的 nonce
   * @param expiresAt nonce 的过期时间（epoch ms）
   * @returns 首次见到返回 true，重复返回 false
   */
  checkAndAdd(nonce: string, expiresAt: number): boolean {
    if (this.nonces.has(nonce)) {
      return false;
    }
    // 超出容量时淘汰最旧条目（Map 保持插入顺序）
    if (this.nonces.size >= this.maxSize) {
      const oldestKey = this.nonces.keys().next().value;
      if (oldestKey !== undefined) {
        this.nonces.delete(oldestKey);
      }
    }
    this.nonces.set(nonce, expiresAt);
    return true;
  }

  /**
   * 清理过期 nonce。
   *
   * @param now 当前时间（epoch ms）
   * @returns 清理的 nonce 数量
   */
  cleanup(now: number): number {
    let cleaned = 0;
    for (const [key, expiresAt] of this.nonces) {
      if (expiresAt < now) {
        this.nonces.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * 当前 nonce 数量。
   */
  size(): number {
    return this.nonces.size;
  }
}

/**
 * 完整的 RPC 信封校验。
 *
 * 按顺序执行各项校验，首次失败即返回错误。
 *
 * @param rawEnvelope 原始信封（未解析）
 * @param expectedDeviceId 期望的设备 ID
 * @param expectedUserId 期望的用户 ID（null 表示跳过用户校验）
 * @param serverPublicKeyBase64 Server 的公钥（base64）
 * @param now 当前时间（epoch ms）
 * @returns 校验结果
 */
export function validateRpcEnvelope(
  rawEnvelope: unknown,
  expectedDeviceId: string,
  expectedUserId: string | null,
  serverPublicKeyBase64: string,
  now: number,
): RpcValidationResult {
  // 1. schema 解析
  const parseResult = rpcRequestEnvelopeSchema.safeParse(rawEnvelope);
  if (!parseResult.success) {
    return {
      ok: false,
      code: "rpc_invalid_payload",
      message: "信封 schema 校验失败",
    };
  }
  const envelope = parseResult.data;

  // 2. 协议版本检查
  if (!isCompatibleVersion(envelope.protocolVersion)) {
    return {
      ok: false,
      code: "protocol_mismatch",
      message: `协议版本不兼容：期望 ${1}，收到 ${envelope.protocolVersion}`,
    };
  }

  // 3. deviceId 匹配
  if (envelope.deviceId !== expectedDeviceId) {
    return {
      ok: false,
      code: "unauthorized",
      message: `deviceId 不匹配：期望 ${expectedDeviceId}，收到 ${envelope.deviceId}`,
    };
  }

  // 4. userId 匹配（如果 expectedUserId 不为 null）
  if (expectedUserId !== null && envelope.userId !== expectedUserId) {
    return {
      ok: false,
      code: "unauthorized",
      message: `userId 不匹配：期望 ${expectedUserId}，收到 ${envelope.userId}`,
    };
  }

  // 5. 过期检查
  if (now > envelope.expiresAt) {
    return {
      ok: false,
      code: "rpc_timeout",
      message: `请求已过期：expiresAt=${envelope.expiresAt}，now=${now}`,
    };
  }

  // 6. 签名验证
  const signPayload = getEnvelopeSignPayload(envelope);
  let signatureValid: boolean;
  try {
    signatureValid = verifySignature(signPayload, envelope.signature, serverPublicKeyBase64);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return {
      ok: false,
      code: "rpc_invalid_signature",
      message: "签名验证失败",
    };
  }

  // 7. 命令白名单检查
  if (!isAllowedCommand(envelope.command)) {
    return {
      ok: false,
      code: "unknown_command",
      message: `未知命令：${envelope.command}`,
    };
  }

  // 8. payload schema 校验
  const payloadResult = validateCommandPayload(envelope.command, envelope.payload);
  if (!payloadResult.ok) {
    return {
      ok: false,
      code: "rpc_invalid_payload",
      message: `payload 校验失败：${payloadResult.error}`,
    };
  }

  return { ok: true, envelope };
}
