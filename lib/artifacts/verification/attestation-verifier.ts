/**
 * AttestationVerifier 接口 — 标准制品验证抽象。
 *
 * Application Service 只依赖此接口，不直接 Import 官方SDK。
 * 官方SDK只存在于 Infrastructure Adapter（具体 Verifier 实现）。
 *
 * 验证流程（§二十四）:
 * 1. 从受管 Store 读取原始 Bundle 字节
 * 2. 计算 Bundle Digest
 * 3. 使用官方 Sigstore/DSSE 实现解析
 * 4. 验证 Envelope 签名
 * 5. 验证证书链或受管公钥
 * 6. 验证 OIDC Issuer
 * 7. 验证 Signing Identity 满足 Policy
 * 8. 验证透明日志证明（Sigstore 模式）
 * 9. 解析 in-toto Statement
 * 10. 校验 Statement Type
 * 11. 校验 Predicate Type
 * 12. 校验 Subject Digest 与 Artifact Digest 完全一致
 * 13. 根据 Predicate 类型执行特定检查
 *
 * 不得将未验证的原始 Bundle 内容直接放入 Audit。
 */

/** Attestation 验证输入 — 调用方只提交引用，不提交验证结果。 */
export interface VerifyAttestationInput {
  /** Attestation 记录 ID。 */
  attestationId: string;
  /** 受管 Store 中的 Bundle 引用。 */
  bundleRef: string;
  /** 预期 Artifact ID。 */
  expectedArtifactId: string;
  /** 预期 Artifact Digest。 */
  expectedArtifactDigest: string;
  /** 预期 Predicate Type。 */
  expectedPredicateType: string;
  /** 租户 ID。 */
  tenantId: string;
}

/** Attestation 验证结果。 */
export interface VerifyAttestationResult {
  /** 验证是否通过。 */
  verified: boolean;
  /** Attestation 格式。 */
  attestationFormat: "legacy_custom" | "in_toto_dsse" | "sigstore_bundle";
  /** Statement Type（in-toto）。 */
  statementType?: string;
  /** Predicate Type（in-toto）。 */
  predicateType?: string;
  /** Bundle Digest。 */
  bundleDigest?: string;
  /** Subject Name。 */
  subjectName?: string;
  /** Subject Digest。 */
  subjectDigest?: string;
  /** 签名身份。 */
  signingIdentity?: string;
  /** OIDC Issuer。 */
  oidcIssuer?: string;
  /** 证书指纹。 */
  certificateFingerprint?: string;
  /** 透明日志 ID。 */
  transparencyLogId?: string;
  /** 透明日志索引。 */
  transparencyLogIndex?: number;
  /** 验证引擎。 */
  verificationEngine: string;
  /** 验证引擎版本。 */
  verificationEngineVersion: string;
  /** 失败原因。 */
  failureReason?: string;
}

/** Attestation 验证器接口。 */
export interface AttestationVerifier {
  /** 验证 Attestation Bundle。 */
  verify(input: VerifyAttestationInput): Promise<VerifyAttestationResult>;
}

/** Attestation 验证错误。 */
export class AttestationVerificationError extends Error {
  constructor(message: string) {
    super(`Attestation 验证失败：${message}`);
    this.name = "AttestationVerificationError";
  }
}

/** Attestation 验证器不可用 — SDK 未实现。生产环境必须 Fail-closed。 */
export class AttestationVerifierUnavailableError extends Error {
  constructor(public readonly verifierName: string) {
    super(`Attestation 验证器不可用：${verifierName} 未实现，生产环境必须 Fail-closed`);
    this.name = "AttestationVerifierUnavailableError";
  }
}
