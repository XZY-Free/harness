/**
 * 可信密钥注册表 — DSSE Ed25519 验签的信任锚。
 *
 * 事实源：https://github.com/secure-systems-lab/dsse/blob/v1.0.0/protocol.md
 *
 * keyid → base64 编码的 32 字节 raw Ed25519 公钥。
 *
 * 与 SigningIdentityPolicy 的区别：
 * - TrustedKeyRegistry 解决"签名是否由可信密钥产生"（密码学校验）
 * - SigningIdentityPolicy 解决"签名者身份是否被授权"（业务校验）
 *
 * keyid 是签名工具分配的稳定标识符（如 "builder:snow-harness-hosted-release"），
 * 与公钥一一对应；同一公钥可有多个 keyid 别名，但同一 keyid 不得对应不同公钥。
 */

/** 可信密钥注册表。 */
export interface TrustedKeyRegistry {
  /** keyid → base64 编码的 Ed25519 公钥（32 字节 raw）。 */
  readonly keys: Record<string, string>;
  /** 查找公钥；不存在返回 undefined。 */
  getPublicKey(keyid: string): string | undefined;
}

/**
 * 创建可信密钥注册表。
 *
 * @param keys keyid → base64 公钥 映射（空对象 → 全部拒绝，fail-closed）
 */
export function createTrustedKeyRegistry(keys: Record<string, string>): TrustedKeyRegistry {
  return {
    keys,
    getPublicKey(keyid: string): string | undefined {
      return keys[keyid];
    },
  };
}
