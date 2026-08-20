/**
 * 设备身份管理（纯逻辑 + Keychain 集成接口）。
 *
 * Desktop 首次启动时生成 ed25519 设备密钥对和 UUID 设备 ID，序列化后通过
 * KeychainAdapter 持久化到 macOS Keychain（加密存储）。后续启动从 Keychain
 * 加载已有身份，确保设备 ID 跨重启稳定。
 *
 * tenantId 来自 Server 注册响应（不是本地默认值），用于后续 Bridge 认证签名绑定。
 * 设备创建时尚未注册，tenantId 为 null；注册成功后由调用方更新并重新持久化。
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
  /** 设备 ID（UUID v4，即正式模型的 deviceKey） */
  deviceId: string;
  /** ed25519 密钥对（base64） */
  keyPair: DeviceKeyPair;
  /**
   * 设备所属租户。来自 Server 注册响应（非本地默认），用于 Bridge 认证签名绑定。
   * 未注册（或旧身份未回填）为 null，此时无法建立认证连接。
   */
  tenantId: string | null;
}

/**
 * 生成新设备身份。
 *
 * 使用 node:crypto 的 randomUUID 生成设备 ID，generateDeviceKeyPair 生成
 * ed25519 密钥对。tenantId 初始为 null（尚未注册）。
 *
 * @returns 新设备身份
 */
export function createDeviceIdentity(): DeviceIdentity {
  return {
    deviceId: randomUUID(),
    keyPair: generateDeviceKeyPair(),
    tenantId: null,
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
    tenantId: identity.tenantId,
  });
}

/**
 * 从 JSON 反序列化设备身份。
 *
 * 严格校验字段类型，任一字段缺失或类型错误返回 null。
 *
 * tenantId 必须显式存在于 JSON 中，且为 null 或非空合法值：
 * - 缺字段 / undefined → 返回 null（缺失 tenantId 的身份拒绝加载，调用方生成新身份重新注册）
 * - null → 未注册身份，可反序列化
 * - 非空 string → 已注册身份，必须显式回填
 *
 * 不提供降级路径：缺失 tenantId 的身份一律拒绝，强制重新生成注册。
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
  // tenantId 必须显式存在（own property 且非 undefined）
  if (!("tenantId" in obj) || obj.tenantId === undefined) {
    return null;
  }
  const tenantId = obj.tenantId;
  if (tenantId !== null && (typeof tenantId !== "string" || tenantId.length === 0)) {
    return null;
  }
  return {
    deviceId: obj.deviceId,
    keyPair: {
      publicKeyBase64: kp.publicKeyBase64,
      privateKeyBase64: kp.privateKeyBase64,
    },
    tenantId,
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
 * 同时存储完整身份（含密钥，DEVICE_IDENTITY_KEY）和单独的设备 ID
 * （DEVICE_ID_KEY，便于快速读取）。
 *
 * 原子性约束：DEVICE_IDENTITY_KEY 完整身份是本地注册唯一 Authority/提交标记，
 * 必须最后写入；DEVICE_ID_KEY 仅是其镜像，先写。任一步失败时，旧完整身份
 * （含旧 tenantId）仍可从 DEVICE_IDENTITY_KEY 加载，内存与重启都不会观察到
 * 未安全提交的新租户。
 *
 * @param keychain Keychain 适配器
 * @param identity 设备身份
 */
export async function saveDeviceIdentity(
  keychain: KeychainAdapter,
  identity: DeviceIdentity,
): Promise<void> {
  // 先写 device-id 镜像，最后写完整身份作为提交标记。
  await keychain.set(DEVICE_ID_KEY, identity.deviceId);
  await keychain.set(DEVICE_IDENTITY_KEY, serializeIdentity(identity));
}

/**
 * 清除 Keychain 中的设备身份。
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
