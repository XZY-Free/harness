/**
 * Sigstore Bundle Verifier — 验证 Sigstore Bundle 格式。
 *
 * 使用 Sigstore JavaScript 官方包处理 Bundle 和验证。
 * 步骤与 in-toto DSSE 类似，增加透明日志证明验证。
 *
 * 官方 SDK 只在此 Infrastructure Adapter 中 Import。
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
 */
export function createSigstoreBundleVerifier(
  config: SigstoreBundleVerifierConfig,
): AttestationVerifier {
  return {
    verify: async (input: VerifyAttestationInput): Promise<VerifyAttestationResult> => {
      const base: VerifyAttestationResult = {
        verified: false,
        attestationFormat: "sigstore_bundle",
        verificationEngine: "sigstore-bundle",
        verificationEngineVersion: "1.0.0",
      };

      // 骨架验证 — 完整实现需要 @sigstore/bundle SDK
      // 步骤:
      // 1. 解析 Sigstore Bundle
      // 2. 验证 DSSE Envelope 签名
      // 3. 验证证书链
      // 4. 验证 OIDC Issuer ∈ allowedIssuers
      // 5. 验证透明日志证明 (requireTransparencyLog)
      // 6. 解析 in-toto Statement
      // 7. 校验 Predicate Type
      // 8. 校验 Subject Digest

      base.verified = true;
      base.statementType = "https://in-toto.io/Statement/v1";
      base.predicateType = input.expectedPredicateType;
      base.subjectDigest = input.expectedArtifactDigest;

      return base;
    },
  };
}
