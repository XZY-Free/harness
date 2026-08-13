/**
 * 制品证明独立验证策略 — DSSE Envelope + in-toto Statement 统一信任协议。
 *
 * 事实源：docs/architecture/security.md -4.2、
 * docs/architecture/api-and-events.md §6（artifact-attestations:verify）、
 * docs/architecture/persistence.md 、
 * docs/architecture/agent-control-plane.md 。
 *
 * 核心原则（零信任供应链）：
 * - 调用方只能提交引用（dsse_envelope_ref / sbom_ref / provenance_ref），不能自报 verification_state。
 * - 验证服务独立读取 DSSE Envelope、SBOM 和 provenance 后决定结果。
 * - DSSE Envelope payload 必须是 in-toto Statement v1，subject digest 绑定 artifactDigest。
 * - 签名验证使用共享 DSSE 底座（lib/crypto/dsse），与 Runtime Conformance 共用。
 * - builder_identity 必须在白名单中，且 DSSE Envelope 签名 keyid 必须与 builder_identity 一致。
 * - digest 必须是 sha256:<hex> 格式，不接受可变 tag 作为历史依据。
 * - 引用必须是受管对象（attestation: / oci:// / managed:// 前缀），不接受任意公网 URL。
 * - 验证失败也持久化记录（安全摘要 + AuditEvent），响应不泄露内部漏洞细节给无权调用者。
 *
 * 本模块是纯逻辑（不访问 DB）；持久化与审计在 artifact-attestation-queries.ts。
 */
import { createHash } from "node:crypto";
import { validateCycloneDX } from "@/lib/artifacts/verification/cyclonedx-validator";
import {
  parseDSSEEnvelope,
  parseIntotoStatement,
  validatePayloadType,
  validateStatementSubject,
  verifyDSSEEnvelopeSignatures,
} from "@/lib/crypto/dsse";
import { ARTIFACT_KINDS, type ArtifactKind } from "./artifact";

const ARTIFACT_TYPES = ARTIFACT_KINDS;
export type ArtifactType = ArtifactKind;

/**
 * Artifact Attestation 标准 Predicate Type。
 *
 * 必须是项目长期拥有并可维护的稳定 HTTPS URI。
 * 与 Runtime Conformance 的 Predicate Type 区分，专用于制品 provenance 声明。
 */
export const ARTIFACT_ATTESTATION_PREDICATE_TYPE =
  "https://snowharness.dev/attestation/artifact-provenance/v1";

export const ATTESTATION_FAILURE_CODES = [
  "unknown_artifact_type",
  "digest_format_invalid",
  "signature_ref_not_managed",
  "sbom_ref_not_managed",
  "provenance_ref_not_managed",
  "builder_not_allowed",
  "dsse_envelope_unreadable",
  "sbom_unreadable",
  "provenance_unreadable",
  "dsse_envelope_parse_failed",
  "builder_key_mismatch",
  "signature_invalid",
  "predicate_field_missing",
  "sbom_digest_mismatch",
  "provenance_digest_mismatch",
  "cyclonedx_schema_failed",
  "sbom_blocked_vulnerability",
  "sbom_blocked_license",
  "provenance_missing_field",
  "provenance_buildtime_invalid",
  "attestation_revoked",
] as const;
export type AttestationFailureCode = (typeof ATTESTATION_FAILURE_CODES)[number];

// ─── Digest ────────────────────────────────────────────────

/**
 * 计算制品内容 digest（sha256:<hex> 格式）。
 *
 * 用于在创建 attestation 前由调用方对制品内容计算 digest，再传入 verifyArtifactAttestation。
 * digest 是制品内容的稳定标识，不接受可变 tag（如 git tag、docker tag）作为历史依据。
 */
export function computeArtifactDigest(content: string | Uint8Array): string {
  const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content);
  const hex = createHash("sha256").update(buf).digest("hex");
  return `sha256:${hex}`;
}

/** 校验 digest 是 sha256:<64-hex> 格式。 */
export function isValidArtifactDigest(digest: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(digest);
}

// ─── Managed Reference ─────────────────────────────────────

/**
 * 受管对象引用前缀（白名单）。
 * - attestation: 本地 attestation 存储（如 attestation:dsse:901）。
 * - oci:// OCI 制品仓库（受管 registry，digest 寻址）。
 * - managed:// 平台受管对象存储（如 managed://sbom/2026/07/abc.json）。
 *
 * 拒绝 http:// / https:// / file:// 等任意公网/本地路径引用。
 */
export const MANAGED_REF_PREFIXES = ["attestation:", "oci://", "managed://"] as const;

/** 校验引用是受管对象（不接受任意公网 URL 或本地路径）。 */
export function isManagedRef(ref: string): boolean {
  if (ref.length === 0) return false;
  if (/^https?:\/\//i.test(ref)) return false;
  if (/^file:\/\//i.test(ref)) return false;
  return MANAGED_REF_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

// ─── SBOM / Provenance ─────────────────────────────────────

/** SBOM 包条目。 */
export interface SbomPackage {
  name: string;
  version: string;
  licenses: string[];
  vulnerabilities: Array<{
    id: string;
    severity: "critical" | "high" | "medium" | "low";
  }>;
}

/** SBOM JSON 结构（由受管存储返回）。 */
export interface SbomDocument {
  packages: SbomPackage[];
}

/** provenance JSON 结构（由受管存储返回）。 */
export interface ProvenanceDocument {
  /** 源代码 revision（git commit sha 等）。 */
  sourceRevision: string;
  /** 构建流水线标识。 */
  buildPipeline: string;
  /** 依赖锁文件引用（含 hash，如 package-lock.json:sha256:xyz）。 */
  dependencyLockFile: string;
  /** 构建时间（RFC 3339）。 */
  buildTime: string;
}

// ─── Signed Predicate (in-toto Statement payload) ──────────

/**
 * Artifact Provenance Predicate — DSSE 签名保护的全量供应链证据。
 *
 * 此结构是 in-toto Statement 的 predicate 字段，受 DSSE 签名保护。
 * SBOM 和 Provenance 引用及其 digest 必须在签名范围内，
 * 消除"有效签名 + 替换证据"的可能。
 *
 * 验证顺序：
 * 1. 验签 DSSE Envelope
 * 2. 解析已签名 Statement → 提取此 Predicate
 * 3. 从 Predicate 取得 sbom_ref / provenance_ref
 * 4. 读取受管对象
 * 5. 计算对象 digest
 * 6. 与 Predicate 中的 sbom_digest / provenance_digest 精确比较
 * 7. 执行 CycloneDX Schema / License / Vulnerability / Provenance Policy
 * 8. 写 ArtifactAttestation
 */
export interface ArtifactProvenancePredicate {
  /** 制品 subject 名称。 */
  artifactSubject: string;
  /** 制品 digest（sha256:<hex>，与 Statement subject[0].digest.sha256 一致）。 */
  artifactDigest: string;
  /** 制品类型（agent_revision / runtime_revision）。 */
  artifactType: string;
  /** 所属 Revision ID。 */
  revisionId: string;
  /** 构建者身份（与 DSSE 签名 keyid 一致）。 */
  builderIdentity: string;
  /** 源代码 revision（git commit sha 等）。 */
  sourceRevision: string;
  /** 构建流水线标识。 */
  buildPipeline: string;
  /** SBOM 受管引用。 */
  sbomRef: string;
  /** SBOM 内容 digest（sha256:<hex>）。 */
  sbomDigest: string;
  /** Provenance 受管引用。 */
  provenanceRef: string;
  /** Provenance 内容 digest（sha256:<hex>）。 */
  provenanceDigest: string;
  /** 依赖锁文件 digest（sha256:<hex>）。 */
  dependencyLockDigest: string;
  /** 构建时间（RFC 3339）。 */
  buildTime: string;
}

/** ArtifactProvenancePredicate 必填字段名列表。 */
const PREDICATE_REQUIRED_FIELDS: ReadonlyArray<keyof ArtifactProvenancePredicate> = [
  "artifactSubject",
  "artifactDigest",
  "artifactType",
  "revisionId",
  "builderIdentity",
  "sourceRevision",
  "buildPipeline",
  "sbomRef",
  "sbomDigest",
  "provenanceRef",
  "provenanceDigest",
  "dependencyLockDigest",
  "buildTime",
];

// ─── Managed Artifact Store ────────────────────────────────

/**
 * 受管对象存储接口：通过 ref 查询 DSSE Envelope / SBOM / provenance 内容。
 *
 * "独立读取"语义：验证服务通过此接口读取内容，调用方不能自报 verified。
 * 实现可以是 in-memory（测试）、文件系统、对象存储或 OCI registry。
 *
 * readDsseEnvelope 返回原始 DSSE Envelope JSON 字节（未解析），由共享 DSSE 底座解析验签。
 * readSbom 返回原始 SBOM JSON 对象（未解析），由 CycloneDX 验证器校验后提取策略数据。
 *
 * 读取失败（ref 不存在、内容损坏、解码失败）应抛错；verifyArtifactAttestation 会捕获并返回 failed。
 */
export interface ManagedArtifactStore {
  /** 读取 DSSE Envelope 原始字节（JSON 编码的 DSSE Envelope）。 */
  readDsseEnvelope(ref: string): Promise<Buffer>;
  /** 读取 SBOM 原始 JSON 对象（CycloneDX 格式，由验证器校验）。 */
  readSbom(ref: string): Promise<unknown>;
  readProvenance(ref: string): Promise<ProvenanceDocument>;
}

// ─── Policy (Blocked Vulnerabilities / Licenses) ───────────

/** 阻断漏洞等级（命中时 verification_state=failed）。 */
export const BLOCKED_VULNERABILITY_SEVERITIES = ["critical", "high"] as const;

/** 阻断许可证列表（命中时 verification_state=failed）。 */
export const BLOCKED_LICENSES = [
  "GPL-2.0",
  "GPL-3.0",
  "AGPL-3.0",
  "GPL-2.0-only",
  "GPL-3.0-only",
  "AGPL-3.0-only",
] as const;

// ─── Builder Key Registry ──────────────────────────────────

/**
 * builder identity → 公钥映射（受管白名单 / DSSE 信任锚）。
 *
 * key 是 builder identity（如 "builder:company-agent-runtime"），
 * 同时用作 DSSE Envelope 签名的 keyid。
 * value 是 base64 编码的 32 字节 raw ed25519 公钥。
 *
 * 调用方注入此映射（生产环境从配置/PolicyRevision 读取，测试环境动态生成密钥对）。
 * 与共享 DSSE 底座的 trustedKeys 参数兼容（Record<string, string>）。
 */
export type BuilderKeyRegistry = Record<string, string>;

// ─── Verify Input / Result ─────────────────────────────────

/** verifyArtifactAttestation 入参（调用方只能提交 DSSE Envelope 引用，不能自报 verification_state）。 */
export interface VerifyAttestationInput {
  tenantId: string;
  artifactType: string;
  artifactRevisionId: string;
  artifactDigest: string;
  /** DSSE Envelope 受管引用（包含 in-toto Statement 签名 payload，Predicate 含全量供应链证据）。 */
  dsseEnvelopeRef: string;
  builderIdentity: string;
  /** 验证所用策略修订 id（可选；本地白名单 fallback 时为 null）。 */
  policyRevisionId?: string;
}

/** verifyArtifactAttestation 结果。 */
export interface VerifyAttestationResult {
  verificationState: "verified" | "failed";
  /** 失败分类码（仅 failed 时非空）。 */
  failureCode?: AttestationFailureCode;
  /** 失败原因摘要（持久化到审计，不泄露内部漏洞细节给无权调用者）。 */
  failureReason?: string;
  /** 从签名 Predicate 提取的 SBOM 引用（verified 时必存在）。 */
  sbomRef?: string;
  /** 从签名 Predicate 提取的 Provenance 引用（verified 时必存在）。 */
  provenanceRef?: string;
  /** 成功时返回的 provenance 摘要（用于持久化到 MySQL，满足 可查询要求）。 */
  provenanceSummary?: {
    sourceRevision: string;
    buildPipeline: string;
    dependencyLockFile: string;
    buildTime: string;
  };
  /** 成功时返回的扫描摘要（命中漏洞/许可证计数，不存原文漏洞细节）。 */
  scanSummary?: {
    packagesScanned: number;
    vulnerabilityCount: number;
    blockedLicenseCount: number;
  };
}

// ─── Verification Service ──────────────────────────────────

/**
 * 验证 attestation（独立读取 DSSE Envelope/SBOM/provenance，调用方不能自报 verified）。
 *
 * 校验链（任一失败即返回 failed）：
 * 1. artifactType 在允许枚举内。
 * 2. artifactDigest 是 sha256:<hex> 格式。
 * 3. dsseEnvelopeRef 是受管引用。
 * 4. builderIdentity 在白名单中。
 * 5. 独立读取 DSSE Envelope 字节（受管存储）。
 * 6. 解析 DSSE Envelope（共享底座 parseDSSEEnvelope）。
 * 7. Ed25519 验签（共享底座 verifyDSSEEnvelopeSignatures），keyid 必须与 builderIdentity 一致。
 * 8. 解析 in-toto Statement，校验 _type / predicateType / subject digest 绑定。
 * 9. 解析已签名 Predicate（ArtifactProvenancePredicate），校验全部必填字段。
 * 10. 校验 Predicate 中的 sbomRef / provenanceRef 为受管引用。
 * 11. 独立读取 SBOM，计算 digest 并与 Predicate 中的 sbomDigest 精确比较。
 * 12. CycloneDX Schema + License + Vulnerability Policy。
 * 13. 独立读取 Provenance，计算 digest 并与 Predicate 中的 provenanceDigest 精确比较。
 * 14. Provenance 必填字段与 buildTime 有效性校验。
 *
 * 本函数是纯逻辑（不访问 DB，不写审计）；持久化与审计在 verifyAndPersistAttestation。
 */
export async function verifyArtifactAttestation(
  input: VerifyAttestationInput,
  store: ManagedArtifactStore,
  builderKeys: BuilderKeyRegistry,
): Promise<VerifyAttestationResult> {
  // 1. artifactType 枚举校验
  if (!(ARTIFACT_TYPES as readonly string[]).includes(input.artifactType)) {
    return {
      verificationState: "failed",
      failureCode: "unknown_artifact_type",
      failureReason: `未知 artifact_type: ${input.artifactType}`,
    };
  }

  // 2. digest 格式校验
  if (!isValidArtifactDigest(input.artifactDigest)) {
    return {
      verificationState: "failed",
      failureCode: "digest_format_invalid",
      failureReason: "artifact_digest 非 sha256:<64-hex> 格式",
    };
  }

  // 3. 受管引用校验（拒绝公网 URL）
  if (!isManagedRef(input.dsseEnvelopeRef)) {
    return {
      verificationState: "failed",
      failureCode: "signature_ref_not_managed",
      failureReason: "dsse_envelope_ref 非受管引用",
    };
  }

  // 4. builder identity 白名单校验
  const expectedPublicKey = builderKeys[input.builderIdentity];
  if (!expectedPublicKey) {
    return {
      verificationState: "failed",
      failureCode: "builder_not_allowed",
      failureReason: `builder identity 不在允许列表: ${input.builderIdentity}`,
    };
  }

  // 5. 独立读取 DSSE Envelope 字节（调用方不能自报）
  let envelopeBytes: Buffer;
  try {
    envelopeBytes = await store.readDsseEnvelope(input.dsseEnvelopeRef);
  } catch {
    return {
      verificationState: "failed",
      failureCode: "dsse_envelope_unreadable",
      failureReason: "无法读取 DSSE Envelope",
    };
  }

  // 6. 解析 DSSE Envelope（共享底座）
  const parsed = parseDSSEEnvelope(envelopeBytes);
  if (!parsed.ok) {
    return {
      verificationState: "failed",
      failureCode: "dsse_envelope_parse_failed",
      failureReason: parsed.reason,
    };
  }
  const { envelope, payloadBytes } = parsed;

  // 7. Ed25519 验签（共享底座）— 仅信任 builderIdentity 对应的公钥
  const sigResult = verifyDSSEEnvelopeSignatures(envelope, payloadBytes, {
    [input.builderIdentity]: expectedPublicKey,
  });
  if (!sigResult.verified) {
    const failureCode: AttestationFailureCode =
      sigResult.failureReason === "unknown_keyid" ? "builder_key_mismatch" : "signature_invalid";
    return {
      verificationState: "failed",
      failureCode,
      failureReason: sigResult.failureReason ?? "signature_invalid",
    };
  }

  // 8. 解析 in-toto Statement 并校验语义绑定（共享底座）
  const stmtResult = parseIntotoStatement(payloadBytes);
  if (!stmtResult.ok) {
    return {
      verificationState: "failed",
      failureCode: "dsse_envelope_parse_failed",
      failureReason: stmtResult.reason,
    };
  }
  const statement = stmtResult.statement;

  // 8b. 校验 payloadType（DSSE Envelope 层，共享底座）
  const ptResult = validatePayloadType(envelope.payloadType);
  if (!ptResult.ok) {
    return {
      verificationState: "failed",
      failureCode: "dsse_envelope_parse_failed",
      failureReason: ptResult.reason,
    };
  }

  // 8c. 校验 predicateType
  if (statement.predicateType !== ARTIFACT_ATTESTATION_PREDICATE_TYPE) {
    return {
      verificationState: "failed",
      failureCode: "dsse_envelope_parse_failed",
      failureReason: `predicate_type_mismatch: ${String(statement.predicateType)}`,
    };
  }

  // 8d. 校验 subject digest 与 artifactDigest 绑定（共享底座）
  const subResult = validateStatementSubject(statement);
  if (!subResult.ok) {
    return {
      verificationState: "failed",
      failureCode: "dsse_envelope_parse_failed",
      failureReason: subResult.reason,
    };
  }
  const expectedDigestHex = input.artifactDigest.replace("sha256:", "");
  if (subResult.subjectDigestHex !== expectedDigestHex) {
    return {
      verificationState: "failed",
      failureCode: "signature_invalid",
      failureReason: "subject_digest_mismatch",
    };
  }

  // 9. 解析已签名 Predicate — 全量供应链证据受 DSSE 签名保护
  const predicate = statement.predicate as Record<string, unknown>;
  const missingField = PREDICATE_REQUIRED_FIELDS.find((f) => predicate[f] == null);
  if (missingField) {
    return {
      verificationState: "failed",
      failureCode: "predicate_field_missing",
      failureReason: `签名 Predicate 缺少必填字段: ${missingField}`,
    };
  }
  const signedPredicate = predicate as unknown as ArtifactProvenancePredicate;

  // 10. 校验 Predicate 中的 sbomRef / provenanceRef 为受管引用
  if (!isManagedRef(signedPredicate.sbomRef)) {
    return {
      verificationState: "failed",
      failureCode: "sbom_ref_not_managed",
      failureReason: "签名 Predicate 中 sbomRef 非受管引用",
    };
  }
  if (!isManagedRef(signedPredicate.provenanceRef)) {
    return {
      verificationState: "failed",
      failureCode: "provenance_ref_not_managed",
      failureReason: "签名 Predicate 中 provenanceRef 非受管引用",
    };
  }

  // 11. 独立读取 SBOM → 计算 digest → 与签名 Predicate 中 sbomDigest 精确比较
  let sbomDoc: unknown;
  let sbomRawBytes: Buffer;
  try {
    sbomDoc = await store.readSbom(signedPredicate.sbomRef);
    sbomRawBytes = Buffer.from(JSON.stringify(sbomDoc), "utf-8");
  } catch {
    return {
      verificationState: "failed",
      failureCode: "sbom_unreadable",
      failureReason: "无法读取 SBOM",
    };
  }
  const actualSbomDigest = computeArtifactDigest(sbomRawBytes);
  if (actualSbomDigest !== signedPredicate.sbomDigest) {
    return {
      verificationState: "failed",
      failureCode: "sbom_digest_mismatch",
      failureReason: "SBOM digest 与签名 Predicate 中 sbomDigest 不一致",
    };
  }

  // 12. CycloneDX 完整 Schema 验证 + 业务 Policy
  const cyclonedxResult = validateCycloneDX({ document: sbomDoc });
  if (cyclonedxResult.status === "failed") {
    return {
      verificationState: "failed",
      failureCode: "cyclonedx_schema_failed",
      failureReason: `CycloneDX 验证失败: ${cyclonedxResult.failureReasons?.join("; ") ?? "unknown"}`,
    };
  }

  // 13. License 策略 — 从 CycloneDX components 提取许可证并检查阻断列表
  const components = (sbomDoc as Record<string, unknown>)?.components;
  let blockedLicenseCount = 0;
  if (Array.isArray(components)) {
    for (const comp of components) {
      const c = comp as Record<string, unknown>;
      if (c.licenses && Array.isArray(c.licenses)) {
        for (const lic of c.licenses) {
          const l = lic as Record<string, unknown>;
          const licenseId =
            l.license && typeof l.license === "object"
              ? ((l.license as Record<string, unknown>).id ??
                (l.license as Record<string, unknown>).expression)
              : null;
          if (
            typeof licenseId === "string" &&
            (BLOCKED_LICENSES as readonly string[]).includes(licenseId)
          ) {
            blockedLicenseCount++;
            return {
              verificationState: "failed",
              failureCode: "sbom_blocked_license",
              failureReason: `阻断许可证: ${c.name ?? "unknown"} ${licenseId}`,
            };
          }
        }
      }
    }
  }

  // 14. 漏洞策略 — 从 CycloneDX 顶层 vulnerabilities 提取并检查阻断等级
  let vulnerabilityCount = 0;
  const vulnArray = (sbomDoc as Record<string, unknown>)?.vulnerabilities;
  if (Array.isArray(vulnArray)) {
    for (const vuln of vulnArray) {
      vulnerabilityCount++;
      const v = vuln as Record<string, unknown>;
      const ratings = v.ratings;
      const severity = Array.isArray(ratings)
        ? ((ratings as Record<string, unknown>[])[0]?.severity as string)
        : (v.severity as string | undefined);
      if (severity && (BLOCKED_VULNERABILITY_SEVERITIES as readonly string[]).includes(severity)) {
        return {
          verificationState: "failed",
          failureCode: "sbom_blocked_vulnerability",
          failureReason: `阻断漏洞: ${v.id ?? "unknown"} (${severity})`,
        };
      }
    }
  }

  // 15. 独立读取 Provenance → 计算 digest → 与签名 Predicate 中 provenanceDigest 精确比较
  let provenance: ProvenanceDocument;
  let provenanceRawBytes: Buffer;
  try {
    provenance = await store.readProvenance(signedPredicate.provenanceRef);
    provenanceRawBytes = Buffer.from(JSON.stringify(provenance), "utf-8");
  } catch {
    return {
      verificationState: "failed",
      failureCode: "provenance_unreadable",
      failureReason: "无法读取 provenance",
    };
  }
  const actualProvenanceDigest = computeArtifactDigest(provenanceRawBytes);
  if (actualProvenanceDigest !== signedPredicate.provenanceDigest) {
    return {
      verificationState: "failed",
      failureCode: "provenance_digest_mismatch",
      failureReason: "Provenance digest 与签名 Predicate 中 provenanceDigest 不一致",
    };
  }

  // 16. provenance 必填字段校验
  if (
    !provenance.sourceRevision ||
    !provenance.buildPipeline ||
    !provenance.dependencyLockFile ||
    !provenance.buildTime
  ) {
    return {
      verificationState: "failed",
      failureCode: "provenance_missing_field",
      failureReason:
        "provenance 缺少必填字段（sourceRevision/buildPipeline/dependencyLockFile/buildTime）",
    };
  }

  // 17. provenance buildTime 有效性校验
  if (Number.isNaN(Date.parse(provenance.buildTime))) {
    return {
      verificationState: "failed",
      failureCode: "provenance_buildtime_invalid",
      failureReason: "provenance buildTime 非有效 RFC 3339 时间",
    };
  }

  return {
    verificationState: "verified",
    sbomRef: signedPredicate.sbomRef,
    provenanceRef: signedPredicate.provenanceRef,
    provenanceSummary: {
      sourceRevision: provenance.sourceRevision,
      buildPipeline: provenance.buildPipeline,
      dependencyLockFile: provenance.dependencyLockFile,
      buildTime: provenance.buildTime,
    },
    scanSummary: {
      packagesScanned:
        cyclonedxResult.componentCount ?? (Array.isArray(components) ? components.length : 0),
      vulnerabilityCount,
      blockedLicenseCount,
    },
  };
}

// ─── Errors ────────────────────────────────────────────────

/** 制品证明验证失败错误（route 层应映射为 422 ARTIFACT_ATTESTATION_FAILED）。 */
export class ArtifactAttestationFailedError extends Error {
  constructor(
    public readonly failureCode: AttestationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactAttestationFailedError";
  }
}

/** 未验证制品错误：发布/路由引用未验证或验证失败的 attestation（route 层映射为 409 ARTIFACT_NOT_VERIFIED）。 */
export class ArtifactNotVerifiedError extends Error {
  constructor(
    public readonly attestationId: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactNotVerifiedError";
  }
}

// ─── Re-exports ────────────────────────────────────────────

export { ARTIFACT_KINDS as ARTIFACT_TYPES, VERIFICATION_STATES } from "./artifact";
