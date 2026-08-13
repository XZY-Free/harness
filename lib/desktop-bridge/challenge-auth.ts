/**
 * ：Desktop 认证挑战逻辑。
 *
 * Desktop 通过 WebSocket 连接到 Server 后，Server 发送随机 challenge，
 * Desktop 用本地长期 ed25519 私钥签名 challenge，Server 验证签名以确认设备身份。
 *
 * 安全约束：
 * - challenge 必须为 32 字节随机数，防止暴力枚举
 * - 签名验证失败必须立即拒绝连接
 * - Server 启动时生成自己的签名密钥对，用于后续 RPC 信封签名
 */
import { randomBytes } from "node:crypto";
import { generateDeviceKeyPair, verifySignature } from "../desktop/signing";

/**
 * 生成认证挑战（base64，32 字节随机）。
 *
 * @returns base64 编码的 32 字节随机数
 */
export function generateChallenge(): string {
  return randomBytes(32).toString("base64");
}

/**
 * 验证 Desktop 的认证响应。
 *
 * Desktop 用长期 ed25519 私钥签名 challenge，Server 用 DB 中存储的设备公钥验签。
 * 签名验证失败或参数无效均返回 false（保守默认：拒绝）。
 *
 * @param params.challenge Server 发送的 challenge
 * @param params.signature Desktop 返回的签名
 * @param params.deviceId 设备 ID（仅用于上下文，不参与签名验证）
 * @param params.devicePublicKeyBase64 从 DB 查询的设备公钥
 * @returns 验证通过返回 true，失败返回 false
 */
export function verifyAuthResponse(params: {
  challenge: string;
  signature: string;
  deviceId: string;
  devicePublicKeyBase64: string;
}): boolean {
  const { challenge, signature, devicePublicKeyBase64 } = params;
  // 参数基础校验：challenge 和 signature 必须为非空字符串
  if (typeof challenge !== "string" || challenge.length === 0) {
    return false;
  }
  if (typeof signature !== "string" || signature.length === 0) {
    return false;
  }
  if (typeof devicePublicKeyBase64 !== "string" || devicePublicKeyBase64.length === 0) {
    return false;
  }
  try {
    return verifySignature(challenge, signature, devicePublicKeyBase64);
  } catch {
    // 签名验证抛错（公钥或签名格式无效）视为验证失败
    return false;
  }
}

/**
 * 生成 Server 签名密钥对（启动时调用一次）。
 *
 * Server 用此密钥对签名后续 RPC 信封，Desktop 用对应公钥验签。
 * 私钥仅在 Server 进程内存中持有，不持久化。
 *
 * @returns ed25519 密钥对（base64 编码）
 */
export function generateServerKeyPair(): {
  publicKeyBase64: string;
  privateKeyBase64: string;
} {
  return generateDeviceKeyPair();
}
