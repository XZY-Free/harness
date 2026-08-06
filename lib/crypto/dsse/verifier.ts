/**
 * DSSE Ed25519 共享验签。
 *
 * 事实源：https://github.com/secure-systems-lab/dsse/blob/v1.0.0/protocol.md
 *
 * 本模块是 Artifact Attestation 与 Runtime Conformance 共用的 DSSE 验签底座：
 * - verifyEd25519Signature: 单条签名的 Ed25519 验签
 * - verifyDSSEEnvelopeSignatures: 遍历 Envelope.signatures，找到首个可信签名
 *
 * 公钥格式：base64 编码的 32 字节 raw Ed25519 公钥。
 * 签名格式：base64 编码的 64 字节 Ed25519 签名。
 * 验签输入：DSSE PAE 字节（由 pae.computeDssePae 构造）。
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { DSSEEnvelope } from "./envelope";
import { computeDssePae } from "./pae";

/**
 * 使用 Ed25519 验证 DSSE 签名。
 *
 * @param publicKeyBase64 base64 编码的 32 字节 raw Ed25519 公钥
 * @param data 待验证的 PAE 字节
 * @param signatureBase64 base64 编码的 64 字节签名
 * @returns 验签是否通过
 */
export function verifyEd25519Signature(
  publicKeyBase64: string,
  data: Buffer,
  signatureBase64: string,
): boolean {
  const publicKeyBytes = Buffer.from(publicKeyBase64, "base64");
  if (publicKeyBytes.length !== 32) return false;
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: publicKeyBytes.toString("base64url"),
      },
      format: "jwk",
    });
  } catch {
    return false;
  }
  const signature = Buffer.from(signatureBase64, "base64");
  return cryptoVerify(null, data, publicKey, signature);
}

/** DSSE Envelope 验签结果。 */
export interface DSSEVerificationResult {
  /** 是否验签通过。 */
  verified: boolean;
  /** 通过验签的 keyid（verified=true 时非空）。 */
  verifiedKeyId: string | null;
  /** 失败原因（verified=false 时非空）。 */
  failureReason?: string;
}

/**
 * 验证整个 DSSE Envelope 的签名。
 *
 * 遍历 envelope.signatures，找到首个 keyid 在 trustedKeys 中且验签通过的签名。
 * 全部 keyid 未知 → failureReason = "unknown_keyid"。
 * 存在已知 keyid 但验签失败 → failureReason = "signature_invalid"。
 *
 * @param envelope DSSE Envelope（已解析）
 * @param payloadBytes base64 解码后的 payload 字节
 * @param trustedKeys keyid → base64 公钥 的可信密钥注册表
 */
export function verifyDSSEEnvelopeSignatures(
  envelope: DSSEEnvelope,
  payloadBytes: Buffer,
  trustedKeys: Record<string, string>,
): DSSEVerificationResult {
  const pae = computeDssePae(envelope.payloadType, payloadBytes);

  let verifiedKeyId: string | null = null;
  let anyKnownKeyid = false;
  for (const sig of envelope.signatures) {
    const publicKeyBase64 = trustedKeys[sig.keyid];
    if (!publicKeyBase64) {
      continue; // unknown_keyid — 尝试下一个签名
    }
    anyKnownKeyid = true;
    if (verifyEd25519Signature(publicKeyBase64, pae, sig.sig)) {
      verifiedKeyId = sig.keyid;
      break;
    }
  }
  if (verifiedKeyId !== null) {
    return { verified: true, verifiedKeyId };
  }
  return {
    verified: false,
    verifiedKeyId: null,
    failureReason: anyKnownKeyid ? "signature_invalid" : "unknown_keyid",
  };
}
