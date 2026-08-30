import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { secretConfig } from "@/lib/config";

/**
 * AES-256-GCM secret 加密/解密。
 *
 * 生产级 secret at rest 保护（plan §1 决策）：
 * - 加密算法：AES-256-GCM（认证加密，密文含 auth tag，防篡改）
 * - master key：来自 `SECRET_MASTER_KEY` env（平台级），32 字节（256 bit）
 * - 密文格式：`base64(iv[12] || ciphertext || tag[16])`——单 blob 存储，解密时拆分
 * - keyId：记录加密用 master key 的标识（支持后续 key 轮换时识别需 re-encrypt 的密文）
 *
 * fail-closed（plan §7/§12 风险表）：
 * - master key 缺失 → `encrypt`/`decrypt` 抛错，**绝不**明文存储/注入
 * - key 不匹配 → GCM auth tag 校验失败 → 抛错（不返回明文）
 */

/** AES-256-GCM 密钥长度（字节）。 */
const KEY_LENGTH = 32;
/** GCM IV 长度（字节）。 */
const IV_LENGTH = 12;
/** GCM auth tag 长度（字节）。 */
const TAG_LENGTH = 16;

/** 加密结果：含 keyId（用于 key 轮换识别）+ 密文 blob（base64）。 */
export interface EncryptedSecret {
  keyId: string;
  /** base64(iv[12] || ciphertext || tag[16]) */
  ciphertext: string;
}

/**
 * 从 env 加载 master key（32 字节）。
 *
 * 支持 base64 / hex / utf-8 三种编码：
 * - base64：44 字符（含 padding）→ 解码 32 字节
 * - hex：64 字符 → 解码 32 字节
 * - utf-8：32 字符 → 直接用作 key（不推荐生产，但便于 dev/test）
 *
 * @throws master key 缺失或长度不正确时抛错（fail-closed）
 */
export function loadMasterKey(): Buffer {
  const raw = secretConfig.masterKey;
  if (!raw) {
    throw new Error(
      "[secret-crypto] SECRET_MASTER_KEY 未配置——secretMount fail-closed（不明文回退）。" +
        "请设置 SECRET_MASTER_KEY 为 32 字节 base64/hex 编码的密钥。",
    );
  }

  // 尝试 base64 解码
  try {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === KEY_LENGTH) return buf;
  } catch {
    // not base64
  }

  // 尝试 hex 解码
  try {
    const buf = Buffer.from(raw, "hex");
    if (buf.length === KEY_LENGTH) return buf;
  } catch {
    // not hex
  }

  // utf-8 直接使用（需正好 32 字节）
  const buf = Buffer.from(raw, "utf-8");
  if (buf.length === KEY_LENGTH) return buf;

  throw new Error(
    `[secret-crypto] SECRET_MASTER_KEY 长度不正确（需 ${KEY_LENGTH} 字节，实际 ${buf.length}）。支持 base64（44字符）/ hex（64字符）/ utf-8（32字符）编码。`,
  );
}

/** 检查 master key 是否已配置（不抛错）。 */
export function isMasterKeyConfigured(): boolean {
  try {
    loadMasterKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * 加密 secret 明文（AES-256-GCM）。
 *
 * @param plaintext secret 明文值
 * @returns 加密结果（keyId + base64 密文 blob）
 * @throws master key 缺失或无效时抛错（fail-closed）
 */
export function encrypt(plaintext: string): EncryptedSecret {
  const key = loadMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 密文 blob = iv[12] || encrypted || tag[16]
  const blob = Buffer.concat([iv, encrypted, tag]);
  return {
    keyId: secretConfig.keyId,
    ciphertext: blob.toString("base64"),
  };
}

/**
 * 解密 secret 密文（AES-256-GCM）。
 *
 * @param encrypted 加密结果（keyId + base64 密文 blob）
 * @returns secret 明文值
 * @throws master key 缺失、key 不匹配、密文被篡改时抛错（fail-closed，不返回明文）
 */
export function decrypt(encrypted: EncryptedSecret): string {
  const key = loadMasterKey();
  const blob = Buffer.from(encrypted.ciphertext, "base64");
  if (blob.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("[secret-crypto] 密文长度不足（可能已损坏）");
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH, blob.length - TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8");
}

// ─── : cicdApiToken 加密存储辅助函数 ──────────────────

/**
 * 加密 cicdApiToken（AES-256-GCM），返回 JSON 密文字符串。
 * fail-closed：master key 未配置时抛错，绝不存明文。
 */
export function encryptCicdToken(plaintext: string): string {
  return JSON.stringify(encrypt(plaintext));
}

/**
 * 解密 cicdApiToken。fail-closed:仅接受 encryptCicdToken 产的 JSON 密文,否则抛错。
 *
 * 非密文 stored 一律拒绝，避免数据库中的任意明文被接受为 CI/CD 凭据。
 */
export function decryptCicdToken(stored: string | null | undefined): string | null {
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new Error("cicdApiToken 非合法密文(JSON 解析失败)");
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "keyId" in parsed &&
    "ciphertext" in parsed
  ) {
    return decrypt(parsed as EncryptedSecret);
  }
  throw new Error("cicdApiToken 非合法密文(缺少 keyId/ciphertext)");
}
