/**
 * V10 Phase 5：设备身份管理（纯逻辑 + Keychain 集成接口）。
 *
 * Desktop 首次启动时生成 ed25519 设备密钥对和 UUID 设备 ID，序列化后通过
 * KeychainAdapter 持久化到 macOS Keychain（加密存储）。后续启动从 Keychain
 * 加载已有身份，确保设备 ID 跨重启稳定。
 *
 * 安全约束：
 * - 私钥仅在本地持有，不上传 Server（Server 只存储设备公钥用于验签）
 * - 身份序列化为 JSON 后由 Keychain 加密落盘，明文不写盘
 * - 反序列化时严格校验字段，防止篡改导致密钥注入
 */
import { randomUUID } from "node:crypto";
import { type DeviceKeyPair, generateDeviceKeyPair } from "../../lib/desktop/signing";
import type { KeychainAdapter } from "../storage/keychain";

/** Keychain 存储完整设备身份的 key */
const DEVICE_IDENTITY_KEY = "device-identity";
/** Keychain 存储设备 ID（便于快速读取，无需反序列化密钥） */
const DEVICE_ID_KEY = "device-id";

/**
 * 设备身份。
 */
export interface DeviceIdentity {
  /** 设备 ID（UUID v4） */
  deviceId: string;
  /** ed25519 密钥对（base64） */
  keyPair: DeviceKeyPair;
}

/**
 * 生成新设备身份。
 *
 * 使用 node:crypto 的 randomUUID 生成设备 ID，generateDeviceKeyPair 生成
 * ed25519 密钥对。
 *
 * @returns 新设备身份
 */
export function createDeviceIdentity(): DeviceIdentity {
  return {
    deviceId: randomUUID(),
    keyPair: generateDeviceKeyPair(),
  };
}

/**
 * 将设备身份序列化为 JSON（用于 Keychain 存储）。
 *
 * @param identity 设备身份
 * @returns JSON 字符串
 */
export function serializeIdentity(identity: DeviceIdentity): string {
  return JSON.stringify({
    deviceId: identity.deviceId,
    keyPair: identity.keyPair,
  });
}

/**
 * 从 JSON 反序列化设备身份。
 *
 * 严格校验字段类型，任一字段缺失或类型错误返回 null。
 *
 * @param json JSON 字符串
 * @returns 设备身份，解析失败返回 null
 */
export function deserializeIdentity(json: string): DeviceIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.deviceId !== "string" || obj.deviceId.length === 0) {
    return null;
  }
  const keyPair = obj.keyPair;
  if (typeof keyPair !== "object" || keyPair === null) {
    return null;
  }
  const kp = keyPair as Record<string, unknown>;
  if (
    typeof kp.publicKeyBase64 !== "string" ||
    kp.publicKeyBase64.length === 0 ||
    typeof kp.privateKeyBase64 !== "string" ||
    kp.privateKeyBase64.length === 0
  ) {
    return null;
  }
  return {
    deviceId: obj.deviceId,
    keyPair: {
      publicKeyBase64: kp.publicKeyBase64,
      privateKeyBase64: kp.privateKeyBase64,
    },
  };
}

/**
 * 从 Keychain 加载设备身份。
 *
 * @param keychain Keychain 适配器
 * @returns 设备身份，不存在返回 null
 */
export async function loadDeviceIdentity(
  keychain: KeychainAdapter,
): Promise<DeviceIdentity | null> {
  const json = await keychain.get(DEVICE_IDENTITY_KEY);
  if (json === null) {
    return null;
  }
  return deserializeIdentity(json);
}

/**
 * 保存设备身份到 Keychain。
 *
 * 同时存储完整身份（含密钥）和单独的设备 ID（便于快速读取）。
 *
 * @param keychain Keychain 适配器
 * @param identity 设备身份
 */
export async function saveDeviceIdentity(
  keychain: KeychainAdapter,
  identity: DeviceIdentity,
): Promise<void> {
  await keychain.set(DEVICE_IDENTITY_KEY, serializeIdentity(identity));
  await keychain.set(DEVICE_ID_KEY, identity.deviceId);
}

/**
 * Phase 8：清除 Keychain 中的设备身份。
 *
 * 用户退出登录 / 设备撤销后调用，删除完整身份和设备 ID。
 * 幂等——Keychain 中无对应 key 时不抛错。
 *
 * @param keychain Keychain 适配器
 */
export async function clearDeviceIdentity(keychain: KeychainAdapter): Promise<void> {
  await keychain.delete(DEVICE_IDENTITY_KEY);
  await keychain.delete(DEVICE_ID_KEY);
}

/** 导出 Keychain 存储 key 常量（供调试 / 迁移使用） */
export { DEVICE_IDENTITY_KEY, DEVICE_ID_KEY };
