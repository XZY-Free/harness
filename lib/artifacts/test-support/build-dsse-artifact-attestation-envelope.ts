/**
 * 测试辅助：使用 Ed25519 密钥对生成合法的 DSSE Artifact Attestation Envelope。
 *
 * 供制品证明验收测试使用，生成符合 verifyArtifactAttestation 验签要求的 DSSE Envelope。
 * 与 Runtime Conformance 的 build-dsse-conformance-envelope.ts 对称，共用 lib/crypto/dsse 底座。
 *
 * 仅用于测试，生产代码禁止引用。
 */

import { type KeyObject, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { computeDssePae } from "@/lib/crypto/dsse";
import { ARTIFACT_ATTESTATION_PREDICATE_TYPE } from "@/lib/artifacts/domain/artifact-attestation";

/** DSSE 标准 payloadType。 */
const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
/** in-toto Statement v1 类型 URI。 */
const IN_TOTO_STATEMENT_TYPE_V1 = "https://in-toto.io/Statement/v1";

export interface TestBuilderKey {
 builderIdentity: string;
 publicKeyBase64: string;
 privateKey: KeyObject;
}

/** 生成一对 Ed25519 测试密钥（raw 32 字节公钥 base64 + KeyObject 私钥）。 */
export function generateTestBuilderKey(builderIdentity: string): TestBuilderKey {
 const { publicKey, privateKey } = generateKeyPairSync("ed25519");
 const der = publicKey.export({ type: "spki", format: "der" });
 const rawPublicKey = Buffer.from(der.subarray(der.length - 32));
 return {
 builderIdentity,
 publicKeyBase64: rawPublicKey.toString("base64"),
 privateKey,
 };
}

export interface BuildDsseEnvelopeOptions {
 /** 覆盖 subject digest（默认取 artifactDigest）。用于测试 subject_digest_mismatch。 */
 subjectDigest?: string;
 /** 覆盖 predicateType（默认取 ARTIFACT_ATTESTATION_PREDICATE_TYPE）。用于测试 predicate_type_mismatch。 */
 predicateType?: string;
 /** 覆盖签名 keyid（默认取 key.builderIdentity）。用于测试 builder_key_mismatch。 */
 keyid?: string;
 /** 翻转签名首字节使验签失败。用于测试 signature_invalid。 */
 tamperSignature?: boolean;
 /** 覆盖 in-toto Statement _type。用于测试 dsse_envelope_parse_failed。 */
 statementType?: string;
}

/**
 * 构造一个已签名的 DSSE Artifact Attestation Envelope 字节（Buffer）。
 *
 * 使用 Ed25519 对 DSSE PAE 签名，生成符合 in-toto v1 Statement 格式的 Envelope。
 * subject digest 绑定 artifactDigest（sha256:<hex> → { sha256: <hex> }）。
 *
 * 返回原始 JSON 字节，可直接写入 InMemoryManagedArtifactStore.writeDsseEnvelope。
 */
export function buildDsseArtifactAttestationEnvelope(
 key: TestBuilderKey,
 artifactDigest: string,
 options?: BuildDsseEnvelopeOptions,
): Buffer {
 const digestHex = artifactDigest.replace("sha256:", "");
 const statement = {
 _type: options?.statementType ?? IN_TOTO_STATEMENT_TYPE_V1,
 subject: [
 {
 name: "artifact",
 digest: { sha256: (options?.subjectDigest ?? digestHex).replace("sha256:", "") },
 },
 ],
 predicateType: options?.predicateType ?? ARTIFACT_ATTESTATION_PREDICATE_TYPE,
 predicate: {
 builderIdentity: key.builderIdentity,
 artifactDigest,
 },
 };
 const payloadJson = JSON.stringify(statement);
 const payloadBytes = Buffer.from(payloadJson, "utf-8");
 const payloadBase64 = payloadBytes.toString("base64");

 const pae = computeDssePae(DSSE_PAYLOAD_TYPE, payloadBytes);
 const signature = cryptoSign(null, pae, key.privateKey);
 const sigBuffer = Buffer.from(signature);
 if (options?.tamperSignature) {
 sigBuffer[0] = (sigBuffer[0] ?? 0) ^ 0xff;
 }

 const envelope = {
 payloadType: DSSE_PAYLOAD_TYPE,
 payload: payloadBase64,
 signatures: [{ keyid: options?.keyid ?? key.builderIdentity, sig: sigBuffer.toString("base64") }],
 };
 return Buffer.from(JSON.stringify(envelope), "utf-8");
}

/**
 * 构造一个非合法 JSON 的 DSSE Envelope 字节（用于测试 dsse_envelope_parse_failed）。
 */
export function buildMalformedDsseEnvelope(): Buffer {
 return Buffer.from("{not-valid-json", "utf-8");
}
