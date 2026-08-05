/**
 * §8.2: Sigstore Bundle Verifier — 真实验证流程。
 *
 * 验证步骤（§8.2 完整流程）：
 * 1. 从受管 Store 读取 Bundle      — ✅ 已实现（读 JSON）
 * 2. 计算 Bundle Digest            — ✅ 已实现（SHA-256）
 * 3. 解析 Envelope                 — ✅ 已实现（JSON parse）
 * 4. 验证签名                      — ⏳ 需要 @sigstore/verify SDK
 * 5. 验证证书链或 KMS 公钥         — ⏳ 需要 @sigstore/verify SDK
 * 6. 验证 OIDC Issuer              — ✅ 已实现（字符串匹配 Policy）
 * 7. 验证 Signing Identity          — ✅ 已实现（字符串匹配 Policy）
 * 8. 验证透明日志                  — ⏳ 需要 @sigstore/verify SDK
 * 9. 解析 in-toto Statement        — ✅ 已实现（JSON parse + 校验）
 * 10. 校验 Predicate               — ✅ 已实现（类型匹配）
 * 11. 校验 Subject Artifact Digest — ✅ 已实现（Digest 比较）
 * 12. 验证 SBOM                    — ⏳ 可选，待 Schema 验证实现
 * 13. 应用 Verification Policy     — ✅ 已实现（Issuer + Identity 规则）
 * 14. 持久化结果                   — 调用方负责
 *
 * SDK 依赖：步骤 4/5/8 需要 @sigstore/verify 包。
 * 安装后替换 `verifySignatureWithSDK` 和 `verifyTransparencyLogWithSDK` 实现。
 */

import { createHash } from "node:crypto";
import type {
  AttestationVerifier,
  VerifyAttestationInput,
  VerifyAttestationResult,
} from "./attestation-verifier";

export interface SigstoreBundleVerifierConfig {
  /** 允许的 OIDC Issuer 列表。 */
  allowedIssuers: string[];
  /** 允许的 Signing Identity 模式（支持 glob * 通配）。 */
  allowedSigningIdentities: string[];
  /** 是否要求透明日志证明。 */
  requireTransparencyLog: boolean;
  /** 受管 Store 读取 Bundle 字节的函数。 */
  readBundleBytes: (bundleRef: string) => Promise<Buffer>;
}

/**
 * §8.2: 创建 Sigstore Bundle Verifier — 真实验证流程。
 *
 * 步骤 4/5/8 需要 @sigstore/verify SDK；未安装时 fail-closed。
 */
export function createSigstoreBundleVerifier(
  config: SigstoreBundleVerifierConfig,
): AttestationVerifier {
  return {
    verify: async (input: VerifyAttestationInput): Promise<VerifyAttestationResult> => {
      const engine = "sigstore-bundle";
      const engineVersion = "2.0.0";

      try {
        // 步骤 1: 读取 Bundle 字节
        const bundleBytes = await config.readBundleBytes(input.bundleRef);

        // 步骤 2: 计算 Bundle Digest
        const bundleDigest = `sha256:${createHash("sha256").update(bundleBytes).digest("hex")}`;

        // 步骤 3: 解析 Envelope
        let bundle: unknown;
        try {
          bundle = JSON.parse(bundleBytes.toString("utf-8"));
        } catch {
          return {
            verified: false,
            attestationFormat: "sigstore_bundle",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            failureReason: "bundle_json_parse_failed",
          };
        }

        // 步骤 4/5/8: SDK 依赖验证 — 需要 @sigstore/verify
        const sdkResult = await verifySignatureWithSDK(bundle, config);
        if (!sdkResult.verified) {
          return {
            verified: false,
            attestationFormat: "sigstore_bundle",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            ...sdkResult.fields,
            failureReason: sdkResult.failureReason,
          };
        }

        // 步骤 6: 验证 OIDC Issuer
        const oidcIssuer = sdkResult.fields?.oidcIssuer;
        if (oidcIssuer && !config.allowedIssuers.includes(oidcIssuer)) {
          return {
            verified: false,
            attestationFormat: "sigstore_bundle",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            ...sdkResult.fields,
            failureReason: `oidc_issuer_not_allowed: ${oidcIssuer}`,
          };
        }

        // 步骤 7: 验证 Signing Identity
        const signingIdentity = sdkResult.fields?.signingIdentity;
        if (signingIdentity && !matchIdentity(signingIdentity, config.allowedSigningIdentities)) {
          return {
            verified: false,
            attestationFormat: "sigstore_bundle",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            ...sdkResult.fields,
            failureReason: `signing_identity_not_allowed: ${signingIdentity}`,
          };
        }

        // 步骤 9: 解析 in-toto Statement
        const statement = extractStatement(bundle);
        if (!statement) {
          return {
            verified: false,
            attestationFormat: "sigstore_bundle",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            ...sdkResult.fields,
            failureReason: "in_toto_statement_parse_failed",
          };
        }

        // 步骤 10: 校验 Predicate Type
        if (input.expectedPredicateType && statement.predicateType !== input.expectedPredicateType) {
          return {
            verified: false,
            attestationFormat: "sigstore_bundle",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            ...sdkResult.fields,
            predicateType: statement.predicateType,
            failureReason: `predicate_type_mismatch: expected=${input.expectedPredicateType}, got=${statement.predicateType}`,
          };
        }

        // 步骤 11: 校验 Subject Artifact Digest
        const subjectMatch = statement.subjects?.some(
          (s: { digest?: Record<string, string> }) =>
            s.digest?.["sha256"] === input.expectedArtifactDigest.replace("sha256:", ""),
        );
        if (!subjectMatch) {
          return {
            verified: false,
            attestationFormat: "sigstore_bundle",
            bundleDigest,
            verificationEngine: engine,
            verificationEngineVersion: engineVersion,
            ...sdkResult.fields,
            failureReason: "subject_digest_mismatch",
          };
        }

        // 全部通过
        return {
          verified: true,
          attestationFormat: "sigstore_bundle",
          bundleDigest,
          statementType: statement.type,
          predicateType: statement.predicateType,
          subjectDigest: input.expectedArtifactDigest,
          ...sdkResult.fields,
          verificationEngine: engine,
          verificationEngineVersion: engineVersion,
        };
      } catch (error) {
        return {
          verified: false,
          attestationFormat: "sigstore_bundle",
          verificationEngine: engine,
          verificationEngineVersion: engineVersion,
          failureReason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/** 步骤 4/5/8: SDK 验证 — 未安装时 fail-closed。 */
async function verifySignatureWithSDK(
  _bundle: unknown,
  config: SigstoreBundleVerifierConfig,
): Promise<{
  verified: boolean;
  failureReason?: string;
  fields?: Partial<VerifyAttestationResult>;
}> {
  // §8.2: 真实 SDK 接入点 — 安装 @sigstore/verify 后替换此实现
  // 当前 fail-closed: 签名验证不可跳过
  //
  // 真实实现：
  //   import { verifyBundle } from "@sigstore/verify";
  //   const result = await verifyBundle(bundle);
  //   return { verified: true, fields: { ... } };
  //
  // 若 requireTransparencyLog=true，还需验证 Rekor entry

  if (config.requireTransparencyLog) {
    return {
      verified: false,
      failureReason: "sdk_not_installed: signature_and_transparency_log_verification_requires_@sigstore/verify",
      fields: {},
    };
  }

  return {
    verified: false,
    failureReason: "sdk_not_installed: signature_verification_requires_@sigstore/verify",
    fields: {},
  };
}

/** 从 Sigstore Bundle 提取 in-toto Statement。 */
function extractStatement(bundle: unknown): {
  type: string;
  predicateType: string;
  subjects: Array<{ digest?: Record<string, string> }>;
} | null {
  if (!bundle || typeof bundle !== "object") return null;
  const b = bundle as Record<string, unknown>;

  // Sigstore Bundle v0.3: dsseEnvelope.payload
  const envelope = b.dsseEnvelope as Record<string, unknown> | undefined;
  if (!envelope) return null;

  const payloadB64 = envelope.payload as string | undefined;
  if (!payloadB64) return null;

  try {
    const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson);
    return {
      type: payload.type,
      predicateType: payload.predicateType,
      subjects: payload.subject ?? [],
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
