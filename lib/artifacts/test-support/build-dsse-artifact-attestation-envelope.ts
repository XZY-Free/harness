/**
 * 测试辅助：使用 Ed25519 密钥对生成合法的 DSSE Artifact Attestation Envelope。
 *
 * 供制品证明验收测试使用，生成符合 verifyArtifactAttestation 验签要求的 DSSE Envelope。
 * 与 Runtime Conformance 的 build-dsse-conformance-envelope.ts 对称，共用 lib/crypto/dsse 底座。
 *
 * Predicate 包含全量供应链证据（sbom_ref/sbom_digest/provenance_ref/provenance_digest 等），
 * 受 DSSE 签名保护，消除"有效签名 + 替换证据"的可能。
 *
 * 仅用于测试，生产代码禁止引用。
 */

import { type KeyObject, createHash, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import {
  ARTIFACT_ATTESTATION_PREDICATE_TYPE,
  type ArtifactProvenancePredicate,
} from "@/lib/artifacts/domain/artifact-attestation";
import { computeDssePae } from "@/lib/crypto/dsse";

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

/** 计算 SBOM / Provenance 等 JSON 内容的 digest（sha256:<hex>）。 */
export function computeTestDigest(content: unknown): string {
  const bytes = Buffer.from(JSON.stringify(content), "utf-8");
  const hex = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${hex}`;
}

/** Predicate 全量供应链证据（测试默认值）。 */
export interface PredicateSupplyChain {
  /** 制品 subject 名称。 */
  artifactSubject?: string;
  /** 制品类型。 */
  artifactType?: string;
  /** 所属 Revision ID。 */
  revisionId?: string;
  /** 源代码 revision。 */
  sourceRevision?: string;
  /** 构建流水线标识。 */
  buildPipeline?: string;
  /** SBOM 受管引用。 */
  sbomRef: string;
  /** SBOM JSON 内容（自动计算 sbomDigest）。 */
  sbomContent: unknown;
  /** Provenance 受管引用。 */
  provenanceRef: string;
  /** Provenance JSON 内容（自动计算 provenanceDigest）。 */
  provenanceContent: unknown;
  /** 依赖锁文件 digest。 */
  dependencyLockDigest?: string;
  /** 构建时间（RFC 3339）。 */
  buildTime?: string;
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
  /** 省略 Predicate 某个字段（用于测试 predicate_field_missing）。 */
  omitPredicateField?: keyof ArtifactProvenancePredicate;
  /** 覆盖签名 Predicate 中的 sbomDigest（用于测试 sbom_digest_mismatch）。 */
  tamperSbomDigest?: string;
  /** 覆盖签名 Predicate 中的 provenanceDigest（用于测试 provenance_digest_mismatch）。 */
  tamperProvenanceDigest?: string;
}

/**
 * 构造一个已签名的 DSSE Artifact Attestation Envelope 字节（Buffer）。
 *
 * 使用 Ed25519 对 DSSE PAE 签名，生成符合 in-toto v1 Statement 格式的 Envelope。
 * subject digest 绑定 artifactDigest（sha256:<hex> → { sha256: <hex> }）。
 * Predicate 包含全量供应链证据，受签名保护。
 *
 * 返回原始 JSON 字节，可直接写入 InMemoryManagedArtifactStore.writeDsseEnvelope。
 */
export function buildDsseArtifactAttestationEnvelope(
  key: TestBuilderKey,
  artifactDigest: string,
  supplyChain: PredicateSupplyChain,
  options?: BuildDsseEnvelopeOptions,
): Buffer {
  const digestHex = artifactDigest.replace("sha256:", "");
  const sbomDigest = options?.tamperSbomDigest ?? computeTestDigest(supplyChain.sbomContent);
  const provenanceDigest =
    options?.tamperProvenanceDigest ?? computeTestDigest(supplyChain.provenanceContent);

  const predicate: Record<string, unknown> = {
    artifactSubject: supplyChain.artifactSubject ?? "artifact",
    artifactDigest,
    artifactType: supplyChain.artifactType ?? "agent_revision",
    revisionId: supplyChain.revisionId ?? "rev-test",
    builderIdentity: key.builderIdentity,
    sourceRevision: supplyChain.sourceRevision ?? "abc123",
    buildPipeline: supplyChain.buildPipeline ?? "test-pipeline",
    sbomRef: supplyChain.sbomRef,
    sbomDigest,
    provenanceRef: supplyChain.provenanceRef,
    provenanceDigest,
    dependencyLockDigest:
      supplyChain.dependencyLockDigest ??
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    buildTime: supplyChain.buildTime ?? new Date().toISOString(),
  };

  // 省略指定字段（测试 predicate_field_missing）
  if (options?.omitPredicateField) {
    delete predicate[options.omitPredicateField];
  }

  const statement = {
    _type: options?.statementType ?? IN_TOTO_STATEMENT_TYPE_V1,
    subject: [
      {
        name: "artifact",
        digest: { sha256: (options?.subjectDigest ?? digestHex).replace("sha256:", "") },
      },
    ],
    predicateType: options?.predicateType ?? ARTIFACT_ATTESTATION_PREDICATE_TYPE,
    predicate,
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
    signatures: [
      { keyid: options?.keyid ?? key.builderIdentity, sig: sigBuffer.toString("base64") },
    ],
  };
  return Buffer.from(JSON.stringify(envelope), "utf-8");
}

/**
 * 构造一个非合法 JSON 的 DSSE Envelope 字节（用于测试 dsse_envelope_parse_failed）。
 */
export function buildMalformedDsseEnvelope(): Buffer {
  return Buffer.from("{not-valid-json", "utf-8");
}
