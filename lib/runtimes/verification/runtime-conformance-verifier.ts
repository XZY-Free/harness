/**
 * Runtime Conformance 验证器接口和实现。
 *
 * §8.4/§4.8: Conformance 录入改用 Verifier Port。
 * 移除 Legacy HMAC 成功分支 — DSSE 是唯一的验签路径。
 *
 * DSSE Conformance Verifier — 真实验证流程：
 * 1. 解析 DSSE Envelope JSON
 * 2. 校验 payloadType / payload / signatures 字段
 * 3. Base64 解码 Payload
 * 4. 构造 DSSE PAE（Pre-Authentication Encoding）
 * 5. Ed25519 验签（使用 trustedRunnerKeys）
 * 6. 解析 in-toto Statement
 * 7. 校验 Predicate Type / Subject Digest / Report 绑定
 * 8. 校验 Case 结果完整
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  ALL_CONFORMANCE_CASES,
  CONFORMANCE_SUITE_REVISION,
} from "@/lib/runtimes/domain/runtime-conformance-contract";
import type { RuntimeConformanceReport } from "@/lib/runtimes/domain/runtime-conformance-run";

// ─── 标准 Predicate Type ──────────────────────────────────

/**
 * Runtime Conformance 标准 Predicate Type。
 *
 * 必须是项目长期拥有并可维护的稳定 HTTPS URI。
 * 不得使用临时 Git 分支、localhost 或方案版本路径。
 */
export const RUNTIME_CONFORMANCE_PREDICATE_TYPE =
  "https://snowharness.dev/attestation/runtime-conformance/v1";

// ─── 验证器接口 ──────────────────────────────────────────

export interface VerifyConformanceInput {
  /** 原始 DSSE Envelope 字节。 */
  dsseEnvelopeBytes: Buffer;
  /** 预期 RuntimeRevision ID（绑定校验，必填）。 */
  expectedRuntimeRevisionId: string;
  /** 预期 Runtime Artifact Digest（可选，由调用方做绑定校验时传入）。 */
  expectedRuntimeArtifactDigest?: string;
  /** 预期 Runtime Config Digest（可选，由调用方做绑定校验时传入）。 */
  expectedRuntimeConfigDigest?: string;
  /** 预期 Protocol Contract Revision（可选，由调用方做绑定校验时传入）。 */
  expectedProtocolContractRevision?: string;
  /** 租户 ID。 */
  tenantId: string;
}

export interface VerifiedRuntimeConformanceClaims {
  verified: true;
  /** Envelope 的 sha256 digest (sha256:hex 格式)。 */
  envelopeDigest: string;
  /** Payload 的 sha256 digest (sha256:hex 格式)。 */
  payloadDigest: string;
  /** 签名 keyid。 */
  signingKeyId: string;
  /** Runner 身份。 */
  runnerIdentity: string;
  /** Predicate Type URI。 */
  predicateType: string;
  /** 验证引擎名称。 */
  verificationEngine: string;
  /** 验证引擎版本。 */
  verificationEngineVersion: string;
  /** 从已验签 Payload 中解析出的 Report。 */
  report: RuntimeConformanceReport;
}

export type VerifyConformanceResult =
  | { verified: true; claims: VerifiedRuntimeConformanceClaims }
  | { verified: false; failureReason: string; predicateType?: string };

export interface RuntimeConformanceVerifier {
  verify(input: VerifyConformanceInput): Promise<VerifyConformanceResult>;
}

// ─── DSSE Conformance Verifier ───────────────────────────

export interface DSSEConformanceVerifierConfig {
  /** 允许的 Runner Identity 列表。 */
  allowedRunnerIdentities: string[];
  /** keyid → base64 编码的 Ed25519 公钥（32 字节 raw）。 */
  trustedRunnerKeys: Record<string, string>;
}

const VERIFICATION_ENGINE = "dsse-ed25519";
const VERIFICATION_ENGINE_VERSION = "1";

/**
 * §8.4: 创建 DSSE Conformance Verifier — 真实验证流程。
 *
 * 严格按 DSSE + in-toto v1 + Ed25519 规范验签。
 * 任何一步失败均 fail-closed，返回 verified=false。
 */
export function createDSSEConformanceVerifier(
  config: DSSEConformanceVerifierConfig,
): RuntimeConformanceVerifier {
  return {
    verify: async (input: VerifyConformanceInput): Promise<VerifyConformanceResult> => {
      // 步骤 1: 解析 Envelope JSON
      let envelope: unknown;
      try {
        envelope = JSON.parse(input.dsseEnvelopeBytes.toString("utf-8"));
      } catch {
        return fail("dsse_envelope_json_parse_failed");
      }
      if (!envelope || typeof envelope !== "object") {
        return fail("dsse_envelope_json_parse_failed");
      }
      const env = envelope as Record<string, unknown>;

      // 步骤 2: 校验 payloadType 字段存在且为字符串
      if (typeof env.payloadType !== "string") {
        return fail("dsse_payload_type_missing");
      }
      const payloadType = env.payloadType;

      // 步骤 3: 校验 payload 字段存在且为字符串
      if (typeof env.payload !== "string") {
        return fail("dsse_payload_missing");
      }

      // 步骤 4: 校验 signatures 数组存在且非空
      if (!Array.isArray(env.signatures) || env.signatures.length === 0) {
        return fail("dsse_signatures_missing");
      }
      const signatures = env.signatures as Array<Record<string, unknown>>;

      // 步骤 5: Base64 解码 Payload 字节
      let payloadBytes: Buffer;
      try {
        payloadBytes = Buffer.from(env.payload, "base64");
      } catch {
        return fail("dsse_payload_base64_decode_failed");
      }

      // 步骤 6: 构造 DSSE PAE
      const pae = computeDssePae(payloadType, payloadBytes);

      // 步骤 7-8: Ed25519 验签
      let verifiedKeyId: string | null = null;
      for (const sig of signatures) {
        const keyid = typeof sig.keyid === "string" ? sig.keyid : "";
        const sigStr = typeof sig.sig === "string" ? sig.sig : "";
        if (!keyid || !sigStr) continue;

        const publicKeyBase64 = config.trustedRunnerKeys[keyid];
        if (!publicKeyBase64) {
          continue; // unknown_keyid — 尝试下一个签名
        }
        if (!verifyEd25519(publicKeyBase64, pae, sigStr)) {
          continue; // signature_invalid — 尝试下一个签名
        }
        verifiedKeyId = keyid;
        break;
      }
      if (verifiedKeyId === null) {
        // 判断具体失败原因
        const allUnknown = signatures.every((sig) => {
          const keyid = typeof sig.keyid === "string" ? sig.keyid : "";
          return !config.trustedRunnerKeys[keyid];
        });
        return fail(allUnknown ? "unknown_keyid" : "signature_invalid");
      }

      // 步骤 9: 解析 in-toto Statement
      let statement: Record<string, unknown>;
      try {
        statement = JSON.parse(payloadBytes.toString("utf-8")) as Record<string, unknown>;
      } catch {
        return fail("in_toto_statement_parse_failed");
      }

      // 步骤 9b: 校验 _type
      if (statement._type !== "https://in-toto.io/Statement/v1") {
        return fail("in_toto_statement_type_invalid");
      }

      // 步骤 10: 校验 predicateType
      const stmtPredicateType = statement.predicateType;
      if (stmtPredicateType !== RUNTIME_CONFORMANCE_PREDICATE_TYPE) {
        return fail(
          "predicate_type_mismatch",
          typeof stmtPredicateType === "string" ? stmtPredicateType : undefined,
        );
      }

      // 步骤 11: 校验 subject 数组存在且非空
      if (!Array.isArray(statement.subject) || statement.subject.length === 0) {
        return fail("subject_missing");
      }

      // 步骤 12: 从 predicate 中解析 RuntimeConformanceReport
      const predicate = statement.predicate as Record<string, unknown> | undefined;
      if (!predicate || typeof predicate !== "object") {
        return fail("predicate_missing");
      }
      const report = predicate as unknown as RuntimeConformanceReport;

      // 步骤 13: 校验 Subject Artifact Digest 与 Report 自洽
      const subject0 = statement.subject[0] as Record<string, unknown> | undefined;
      const subjectDigest = (subject0?.digest as Record<string, unknown> | undefined)?.sha256;
      const reportArtifactDigestRaw = report.runtimeArtifactDigest.replace("sha256:", "");
      if (typeof subjectDigest !== "string" || subjectDigest !== reportArtifactDigestRaw) {
        return fail("subject_digest_mismatch");
      }

      // 步骤 14: 校验 runtimeRevisionId（绑定校验，必填）
      if (report.runtimeRevisionId !== input.expectedRuntimeRevisionId) {
        return fail("runtime_revision_mismatch");
      }

      // 步骤 15: 校验 runtimeArtifactDigest（可选绑定校验）
      if (
        input.expectedRuntimeArtifactDigest &&
        report.runtimeArtifactDigest !== input.expectedRuntimeArtifactDigest
      ) {
        return fail("artifact_digest_mismatch");
      }

      // 步骤 16: 校验 runtimeConfigDigest（可选绑定校验）
      if (
        input.expectedRuntimeConfigDigest &&
        report.runtimeConfigDigest !== input.expectedRuntimeConfigDigest
      ) {
        return fail("config_digest_mismatch");
      }

      // 步骤 17: 校验 protocolContractRevision（可选绑定校验）
      if (
        input.expectedProtocolContractRevision &&
        report.protocolContractRevision !== input.expectedProtocolContractRevision
      ) {
        return fail("protocol_revision_mismatch");
      }

      // 步骤 18: 校验 suiteRevision
      if (report.suiteRevision !== CONFORMANCE_SUITE_REVISION) {
        return fail("suite_revision_mismatch");
      }

      // 步骤 19: 校验 Runner Identity ∈ allowedRunnerIdentities
      if (!config.allowedRunnerIdentities.includes(report.runnerIdentity)) {
        return fail("runner_identity_not_allowed");
      }

      // 步骤 20: 校验 Case 集合完整（使用 ALL_CONFORMANCE_CASES）
      if (!Array.isArray(report.caseResults)) {
        return fail("case_results_incomplete");
      }
      const caseIds = report.caseResults.map((r) => r.caseId);
      const allPresent = ALL_CONFORMANCE_CASES.every((id) => caseIds.includes(id));
      if (!allPresent) {
        return fail("case_results_incomplete");
      }

      // 步骤 21: 校验 Case ID 唯一（在长度校验之前，确保重复 case 被正确识别）
      if (new Set(caseIds).size !== caseIds.length) {
        return fail("case_results_not_unique");
      }

      // 步骤 21b: 校验 Case 数量精确匹配（无多余 case）
      if (caseIds.length !== ALL_CONFORMANCE_CASES.length) {
        return fail("case_results_incomplete");
      }

      // 步骤 22: 计算 Overall Result 与 Case 结果一致
      const allPassed = report.caseResults.every((r) => r.passed);
      if ((report.overallResult === "passed") !== allPassed) {
        return fail("overall_result_inconsistent");
      }

      // 步骤 23: 计算 envelopeDigest
      const envelopeDigest = `sha256:${createHash("sha256").update(input.dsseEnvelopeBytes).digest("hex")}`;

      // 步骤 24: 计算 payloadDigest
      const payloadDigest = `sha256:${createHash("sha256").update(payloadBytes).digest("hex")}`;

      // 步骤 25: 返回 VerifiedRuntimeConformanceClaims
      return {
        verified: true,
        claims: {
          verified: true,
          envelopeDigest,
          payloadDigest,
          signingKeyId: verifiedKeyId,
          runnerIdentity: report.runnerIdentity,
          predicateType: RUNTIME_CONFORMANCE_PREDICATE_TYPE,
          verificationEngine: VERIFICATION_ENGINE,
          verificationEngineVersion: VERIFICATION_ENGINE_VERSION,
          report,
        },
      };
    },
  };
}

function fail(reason: string, predicateType?: string): VerifyConformanceResult {
  return { verified: false, failureReason: reason, predicateType };
}

// ─── DSSE PAE ────────────────────────────────────────────

/**
 * 构造 DSSE Pre-Authentication Encoding。
 *
 * PAE = "DSSEv1" + SP + str(len(payloadType)) + SP + payloadType + SP + str(len(payloadBytes)) + SP + payloadBytes
 */
function computeDssePae(payloadType: string, payload: Buffer): Buffer {
  const prefix = Buffer.from(`DSSEv1 ${payloadType.length} ${payloadType} ${payload.length} `);
  return Buffer.concat([prefix, payload]);
}

// ─── Ed25519 验签 ────────────────────────────────────────

/**
 * 使用 Ed25519 验证 DSSE 签名。
 *
 * publicKeyBase64: base64 编码的 32 字节 raw Ed25519 公钥。
 * data: 待验证的 PAE 字节。
 * signatureBase64: base64 编码的 64 字节签名。
 */
function verifyEd25519(publicKeyBase64: string, data: Buffer, signatureBase64: string): boolean {
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
