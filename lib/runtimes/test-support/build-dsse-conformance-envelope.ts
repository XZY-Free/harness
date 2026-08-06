/**
 * 测试辅助：使用 Ed25519 密钥对生成合法的 DSSE Conformance Envelope JSON。
 *
 * 供验收测试使用，生成符合 createDSSEConformanceVerifier 验签要求的 Envelope。
 * 仅用于测试，生产代码禁止引用。
 */

import {
 createHash,
 generateKeyPairSync,
 createPrivateKey,
 sign as cryptoSign,
 randomUUID,
} from "node:crypto";
import { computeDssePae } from "@/lib/crypto/dsse";
import {
 ALL_CONFORMANCE_CASES,
 CONFORMANCE_SUITE_REVISION,
} from "@/lib/runtimes/domain/runtime-conformance-contract";
import type { RuntimeConformanceReport } from "@/lib/runtimes/domain/runtime-conformance-run";
import { RUNTIME_CONFORMANCE_PREDICATE_TYPE } from "@/lib/runtimes/verification/runtime-conformance-verifier";

export interface TestRunnerKey {
 keyid: string;
 publicKeyBase64: string;
 privateKey: Uint8Array;
}

/** 生成一对 Ed25519 测试密钥（raw 32 字节公钥 base64 + raw 32 字节私钥）。 */
export function generateTestRunnerKey(keyid: string): TestRunnerKey {
 const { publicKey, privateKey } = generateKeyPairSync("ed25519");
 const rawPublic = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
 const rawPrivate = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32);
 return {
 keyid,
 publicKeyBase64: Buffer.from(rawPublic).toString("base64"),
 privateKey: new Uint8Array(rawPrivate),
 };
}

/** DSSE 标准 payloadType。 */
const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/**
 * 构造一个已签名的 DSSE Conformance Envelope JSON 字符串。
 *
 * 使用 Ed25519 对 DSSE PAE 签名，生成符合 in-toto v1 Statement 格式的 Envelope。
 */
export function buildDsseConformanceEnvelope(
 report: RuntimeConformanceReport,
 runnerKey: TestRunnerKey,
): string {
 const statement = {
 _type: "https://in-toto.io/Statement/v1",
 subject: [
 {
 name: "runtime-artifact",
 digest: { sha256: report.runtimeArtifactDigest.replace("sha256:", "") },
 },
 ],
 predicateType: RUNTIME_CONFORMANCE_PREDICATE_TYPE,
 predicate: report,
 };
 const payloadJson = JSON.stringify(statement);
 const payloadBytes = Buffer.from(payloadJson, "utf-8");
 const payloadBase64 = payloadBytes.toString("base64");

 const pae = computeDssePae(DSSE_PAYLOAD_TYPE, payloadBytes);

 const privateKey = createPrivateKey({
 key: {
 kty: "OKP",
 crv: "Ed25519",
 x: Buffer.from(runnerKey.publicKeyBase64, "base64").toString("base64url"),
 d: Buffer.from(runnerKey.privateKey).toString("base64url"),
 },
 format: "jwk",
 });
 const signature = cryptoSign(null, pae, privateKey);

 const envelope = {
 payloadType: DSSE_PAYLOAD_TYPE,
 payload: payloadBase64,
 signatures: [{ keyid: runnerKey.keyid, sig: signature.toString("base64") }],
 };
 return JSON.stringify(envelope);
}

/**
 * 构造一个合法的 RuntimeConformanceReport（全部 case passed）。
 *
 * 供测试快速构造 report 对象，可覆盖任意字段。
 */
export function buildTestConformanceReport(
 revisionId: string,
 overrides: Partial<RuntimeConformanceReport> = {},
): RuntimeConformanceReport {
 const startedAt = new Date("2026-08-02T01:00:00.000Z");
 return {
 runId: randomUUID(),
 runtimeRevisionId: revisionId,
 runtimeArtifactDigest: `sha256:${"a".repeat(64)}`,
 runtimeConfigDigest: `sha256:${"b".repeat(64)}`,
 protocolContractRevision: "agent-runtime-protocol@1",
 suiteRevision: CONFORMANCE_SUITE_REVISION,
 runnerArtifactDigest: `sha256:${"c".repeat(64)}`,
 runnerIdentity: "ci/runtime-conformance",
 testEnvironmentRevision: "isolated-mysql8@1",
 startedAt: startedAt.toISOString(),
 completedAt: new Date(startedAt.getTime() + 1000).toISOString(),
 overallResult: "passed",
 evidenceManifestDigest: `sha256:${"d".repeat(64)}`,
 caseResults: ALL_CONFORMANCE_CASES.map((caseId, index) => ({
 caseId,
 passed: true,
 reason: null,
 evidenceDigest: `sha256:${index.toString(16).padStart(64, "0")}`,
 })),
 ...overrides,
 };
}

/**
 * 计算字符串的 sha256 digest（sha256:hex 格式）。
 * 供测试计算 envelopeDigest 使用。
 */
export function computeSha256Digest(data: string | Buffer): string {
 return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}
