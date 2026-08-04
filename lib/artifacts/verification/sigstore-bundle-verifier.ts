/**
 * Sigstore Bundle Verifier — 验证 Sigstore Bundle 格式。
 *
 * 使用 Sigstore JavaScript 官方包处理 Bundle 和验证。
 * 步骤与 in-toto DSSE 类似，增加透明日志证明验证。
 *
 * 官方 SDK 只在此 Infrastructure Adapter 中 Import。
 *
 * ⚠️ 当前为 Fail-closed 骨架：真实 SDK 接入前统一返回 verified=false。
 * 生产环境启动时，如果配置选择此 Verifier，直接启动失败。
 */

import type {
  AttestationVerifier,
  VerifyAttestationInput,
  VerifyAttestationResult,
} from "./attestation-verifier";

export interface SigstoreBundleVerifierConfig {
  /** 允许的 OIDC Issuer 列表。 */
  allowedIssuers: string[];
  /** 是否要求透明日志证明。 */
  requireTransparencyLog: boolean;
}

/**
 * 创建 Sigstore Bundle Verifier。
 *
 * Fail-closed：在真实 @sigstore/bundle SDK 接入前，所有验证返回
 * verified=false + failureReason=verifier_not_implemented。
 */
export function createSigstoreBundleVerifier(
  config: SigstoreBundleVerifierConfig,
): AttestationVerifier {
  return {
    verify: async (_input: VerifyAttestationInput): Promise<VerifyAttestationResult> => {
      // Fail-closed 骨架 — 完整实现需要 @sigstore/bundle SDK
      // 步骤:
      // 1. 解析 Sigstore Bundle
      // 2. 验证 DSSE Envelope 签名
      // 3. 验证证书链
      // 4. 验证 OIDC Issuer ∈ allowedIssuers
      // 5. 验证透明日志证明 (requireTransparencyLog)
      // 6. 解析 in-toto Statement
      // 7. 校验 Predicate Type
      // 8. 校验 Subject Digest

      return {
        verified: false,
        attestationFormat: "sigstore_bundle",
        verificationEngine: "sigstore-bundle",
        verificationEngineVersion: "1.0.0",
        failureReason: "verifier_not_implemented",
      };
    },
  };
}
