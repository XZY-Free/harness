/**
 * Runtime Conformance 验证器接口和实现。
 *
 * Conformance 录入通过 Verifier Port 完成，DSSE 是唯一的验签路径。
 *
 * DSSE Conformance Verifier — 真实验证流程：
 * 1. 解析 DSSE Envelope JSON（共享底座 lib/crypto/dsse）
 * 2. Base64 解码 Payload
 * 3. 构造 DSSE PAE 并 Ed25519 验签（使用共享底座 + Runner 签名身份注册表）
 * 4. 解析 in-toto Statement
 * 5. 校验 Predicate Type / Subject Digest / Report 绑定
 * 6. 校验 Case 结果完整
 *
 * 共享底座（PAE / Ed25519 / Envelope 解析）位于 lib/crypto/dsse，
 * 与 Artifact Attestation 共用，本模块仅保留 Conformance 特有的语义校验。
 */

import {
 computeEnvelopeDigest,
 computePayloadDigest,
 parseDSSEEnvelope,
 verifyDSSEEnvelopeSignatures,
 parseIntotoStatement,
 validatePayloadType,
 validateStatementSubject,
} from "@/lib/crypto/dsse";
import {
 ALL_CONFORMANCE_CASES,
 CONFORMANCE_SUITE_REVISION,
} from "@/lib/runtime/domain/runtime-conformance-contract";
import type { RuntimeConformanceReport } from "@/lib/runtime/domain/runtime-conformance-run";
import type { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";

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
 /** Runner 签名身份注册表（keyId ↔ runnerIdentity 一一绑定）。 */
 runnerIdentityRegistry: RunnerSigningIdentityRegistry;
}

const VERIFICATION_ENGINE = "dsse-ed25519";
const VERIFICATION_ENGINE_VERSION = "1";

/**
 * : 创建 DSSE Conformance Verifier — 真实验证流程。
 *
 * 严格按 DSSE + in-toto v1 + Ed25519 规范验签。
 * 任何一步失败均 fail-closed，返回 verified=false。
 */
export function createDSSEConformanceVerifier(
 config: DSSEConformanceVerifierConfig,
): RuntimeConformanceVerifier {
 return {
 verify: async (input: VerifyConformanceInput): Promise<VerifyConformanceResult> => {
 // 步骤 1: 解析 Envelope JSON（共享底座）
 const parsed = parseDSSEEnvelope(input.dsseEnvelopeBytes);
 if (!parsed.ok) {
 return fail(parsed.reason);
 }
 const { envelope, payloadBytes } = parsed;

 // 步骤 2: Ed25519 验签（共享底座，使用注册表中活跃的公钥）
 const now = new Date();
 const activeKeys = config.runnerIdentityRegistry.getActivePublicKeys(now);
 const sigResult = verifyDSSEEnvelopeSignatures(
 envelope,
 payloadBytes,
 activeKeys,
 );
 if (!sigResult.verified) {
 return fail(sigResult.failureReason ?? "signature_invalid");
 }
 const verifiedKeyId = sigResult.verifiedKeyId as string;

 // 步骤 3: 解析 in-toto Statement（共享底座）
 const stmtResult = parseIntotoStatement(payloadBytes);
 if (!stmtResult.ok) {
 return fail(stmtResult.reason);
 }
 const statement = stmtResult.statement;

 // 步骤 3b: 校验 payloadType（共享底座）
 const ptResult = validatePayloadType(envelope.payloadType);
 if (!ptResult.ok) {
 return fail(ptResult.reason);
 }

 // 步骤 4: 校验 predicateType
 const stmtPredicateType = statement.predicateType;
 if (stmtPredicateType !== RUNTIME_CONFORMANCE_PREDICATE_TYPE) {
 return fail(
 "predicate_type_mismatch",
 typeof stmtPredicateType === "string" ? stmtPredicateType : undefined,
 );
 }

 // 步骤 5: 校验 subject digest 绑定（共享底座）
 const subResult = validateStatementSubject(statement);
 if (!subResult.ok) {
 return fail(subResult.reason);
 }

 // 步骤 6: 从 predicate 中解析 RuntimeConformanceReport
 const predicate = statement.predicate as Record<string, unknown> | undefined;
 if (!predicate || typeof predicate !== "object") {
 return fail("predicate_missing");
 }
 const report = predicate as unknown as RuntimeConformanceReport;

 // 步骤 7: 校验 Subject Artifact Digest 与 Report 自洽
 const reportArtifactDigestRaw = report.runtimeArtifactDigest.replace("sha256:", "");
 if (subResult.subjectDigestHex !== reportArtifactDigestRaw) {
 return fail("subject_digest_mismatch");
 }

 // 步骤 8: 校验 runtimeRevisionId（绑定校验，必填）
 if (report.runtimeRevisionId !== input.expectedRuntimeRevisionId) {
 return fail("runtime_revision_mismatch");
 }

 // 步骤 9: 校验 runtimeArtifactDigest（可选绑定校验）
 if (
 input.expectedRuntimeArtifactDigest &&
 report.runtimeArtifactDigest !== input.expectedRuntimeArtifactDigest
 ) {
 return fail("artifact_digest_mismatch");
 }

 // 步骤 10: 校验 runtimeConfigDigest（可选绑定校验）
 if (
 input.expectedRuntimeConfigDigest &&
 report.runtimeConfigDigest !== input.expectedRuntimeConfigDigest
 ) {
 return fail("config_digest_mismatch");
 }

 // 步骤 11: 校验 protocolContractRevision（可选绑定校验）
 if (
 input.expectedProtocolContractRevision &&
 report.protocolContractRevision !== input.expectedProtocolContractRevision
 ) {
 return fail("protocol_revision_mismatch");
 }

 // 步骤 12: 校验 suiteRevision
 if (report.suiteRevision !== CONFORMANCE_SUITE_REVISION) {
 return fail("suite_revision_mismatch");
 }

 // 步骤 13: 校验 Runner Key ↔ Runner Identity 绑定（注册表权威校验）
 // 验签通过的 keyId 必须与 report.runnerIdentity 存在显式授权绑定
 const identityResult = config.runnerIdentityRegistry.validate({
  keyId: verifiedKeyId,
  runnerIdentity: report.runnerIdentity,
  tenantId: input.tenantId,
  now,
 });
 if (!identityResult.ok) {
  return fail(identityResult.failureReason);
 }

 // 步骤 14: 校验 Case 集合完整（使用 ALL_CONFORMANCE_CASES）
 if (!Array.isArray(report.caseResults)) {
 return fail("case_results_incomplete");
 }
 const caseIds = report.caseResults.map((r) => r.caseId);
 const allPresent = ALL_CONFORMANCE_CASES.every((id) => caseIds.includes(id));
 if (!allPresent) {
 return fail("case_results_incomplete");
 }

 // 步骤 14b: 校验 Case ID 唯一（在长度校验之前，确保重复 case 被正确识别）
 if (new Set(caseIds).size !== caseIds.length) {
 return fail("case_results_not_unique");
 }

 // 步骤 14c: 校验 Case 数量精确匹配（无多余 case）
 if (caseIds.length !== ALL_CONFORMANCE_CASES.length) {
 return fail("case_results_incomplete");
 }

 // 步骤 15: 计算 Overall Result 与 Case 结果一致
 const allPassed = report.caseResults.every((r) => r.passed);
 if ((report.overallResult === "passed") !== allPassed) {
 return fail("overall_result_inconsistent");
 }

 // 步骤 16: 计算 envelopeDigest / payloadDigest（共享底座）
 const envelopeDigest = computeEnvelopeDigest(input.dsseEnvelopeBytes);
 const payloadDigest = computePayloadDigest(payloadBytes);

 // 步骤 17: 返回 VerifiedRuntimeConformanceClaims
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
