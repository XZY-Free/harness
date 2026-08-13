/**
 * Desktop 设备签名验证。
 *
 * Desktop 本地路径操作同时校验员工 Session、设备 id、请求签名、公钥状态和时间窗口
 * （11-api-and-event-boundaries.md ）。
 *
 * 校验流程：
 * 1. 员工 Session 校验：从 Authorization 解析当前 user_id、tenant_id（由 resolvePrincipal 完成）。
 * 2. 设备 id 校验：X-Desktop-Device-Key 必须属于当前员工且 deviceState != revoked。
 * 3. 公钥验签：使用 device.publicKey 验证 X-Desktop-Signature（ed25519）。
 * 4. 时间窗口：签名 payload 含时间戳，超时拒绝（防重放）。
 * 5. nonce 重放保护（S12-W05）：签名 payload 含 nonce，TTL 内不可重复使用。
 *
 * 涉及的 API 入口（需 Desktop 签名）：
 * - POST /api/v1/threads/{thread_id}/turns（创建 Turn）
 * - POST /api/v1/threads/{thread_id}/workspace-attachments（附加本地资源）
 *
 * 事实源：docs/architecture/api-and-events.md 、
 * docs/architecture/persistence.md 、
 * docs/architecture/security.md §5。
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import type { Device } from "@/lib/persistence/schema/device";

/** Desktop 签名相关 header 名（小写）。 */
export const DESKTOP_DEVICE_KEY_HEADER = "x-desktop-device-key";
export const DESKTOP_SIGNATURE_HEADER = "x-desktop-signature";
export const DESKTOP_TIMESTAMP_HEADER = "x-desktop-timestamp";
/** S12-W05：nonce header（防重放）。 */
export const DESKTOP_NONCE_HEADER = "x-desktop-nonce";

/**
 * 签名重放保护时间窗口（ms）。
 * 签名 payload 中的时间戳超过此窗口的请求被拒绝。
 * 默认 5min——与 Runtime Token TTL 对齐，允许轻微时钟漂移。
 */
export const DESKTOP_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** 设备签名验证错误（route 层应映射为 401 AUTHENTICATION_REQUIRED）。 */
export class DeviceSignatureError extends Error {
  constructor(
    public readonly code:
      | "missing_device_key"
      | "missing_signature"
      | "missing_timestamp"
      | "missing_nonce"
      | "device_not_found"
      | "device_revoked"
      | "device_owner_mismatch"
      | "signature_invalid"
      | "timestamp_expired"
      | "malformed_signature"
      | "malformed_timestamp",
    message: string,
  ) {
    super(message);
  }
}

/**
 * 从请求 header 提取 Desktop 签名信息。
 * 缺失任何必需 header 返回相应错误。
 *
 * S12-W05：新增可选 nonce 字段。调用方可通过 parseDesktopSignatureHeadersWithNonce
 * 强制要求 nonce 并触发重放保护。
 */
export function extractDesktopSignature(headers: Headers): {
  deviceKey: string;
  signature: string;
  timestamp: number;
  nonce: string | null;
} {
  const deviceKey = headers.get(DESKTOP_DEVICE_KEY_HEADER)?.trim();
  if (!deviceKey) {
    throw new DeviceSignatureError("missing_device_key", "缺少 X-Desktop-Device-Key");
  }

  const signature = headers.get(DESKTOP_SIGNATURE_HEADER)?.trim();
  if (!signature) {
    throw new DeviceSignatureError("missing_signature", "缺少 X-Desktop-Signature");
  }

  const timestampStr = headers.get(DESKTOP_TIMESTAMP_HEADER)?.trim();
  if (!timestampStr) {
    throw new DeviceSignatureError("missing_timestamp", "缺少 X-Desktop-Timestamp");
  }

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) {
    throw new DeviceSignatureError("malformed_timestamp", "X-Desktop-Timestamp 非数字");
  }

  const nonce = headers.get(DESKTOP_NONCE_HEADER)?.trim() ?? null;

  return { deviceKey, signature, timestamp, nonce };
}

/**
 * 构造签名 payload（规范化的待签名字符串）。
 *
 * Desktop 客户端必须按相同顺序拼接，否则验签失败：
 * - 无 nonce（旧客户端）：{method}\n{path}\n{timestamp}\n{bodyHash}
 * - 有 nonce（S12-W05 新客户端）：{method}\n{path}\n{timestamp}\n{bodyHash}\n{nonce}
 *
 * - method：HTTP 方法大写（GET/POST/PUT/PATCH/DELETE）。
 * - path：URL path（含 audience 前缀，不含 query string）。
 * - timestamp：Unix ms 时间戳（与 X-Desktop-Timestamp 一致）。
 * - bodyHash：请求体的 SHA-256 hex；GET/DELETE 无 body 时为空串的 SHA-256。
 * - nonce：客户端生成的随机串（S12-W05，防重放）；缺失时使用旧 4 字段格式（向后兼容）。
 *
 * S12-W05 变更：nonce 非空时 payload 末尾追加 nonce 行。
 */
export function buildSignaturePayload(params: {
  method: string;
  path: string;
  timestamp: number;
  bodyHash: string;
  nonce?: string | null;
}): string {
  const base = `${params.method.toUpperCase()}\n${params.path}\n${params.timestamp}\n${params.bodyHash}`;
  if (params.nonce && params.nonce.length > 0) {
    return `${base}\n${params.nonce}`;
  }
  return base;
}

/**
 * 计算请求体的 SHA-256 hex。
 * GET/DELETE 无 body 时传入空串，返回空串的 SHA-256。
 */
export function computeBodyHash(body: string): string {
  return createHash("sha256").update(body, "utf-8").digest("hex");
}

/**
 * 校验时间戳在允许窗口内（防重放）。
 * 超过 DESKTOP_SIGNATURE_WINDOW_MS 的请求被拒绝。
 */
export function assertTimestampInWindow(timestamp: number, now: number = Date.now()): void {
  const age = Math.abs(now - timestamp);
  if (age > DESKTOP_SIGNATURE_WINDOW_MS) {
    throw new DeviceSignatureError(
      "timestamp_expired",
      `签名时间戳超出窗口（age=${age}ms, window=${DESKTOP_SIGNATURE_WINDOW_MS}ms）`,
    );
  }
}

/**
 * 验证设备签名（ed25519）。
 *
 * @param publicKeyBase64 设备公钥（base64）
 * @param payload 签名 payload（由 buildSignaturePayload 构造）
 * @param signatureBase64 签名（base64）
 * @throws DeviceSignatureError signature_invalid / malformed_signature
 */
export function verifyDeviceSignature(params: {
  publicKeyBase64: string;
  payload: string;
  signatureBase64: string;
}): void {
  let signatureBuf: Buffer;
  try {
    signatureBuf = Buffer.from(params.signatureBase64, "base64");
  } catch {
    throw new DeviceSignatureError("malformed_signature", "签名 base64 解码失败");
  }

  if (signatureBuf.length === 0) {
    throw new DeviceSignatureError("malformed_signature", "签名为空");
  }

  // ed25519 公钥需 DER 包装：从 base64 原始 32 字节构造为 SPKI DER。
  // Node.js crypto.createPublicKey 接受 raw key via { key, format: 'der', type: 'spki' }
  // 但 ed25519 raw 32 字节需手动包装为 SPKI。
  let publicKeyBuf: Buffer;
  try {
    publicKeyBuf = Buffer.from(params.publicKeyBase64, "base64");
  } catch {
    throw new DeviceSignatureError("signature_invalid", "公钥 base64 解码失败");
  }

  if (publicKeyBuf.length !== 32) {
    throw new DeviceSignatureError(
      "signature_invalid",
      `ed25519 公钥长度非 32 字节（实际 ${publicKeyBuf.length}）`,
    );
  }

  // SPKI DER 前缀 for ed25519（RFC 8410）：
  // 30 2a 30 05 06 03 2b 65 70 03 21 00 <32-byte key>
  const spkiPrefix = Buffer.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  const der = Buffer.concat([spkiPrefix, publicKeyBuf]);

  let pubkey: ReturnType<typeof createPublicKey>;
  try {
    pubkey = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new DeviceSignatureError("signature_invalid", "公钥构造失败");
  }

  let isValid: boolean;
  try {
    isValid = verify(
      null, // ed25519 无算法参数
      Buffer.from(params.payload, "utf-8"),
      pubkey,
      signatureBuf,
    );
  } catch {
    throw new DeviceSignatureError("signature_invalid", "验签抛错");
  }

  if (!isValid) {
    throw new DeviceSignatureError("signature_invalid", "签名校验失败");
  }
}

/**
 * 校验设备状态与归属（route handler 在验签前调用）。
 *
 * @param device 设备记录（从 DB 查询）
 * @param expectedUserId 当前员工 Session 的 userIdentityId
 * @throws DeviceSignatureError device_revoked / device_owner_mismatch
 */
export function assertDeviceValid(device: Device, expectedUserId: string): void {
  if (device.deviceState === "revoked") {
    throw new DeviceSignatureError("device_revoked", `设备已撤销（deviceKey=${device.deviceKey}）`);
  }
  if (device.userId !== expectedUserId) {
    throw new DeviceSignatureError("device_owner_mismatch", "设备不属于当前员工");
  }
}

/**
 * 完整 Desktop 签名校验流程（route handler 入口用）。
 *
 * 流程：
 * 1. extractDesktopSignature：提取 header。
 * 2. assertTimestampInWindow：防重放。
 * 3. （调用方）getDeviceByKey：查设备记录。
 * 4. assertDeviceValid：校验状态与归属。
 * 5. buildSignaturePayload + computeBodyHash：构造 payload。
 * 6. verifyDeviceSignature：ed25519 验签。
 *
 * 本函数只做 1-2 步（header 提取 + 时间窗口），后续步骤需调用方配合 DB 查询与 body 读取。
 * 设计原因：DB 查询与 body 读取涉及 IO，本函数保持纯函数便于测试。
 *
 * S12-W05 变更：返回 nonce（可能为 null）；如需强制 nonce + 重放保护，
 * 调用 parseDesktopSignatureHeadersWithNonce。
 *
 * @returns 提取的签名信息（deviceKey/signature/timestamp/nonce），供调用方后续校验。
 */
export function parseDesktopSignatureHeaders(headers: Headers): {
  deviceKey: string;
  signature: string;
  timestamp: number;
  nonce: string | null;
} {
  const info = extractDesktopSignature(headers);
  assertTimestampInWindow(info.timestamp);
  return info;
}

/**
 * 完整 Desktop 签名校验流程 + nonce 提取（S12-W05）。
 *
 * 与 parseDesktopSignatureHeaders 区别：
 * - 强制要求 X-Desktop-Nonce header 存在。
 * - 不在此处调用 nonce 重放保护（避免循环依赖）；调用方应在拿到 nonce 后
 * 显式调用 `assertNonceNotReplayed(info.deviceKey, info.nonce, info.timestamp)`。
 *
 * 流程：
 * 1. extractDesktopSignature：提取 header（含 nonce）。
 * 2. assertTimestampInWindow：时间窗口校验。
 * 3. 校验 nonce 存在（仅 header 解析层面；重放保护由调用方触发）。
 *
 * 本函数只做 1-3 步，后续步骤（设备查询/验签/nonce 重放保护）需调用方配合。
 *
 * @throws DeviceSignatureError 缺少/非法 header、时间戳超时、缺少 nonce
 */
export function parseDesktopSignatureHeadersWithNonce(headers: Headers): {
  deviceKey: string;
  signature: string;
  timestamp: number;
  nonce: string;
} {
  const info = extractDesktopSignature(headers);
  assertTimestampInWindow(info.timestamp);
  if (!info.nonce) {
    throw new DeviceSignatureError("missing_nonce", "缺少 X-Desktop-Nonce（S12-W05 强制要求）");
  }
  return {
    deviceKey: info.deviceKey,
    signature: info.signature,
    timestamp: info.timestamp,
    nonce: info.nonce,
  };
}
