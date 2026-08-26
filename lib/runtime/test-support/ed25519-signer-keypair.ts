/**
 * 测试辅助：生成 Ed25519 签名密钥对（PKCS8 私钥 base64 + raw 公钥 base64）。
 *
 * 供 active external conformance builder 行为测试使用：
 * 生产 builder 的 signer 输入是 PKCS8 私钥 base64；本辅助同时导出
 * RunnerSigningIdentityRegistry 需要的 raw 32 字节公钥 base64。
 * 仅用于测试，生产代码禁止引用。
 */

import { generateKeyPairSync } from "node:crypto";

export interface Ed25519SignerKeyPair {
  /** PKCS8 DER 私钥的 base64（生产 signer 描述符形态）。 */
  privateKeyPkcs8Base64: string;
  /** raw 32 字节公钥的 base64（注册表形态）。 */
  publicKeyBase64: string;
}

export function generateEd25519SignerKeyPair(): Ed25519SignerKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  const rawPublic = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    privateKeyPkcs8Base64: pkcs8.toString("base64"),
    publicKeyBase64: Buffer.from(rawPublic).toString("base64"),
  };
}

/** 生成一对非 Ed25519（RSA）的 PKCS8 私钥 base64，用于 fail-closed 反例。 */
export function generateRsaPkcs8PrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");
}
