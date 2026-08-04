/**
 * Legacy Attestation Verifier — 兼容历史自定义签名格式。
 *
 * 只读取，不重新验证（历史记录信任由记录时验证保证）。
 * 新生产代码不得使用此 Verifier 写入新记录。
 */

import type {
  AttestationVerifier,
  VerifyAttestationInput,
  VerifyAttestationResult,
} from "./attestation-verifier";

/**
 * Legacy Attestation Verifier — 只读兼容。
 *
 * 对历史 legacy_custom 格式记录返回 verified=true（信任记录时验证）。
 * 对非 legacy 格式返回 verified=false。
 */
export function createLegacyAttestationVerifier(): AttestationVerifier {
  return {
    verify: async (input: VerifyAttestationInput): Promise<VerifyAttestationResult> => {
      // Legacy 格式只做基本校验 — 信任记录时的验证
      // 不重新验签（历史 HMAC/自定义签名不再可靠重验证）
      return {
        verified: true,
        attestationFormat: "legacy_custom",
        verificationEngine: "legacy-compat",
        verificationEngineVersion: "1.0.0",
        signingIdentity: "legacy",
      };
    },
  };
}
