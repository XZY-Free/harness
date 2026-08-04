/**
 * in-toto DSSE Attestation Verifier — 验证 in-toto Statement v1 + DSSE Envelope。
 *
 * 验证步骤：
 * 1. 读取 Bundle 字节
 * 2. 计算 Bundle Digest
 * 3. 解析 DSSE Envelope
 * 4. 验证 Envelope 签名（KMS/受管公钥）
 * 5. 验证 OIDC Issuer
 * 6. 验证 Signing Identity 满足 Policy
 * 7. 解析 in-toto Statement
 * 8. 校验 Statement Type
 * 9. 校验 Predicate Type
 * 10. 校验 Subject Digest 与预期完全一致
 *
 * 官方 Sigstore SDK 在 Infrastructure Adapter 层，此模块定义验证逻辑骨架。
 *
 * ⚠️ 当前为 Fail-closed 骨架：真实 SDK 接入前统一返回 verified=false。
 * 生产环境启动时，如果配置选择此 Verifier，直接启动失败。
 */

import type {
  AttestationVerifier,
  VerifyAttestationInput,
  VerifyAttestationResult,
} from "./attestation-verifier";

export interface InTotoDSSEVerifierConfig {
  /** 允许的 OIDC Issuer 列表。 */
  allowedIssuers: string[];
  /** 允许的 Signing Identity 模式。 */
  allowedSigningIdentities: string[];
}

/**
 * 创建 in-toto DSSE Attestation Verifier。
 *
 * Fail-closed：在真实 Sigstore SDK 接入前，所有验证返回
 * verified=false + failureReason=verifier_not_implemented。
 */
export function createInTotoDSSEVerifier(
  _config: InTotoDSSEVerifierConfig,
): AttestationVerifier {
  return {
    verify: async (_input: VerifyAttestationInput): Promise<VerifyAttestationResult> => {
      // Fail-closed 骨架 — 完整实现需要 Sigstore SDK
      // 步骤 1-6: 由 Infrastructure Adapter 完成
      // 步骤 7-10: 结构和 Policy 校验

      return {
        verified: false,
        attestationFormat: "in_toto_dsse",
        verificationEngine: "in-toto-dsse",
        verificationEngineVersion: "1.0.0",
        failureReason: "verifier_not_implemented",
      };
    },
  };
}
