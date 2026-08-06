/**
 * 签名身份策略 — 控制 DSSE 签名者身份白名单。
 *
 * 与 TrustedKeyRegistry 解耦：
 * - TrustedKeyRegistry 管理 keyid → 公钥（用于 Ed25519 验签）
 * - SigningIdentityPolicy 管理 builderIdentity / runnerIdentity 白名单（用于业务语义校验）
 *
 * 二者协作：先验签（证明 Envelope 未被篡改），再校验签名者身份（证明签名者被授权）。
 */

/** 签名身份策略。 */
export interface SigningIdentityPolicy {
 /** 允许的签名身份列表。 */
 readonly allowedIdentities: readonly string[];
 /** 检查身份是否被允许。 */
 isAllowed(identity: string): boolean;
}

/**
 * 创建签名身份策略。
 *
 * @param allowedIdentities 允许的签名身份列表（空列表 → 全部拒绝，fail-closed）
 */
export function createSigningIdentityPolicy(
 allowedIdentities: readonly string[],
): SigningIdentityPolicy {
 const set = new Set(allowedIdentities);
 return {
 allowedIdentities,
 isAllowed(identity: string): boolean {
 return set.has(identity);
 },
 };
}
