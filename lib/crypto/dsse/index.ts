/**
 * DSSE 共享底座 — Artifact Attestation 与 Runtime Conformance 共用。
 *
 * 事实源：https://github.com/secure-systems-lab/dsse/blob/v1.0.0/protocol.md
 *
 * 模块：
 * - envelope: DSSE Envelope 类型与解析
 * - pae: Pre-Authentication Encoding
 * - verifier: Ed25519 验签
 * - signing-identity: 签名身份白名单策略
 * - trusted-key-registry: keyid → 公钥 信任锚
 * - in-toto: in-toto Statement v1 解析与校验
 *
 * 任何路径不得绕过本模块自造 DSSE/PAE/Ed25519/in-toto 实现。
 */
export * from "./envelope";
export * from "./pae";
export * from "./verifier";
export * from "./signing-identity";
export * from "./trusted-key-registry";
export * from "./in-toto";
