/**
 * §8.2: in-toto DSSE Attestation Verifier — 真实验证流程。
 *
 * 验证步骤：
 * 1. 读取 Bundle 字节                — ✅ 已实现
 * 2. 计算 Bundle Digest              — ✅ 已实现（SHA-256）
 * 3. 解析 DSSE Envelope              — ✅ 已实现（JSON parse）
 * 4. 验证 Envelope 签名              — ⏳ 需要 Sigstore SDK / KMS 公钥
 * 5. 验证 OIDC Issuer                — ✅ 已实现（字符串匹配 Policy）
 * 6. 验证 Signing Identity 满足 Policy — ✅ 已实现（通配匹配）
 * 7. 解析 in-toto Statement           — ✅ 已实现
 * 8. 校验 Statement Type              — ✅ 已实现
 * 9. 校验 Predicate Type              — ✅ 已实现
 * 10. 校验 Subject Digest 与预期一致   — ✅ 已实现
 *
 * 步骤 4 需要 Sigstore SDK 或 KMS 公钥。未安装时 fail-closed。
 */

import { createHash } from "node:crypto";
import type {
  AttestationVerifier,
  VerifyAttestationInput,
  VerifyAttestationResult,
} from "./attestation-verifier";

export interface InTotoDSSEVerifierConfig {
  /** 允许的 OIDC Issuer 列表。 */
  allowedIssuers: string[];
  /** 允许的 Signing Identity 模式（支持 glob * 通配）。 */
  allowedSigningIdentities: string[];
  /** 受管 Store 读取 Bundle 字节的函数。 */
  readBundleBytes: (bundleRef: string) => Promise<Buffer>;
}

/**
 * §8.2: 创建 in-toto DSSE Verifier — 真实验证流程。
 */
export function createInTotoDSSEVerifier(
  config: InTotoDSSEVerifierConfig,
): AttestationVerifier {
  return {
    verify: async (input: VerifyAttestationInput): Promise<VerifyAttestationResult> => {
      const engine = "in-toto-dsse";
      const engineVersion = "2.0.0";

      try {
        // 步骤 1: 读取 Bundle 字节
        const bundleBytes = await config.readBundleBytes(input.bundleRef);

        // 步骤 2: 计算 Bundle Digest
        const bundleDigest = `sha256:${createHash("sha256").update(bundleBytes).digest("hex")}`;

        // 步骤 3: 解析 DSSE Envelope
        let envelope: DSSEEnvelope;
        try {
          envelope = JSON.parse(bundleBytes.toString("utf-8")) as DSSEEnvelope;
        } catch {
          return {
            verified: false,
            attestationFormat: "in_toto_dsse",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            failureReason: "dsse_envelope_json_parse_failed",
          };
        }

        // 步骤 4: 验证签名 — SDK 依赖
        const sigResult = await verifyEnvelopeSignature(envelope, config);
        if (!sigResult.verified) {
          return {
            verified: false,
            attestationFormat: "in_toto_dsse",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            ...sigResult.fields,
            failureReason: sigResult.failureReason,
          };
        }

        // 步骤 5: 验证 OIDC Issuer
        const oidcIssuer = sigResult.fields.oidcIssuer;
        if (oidcIssuer && !config.allowedIssuers.includes(oidcIssuer)) {
          return {
            verified: false,
            attestationFormat: "in_toto_dsse",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            ...sigResult.fields,
            failureReason: `oidc_issuer_not_allowed: ${oidcIssuer}`,
          };
        }

        // 步骤 6: 验证 Signing Identity
        const signingIdentity = sigResult.fields.signingIdentity;
        if (signingIdentity && !matchIdentity(signingIdentity, config.allowedSigningIdentities)) {
          return {
            verified: false,
            attestationFormat: "in_toto_dsse",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            ...sigResult.fields,
            failureReason: `signing_identity_not_allowed: ${signingIdentity}`,
          };
        }

        // 步骤 7: 解析 in-toto Statement（从 payload 解码）
        const statement = decodeStatement(envelope);
        if (!statement) {
          return {
            verified: false,
            attestationFormat: "in_toto_dsse",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            ...sigResult.fields,
            failureReason: "in_toto_statement_decode_failed",
          };
        }

        // 步骤 8: 校验 Statement Type
        if (statement.type !== "https://in-toto.io/Statement/v1") {
          return {
            verified: false,
            attestationFormat: "in_toto_dsse",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            ...sigResult.fields,
            statementType: statement.type,
            failureReason: `statement_type_invalid: ${statement.type}`,
          };
        }

        // 步骤 9: 校验 Predicate Type
        if (input.expectedPredicateType && statement.predicateType !== input.expectedPredicateType) {
          return {
            verified: false,
            attestationFormat: "in_toto_dsse",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            ...sigResult.fields,
            predicateType: statement.predicateType,
            failureReason: `predicate_type_mismatch: expected=${input.expectedPredicateType}, got=${statement.predicateType}`,
          };
        }

        // 步骤 10: 校验 Subject Digest
        const subjectMatch = statement.subject?.some(
          (s: { digest?: Record<string, string> }) =>
            s.digest?.["sha256"] === input.expectedArtifactDigest.replace("sha256:", ""),
        );
        if (!subjectMatch) {
          return {
            verified: false,
            attestationFormat: "in_toto_dsse",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            ...sigResult.fields,
            failureReason: "subject_digest_mismatch",
          };
        }

        // 全部通过
        return {
          verified: true,
          attestationFormat: "in_toto_dsse",
          bundleDigest,
          statementType: statement.type,
          predicateType: statement.predicateType,
          subjectDigest: input.expectedArtifactDigest,
          ...sigResult.fields,
          verificationEngine: engine,
          verificationEngineVersion: engineVersion,
        };
      } catch (error) {
        return {
          verified: false,
          attestationFormat: "in_toto_dsse",
          verificationEngine: engine,
          verificationEngineVersion: engineVersion,
          failureReason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/** DSSE Envelope 结构。 */
interface DSSEEnvelope {
  payload: string;
  payloadType: string;
  signatures: Array<{ keyid: string; sig: string }>;
}

/** in-toto Statement 结构。 */
interface InTotoStatement {
  type: string;
  predicateType: string;
  subject: Array<{ name?: string; digest?: Record<string, string> }>;
  predicate?: unknown;
}

/** 步骤 4: 验证签名 — SDK 依赖，未安装时 fail-closed。 */
async function verifyEnvelopeSignature(
  _envelope: DSSEEnvelope,
  _config: InTotoDSSEVerifierConfig,
): Promise<{
  verified: boolean;
  failureReason?: string;
  fields?: Partial<VerifyAttestationResult>;
}> {
  // §8.2: 真实 SDK 接入点 — 安装 Sigstore SDK 或配置 KMS 公钥后替换
  // 当前 fail-closed: 签名验证不可跳过
  return {
    verified: false,
    failureReason: "sdk_not_installed: envelope_signature_verification_requires_sigstore_sdk_or_kms_public_key",
    fields: {},
  };
}

/** 从 DSSE Envelope 解码 in-toto Statement。 */
function decodeStatement(envelope: DSSEEnvelope): InTotoStatement | null {
  try {
    const payloadJson = Buffer.from(envelope.payload, "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson);
    return {
      type: payload.type,
      predicateType: payload.predicateType,
      subject: payload.subject ?? [],
      predicate: payload.predicate,
    };
  } catch {
    return null;
  }
}

/** Signing Identity 匹配（支持 * 通配符）。 */
function matchIdentity(identity: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (!pattern.includes("*")) return identity === pattern;
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return regex.test(identity);
  });
}
