/**
 * V11 制品证明验证服务（S03-C03）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §4.1-4.2、
 *         ../v11-agentkit-platform/11-api-and-event-boundaries.md §6（artifact-attestations:verify）、
 *         ../v11-agentkit-platform/10-core-data-model.md §8.2、
 *         ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md S03-W04。
 *
 * 核心原则（零信任供应链）：
 * - 调用方只能提交引用（signature_bundle_ref / sbom_ref / provenance_ref），不能自报 verification_state。
 * - 验证服务独立读取签名、SBOM 和 provenance 后决定结果。
 * - 本地开发验证使用真实签名（ed25519）和可查询 SBOM/provenance 产物，不使用"跳过验证"假配置。
 * - digest 必须是 sha256:<hex> 格式，不接受可变 tag 作为历史依据。
 * - 引用必须是受管对象（attestation: / oci:// / managed:// 前缀），不接受任意公网 URL。
 * - builder_identity 必须在白名单中，签名 bundle 公钥必须与白名单一致。
 * - 验证失败也持久化记录（安全摘要 + AuditEvent），响应不泄露内部漏洞细节给无权调用者。
 *
 * 本模块是纯逻辑（不访问 DB）；持久化与审计在 artifact-attestation-queries.ts。
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  ARTIFACT_TYPES,
  type ArtifactType,
  type AttestationFailureCode,
} from "@/lib/v11/schema/artifact";

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
 * - attestation: 本地 attestation 存储（如 attestation:signature:901）。
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

// ─── Signature Bundle / SBOM / Provenance ──────────────────

/** 签名 bundle JSON 结构（由受管存储返回）。 */
export interface SignatureBundle {
  /** 签名算法；当前仅支持 ed25519。 */
  algorithm: "ed25519";
  /** 签名公钥（base64 编码的 32 字节 raw ed25519 公钥）。 */
  publicKey: string;
  /** 签名值（base64 编码的 64 字节 ed25519 签名）。 */
  signature: string;
}

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

// ─── Managed Artifact Store ────────────────────────────────

/**
 * 受管对象存储接口：通过 ref 查询签名 bundle / SBOM / provenance 内容。
 *
 * "独立读取"语义：验证服务通过此接口读取内容，调用方不能自报 verified。
 * 实现可以是 in-memory（测试）、文件系统、对象存储或 OCI registry。
 *
 * 读取失败（ref 不存在、内容损坏、解码失败）应抛错；verifyArtifactAttestation 会捕获并返回 failed。
 */
export interface ManagedArtifactStore {
  readSignatureBundle(ref: string): Promise<SignatureBundle>;
  readSbom(ref: string): Promise<SbomDocument>;
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
 * builder identity → 公钥映射（受管白名单）。
 *
 * key 是 builder identity（如 "builder:company-agent-runtime"），
 * value 是 base64 编码的 32 字节 raw ed25519 公钥。
 *
 * 调用方注入此映射（生产环境从配置/PolicyRevision 读取，测试环境动态生成密钥对）。
 */
export type BuilderKeyRegistry = Record<string, string>;

// ─── Verify Input / Result ─────────────────────────────────

/** verifyArtifactAttestation 入参（调用方只能提交引用，不能自报 verification_state）。 */
export interface VerifyAttestationInput {
  tenantId: string;
  artifactType: string;
  artifactRevisionId: string;
  artifactDigest: string;
  signatureBundleRef: string;
  sbomRef: string;
  provenanceRef: string;
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
  /** 成功时返回的 provenance 摘要（用于持久化到 MySQL，满足 §4.1 可查询要求）。 */
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
 * 验证 attestation（独立读取签名/SBOM/provenance，调用方不能自报 verified）。
 *
 * 校验链（任一失败即返回 failed，不短路以便审计完整原因）：
 * 1. artifactType 在允许枚举内。
 * 2. artifactDigest 是 sha256:<hex> 格式。
 * 3. signatureBundleRef / sbomRef / provenanceRef 是受管引用。
 * 4. builderIdentity 在白名单中。
 * 5. 独立读取签名 bundle（受管存储）。
 * 6. 签名算法是 ed25519，公钥与 builder 白名单一致。
 * 7. ed25519 验签（payload = artifactDigest 字符串）。
 * 8. 独立读取 SBOM，校验阻断漏洞与阻断许可证。
 * 9. 独立读取 provenance，校验必填字段与 buildTime 有效性。
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
  if (!isManagedRef(input.signatureBundleRef)) {
    return {
      verificationState: "failed",
      failureCode: "signature_ref_not_managed",
      failureReason: "signature_bundle_ref 非受管引用",
    };
  }
  if (!isManagedRef(input.sbomRef)) {
    return {
      verificationState: "failed",
      failureCode: "sbom_ref_not_managed",
      failureReason: "sbom_ref 非受管引用",
    };
  }
  if (!isManagedRef(input.provenanceRef)) {
    return {
      verificationState: "failed",
      failureCode: "provenance_ref_not_managed",
      failureReason: "provenance_ref 非受管引用",
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

  // 5. 独立读取签名 bundle（调用方不能自报）
  let signatureBundle: SignatureBundle;
  try {
    signatureBundle = await store.readSignatureBundle(input.signatureBundleRef);
  } catch {
    return {
      verificationState: "failed",
      failureCode: "signature_bundle_unreadable",
      failureReason: "无法读取签名 bundle",
    };
  }

  // 6. 签名算法与公钥一致性校验
  if (signatureBundle.algorithm !== "ed25519") {
    return {
      verificationState: "failed",
      failureCode: "signature_algorithm_unsupported",
      failureReason: `不支持算法: ${signatureBundle.algorithm}`,
    };
  }
  if (signatureBundle.publicKey !== expectedPublicKey) {
    return {
      verificationState: "failed",
      failureCode: "builder_key_mismatch",
      failureReason: "签名 bundle 公钥与 builder 白名单不一致",
    };
  }

  // 7. ed25519 验签（payload = artifactDigest 字符串）
  try {
    verifyEd25519Signature(expectedPublicKey, input.artifactDigest, signatureBundle.signature);
  } catch {
    return {
      verificationState: "failed",
      failureCode: "signature_invalid",
      failureReason: "ed25519 验签失败",
    };
  }

  // 8. 独立读取 SBOM
  let sbom: SbomDocument;
  try {
    sbom = await store.readSbom(input.sbomRef);
  } catch {
    return {
      verificationState: "failed",
      failureCode: "sbom_unreadable",
      failureReason: "无法读取 SBOM",
    };
  }

  // 9. SBOM 阻断漏洞与阻断许可证校验
  let vulnerabilityCount = 0;
  let blockedLicenseCount = 0;
  for (const pkg of sbom.packages) {
    for (const vuln of pkg.vulnerabilities) {
      vulnerabilityCount++;
      if ((BLOCKED_VULNERABILITY_SEVERITIES as readonly string[]).includes(vuln.severity)) {
        return {
          verificationState: "failed",
          failureCode: "sbom_blocked_vulnerability",
          failureReason: `阻断漏洞: ${pkg.name}@${pkg.version} ${vuln.id} (${vuln.severity})`,
        };
      }
    }
    for (const license of pkg.licenses) {
      if ((BLOCKED_LICENSES as readonly string[]).includes(license)) {
        blockedLicenseCount++;
        return {
          verificationState: "failed",
          failureCode: "sbom_blocked_license",
          failureReason: `阻断许可证: ${pkg.name}@${pkg.version} ${license}`,
        };
      }
    }
  }

  // 10. 独立读取 provenance
  let provenance: ProvenanceDocument;
  try {
    provenance = await store.readProvenance(input.provenanceRef);
  } catch {
    return {
      verificationState: "failed",
      failureCode: "provenance_unreadable",
      failureReason: "无法读取 provenance",
    };
  }

  // 11. provenance 必填字段校验
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

  // 12. provenance buildTime 有效性校验
  if (Number.isNaN(Date.parse(provenance.buildTime))) {
    return {
      verificationState: "failed",
      failureCode: "provenance_buildtime_invalid",
      failureReason: "provenance buildTime 非有效 RFC 3339 时间",
    };
  }

  return {
    verificationState: "verified",
    provenanceSummary: {
      sourceRevision: provenance.sourceRevision,
      buildPipeline: provenance.buildPipeline,
      dependencyLockFile: provenance.dependencyLockFile,
      buildTime: provenance.buildTime,
    },
    scanSummary: {
      packagesScanned: sbom.packages.length,
      vulnerabilityCount,
      blockedLicenseCount,
    },
  };
}

// ─── Ed25519 Verification ──────────────────────────────────

/**
 * ed25519 验签（payload = artifactDigest 字符串）。
 *
 * 公钥是 base64 编码的 32 字节 raw ed25519 公钥，需手动包装为 SPKI DER（RFC 8410）。
 * 实现与 device-signature.ts 一致，但本模块独立维护以避免跨模块耦合。
 *
 * @throws Error 验签失败或公钥/签名格式错误
 */
function verifyEd25519Signature(
  publicKeyBase64: string,
  payload: string,
  signatureBase64: string,
): void {
  let signatureBuf: Buffer;
  try {
    signatureBuf = Buffer.from(signatureBase64, "base64");
  } catch {
    throw new Error("签名 base64 解码失败");
  }
  if (signatureBuf.length !== 64) {
    throw new Error(`ed25519 签名长度非 64 字节（实际 ${signatureBuf.length}）`);
  }

  let publicKeyBuf: Buffer;
  try {
    publicKeyBuf = Buffer.from(publicKeyBase64, "base64");
  } catch {
    throw new Error("公钥 base64 解码失败");
  }
  if (publicKeyBuf.length !== 32) {
    throw new Error(`ed25519 公钥长度非 32 字节（实际 ${publicKeyBuf.length}）`);
  }

  // SPKI DER 前缀 for ed25519（RFC 8410）：
  // 30 2a 30 05 06 03 2b 65 70 03 21 00 <32-byte key>
  const spkiPrefix = Buffer.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  const der = Buffer.concat([spkiPrefix, publicKeyBuf]);

  const pubkey = createPublicKey({ key: der, format: "der", type: "spki" });

  const isValid = verify(
    null, // ed25519 无算法参数
    Buffer.from(payload, "utf-8"),
    pubkey,
    signatureBuf,
  );
  if (!isValid) {
    throw new Error("ed25519 签名校验失败");
  }
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

export type { ArtifactType } from "@/lib/v11/schema/artifact";
export {
  ARTIFACT_TYPES,
  ATTESTATION_FAILURE_CODES,
  VERIFICATION_STATES,
} from "@/lib/v11/schema/artifact";
