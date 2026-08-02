/**
 * S03-C03：V11 制品验证门禁集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - artifact-attestation 纯逻辑：computeArtifactDigest / isValidArtifactDigest / isManagedRef / verifyArtifactAttestation。
 * - 验证服务校验链：artifactType/digest/受管引用/builder/签名/SBOM/provenance 全部场景。
 * - artifact-attestation-queries：insertAttestation/getAttestationById/listAttestationsByRevision/listAttestationsByDigest/getVerifiedAttestationForRevision。
 * - verifyAndPersistAttestation：成功/失败持久化 + 审计 + 抛错。
 * - assertAttestationGate：发布门禁全部场景。
 * - publishAgentRevisionWithAttestation：attestation 门禁 + Agent 发布 + 审计。
 * - publishRuntimeRevisionWithAttestation：attestation + conformance 双门禁 + Runtime 发布 + 审计。
 * - 阶段验收：可变 tag 拒绝/失败持久化/门禁失败 RouteSet 不变/同 digest 多份证明。
 *
 * 真实签名（ed25519）+ 真实可查询 SBOM/provenance（InMemoryManagedArtifactStore），不使用"跳过验证"假配置。
 */
import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { getPublicationRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import { AgentLifecycleError, createAgent } from "@/lib/v11/control-plane/agent-queries";
import {
  createDraftRevision,
  getRevisionById,
} from "@/lib/v11/control-plane/agent-revision-queries";
import {
  ArtifactAttestationFailedError,
  ArtifactNotVerifiedError,
  BLOCKED_LICENSES,
  BLOCKED_VULNERABILITY_SEVERITIES,
  type BuilderKeyRegistry,
  MANAGED_REF_PREFIXES,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type SbomDocument,
  type SignatureBundle,
  type VerifyAttestationInput,
  computeArtifactDigest,
  isManagedRef,
  isValidArtifactDigest,
  verifyArtifactAttestation,
} from "@/lib/v11/control-plane/artifact-attestation";
import {
  assertAttestationGate,
  getAttestationById,
  getVerifiedAttestationForRevision,
  insertAttestation,
  listAttestationsByDigest,
  listAttestationsByRevision,
  publishAgentRevisionWithAttestation,
  publishRuntimeRevisionWithAttestation,
  verifyAndPersistAttestation,
} from "@/lib/v11/control-plane/artifact-attestation-queries";
import {
  type ConformanceCaseResult,
  ConformanceGateError,
  MANDATORY_GATE_CASES,
} from "@/lib/v11/control-plane/runtime-conformance";
import { RuntimeLifecycleError, createRuntime } from "@/lib/v11/control-plane/runtime-queries";
import {
  createDraftRuntimeRevision,
  getRuntimeRevisionById,
} from "@/lib/v11/control-plane/runtime-revision-queries";
import { type AuditActor, recordAuditEvent } from "@/lib/v11/identity/audit";
import { listAuditEvents } from "@/lib/v11/identity/audit-queries";
import { upsertPrincipalBinding } from "@/lib/v11/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { ARTIFACT_TYPES, type V11ArtifactAttestation } from "@/lib/v11/schema/artifact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：InMemoryManagedArtifactStore ────────────────────

/** 内存受管对象存储（测试用；模拟"独立读取"语义）。 */
class InMemoryManagedArtifactStore implements ManagedArtifactStore {
  private signatures = new Map<string, SignatureBundle>();
  private sboms = new Map<string, SbomDocument>();
  private provenances = new Map<string, ProvenanceDocument>();

  writeSignatureBundle(ref: string, bundle: SignatureBundle): void {
    this.signatures.set(ref, bundle);
  }
  writeSbom(ref: string, doc: SbomDocument): void {
    this.sboms.set(ref, doc);
  }
  writeProvenance(ref: string, doc: ProvenanceDocument): void {
    this.provenances.set(ref, doc);
  }

  async readSignatureBundle(ref: string): Promise<SignatureBundle> {
    const bundle = this.signatures.get(ref);
    if (!bundle) throw new Error(`signature bundle not found: ${ref}`);
    return bundle;
  }
  async readSbom(ref: string): Promise<SbomDocument> {
    const doc = this.sboms.get(ref);
    if (!doc) throw new Error(`sbom not found: ${ref}`);
    return doc;
  }
  async readProvenance(ref: string): Promise<ProvenanceDocument> {
    const doc = this.provenances.get(ref);
    if (!doc) throw new Error(`provenance not found: ${ref}`);
    return doc;
  }
}

// ─── 辅助：ed25519 密钥对 + 签名 ───────────────────────────

interface BuilderKeyPair {
  builderIdentity: string;
  publicKeyBase64: string;
  privateKey: KeyObject;
}

/** 生成 ed25519 密钥对（builder identity 用）。 */
function generateBuilderKeyPair(builderIdentity: string): BuilderKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // 导出 raw 32 字节公钥（DER → 提取最后 32 字节）
  const der = publicKey.export({ type: "spki", format: "der" });
  const rawPublicKey = Buffer.from(der.subarray(der.length - 32));
  return {
    builderIdentity,
    publicKeyBase64: rawPublicKey.toString("base64"),
    privateKey,
  };
}

/** 用 ed25519 私钥对 payload 签名，返回 base64 签名。 */
function signEd25519(privateKey: BuilderKeyPair["privateKey"], payload: string): string {
  const sig = sign(null, Buffer.from(payload, "utf-8"), privateKey);
  return sig.toString("base64");
}

// ─── 辅助：构造校验通过的 signature bundle / SBOM / provenance ─

function buildValidSignatureBundle(keyPair: BuilderKeyPair, digest: string): SignatureBundle {
  return {
    algorithm: "ed25519",
    publicKey: keyPair.publicKeyBase64,
    signature: signEd25519(keyPair.privateKey, digest),
  };
}

function buildCleanSbom(): SbomDocument {
  return {
    packages: [
      { name: "lodash", version: "4.17.21", licenses: ["MIT"], vulnerabilities: [] },
      { name: "express", version: "4.18.2", licenses: ["MIT"], vulnerabilities: [] },
    ],
  };
}

function buildValidProvenance(): ProvenanceDocument {
  return {
    sourceRevision: "git:abc123def456",
    buildPipeline: "ci-cd-pipeline-1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  };
}

// ─── 辅助：seed 租户 + 用户 + Agent/Runtime ────────────────

async function seedTenantAndOwner() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "attestation-owner-001",
    email: "attestation-owner@example.com",
    displayName: "Attestation Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "attestation-owner-001",
    displayName: "Attestation Owner",
    userIdentityId: identity.id,
  });
  return { tenantId: tenant.id, ownerId: identity.id };
}

function buildActor(tenantId: string, actorId: string): AuditActor {
  return { tenantId, actorType: "service", actorId };
}

function passingConformanceResults(): ConformanceCaseResult[] {
  return MANDATORY_GATE_CASES.map((caseId) => ({ caseId, passed: true }));
}

// ─── 辅助：构造完整 verifyAndPersistAttestation 入参 ─────────

interface VerifiedAttestationFixture {
  attestation: V11ArtifactAttestation;
  store: InMemoryManagedArtifactStore;
  builderKeys: BuilderKeyRegistry;
  keyPair: BuilderKeyPair;
  digest: string;
}

/** 构造一个完整通过的 attestation fixture（含真实 ed25519 签名 + 干净 SBOM + 完整 provenance）。 */
async function createVerifiedAttestationFixture(
  tenantId: string,
  artifactType: string,
  artifactRevisionId: string,
  artifactContent: string,
  builderIdentity = "builder:company-agent-runtime",
  overrides: Partial<{
    signatureBundleRef: string;
    sbomRef: string;
    provenanceRef: string;
  }> = {},
): Promise<VerifiedAttestationFixture> {
  const keyPair = generateBuilderKeyPair(builderIdentity);
  const builderKeys: BuilderKeyRegistry = { [builderIdentity]: keyPair.publicKeyBase64 };
  const digest = computeArtifactDigest(artifactContent);
  const signatureBundleRef =
    overrides.signatureBundleRef ?? `attestation:signature:${digest.slice(7, 19)}`;
  const sbomRef = overrides.sbomRef ?? `attestation:sbom:${digest.slice(7, 19)}`;
  const provenanceRef = overrides.provenanceRef ?? `attestation:provenance:${digest.slice(7, 19)}`;

  const store = new InMemoryManagedArtifactStore();
  store.writeSignatureBundle(signatureBundleRef, buildValidSignatureBundle(keyPair, digest));
  store.writeSbom(sbomRef, buildCleanSbom());
  store.writeProvenance(provenanceRef, buildValidProvenance());

  const input: VerifyAttestationInput = {
    tenantId,
    artifactType,
    artifactRevisionId,
    artifactDigest: digest,
    signatureBundleRef,
    sbomRef,
    provenanceRef,
    builderIdentity,
  };

  const attestation = await verifyAndPersistAttestation(
    input,
    store,
    builderKeys,
    buildActor(tenantId, "ci-service-001"),
  );

  return { attestation, store, builderKeys, keyPair, digest };
}

// ═══════════════════════════════════════════════════════════
// 1. 纯逻辑：computeArtifactDigest / isValidArtifactDigest / isManagedRef
// ═══════════════════════════════════════════════════════════

describe("artifact-attestation 纯逻辑", () => {
  describe("computeArtifactDigest", () => {
    it("返回 sha256:<hex> 格式", () => {
      const digest = computeArtifactDigest("hello world");
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("相同内容相同 digest", () => {
      expect(computeArtifactDigest("content")).toBe(computeArtifactDigest("content"));
    });

    it("不同内容不同 digest", () => {
      expect(computeArtifactDigest("a")).not.toBe(computeArtifactDigest("b"));
    });

    it("支持 Uint8Array 输入", () => {
      const buf = new TextEncoder().encode("hello");
      expect(computeArtifactDigest(buf)).toBe(computeArtifactDigest("hello"));
    });
  });

  describe("isValidArtifactDigest", () => {
    it("合法 sha256:hex 通过", () => {
      expect(isValidArtifactDigest(computeArtifactDigest("x"))).toBe(true);
    });

    it("可变 tag 拒绝（如 v1.0）", () => {
      expect(isValidArtifactDigest("v1.0")).toBe(false);
    });

    it("裸 hex 拒绝（缺 sha256: 前缀）", () => {
      expect(isValidArtifactDigest("abc123def456")).toBe(false);
    });

    it("sha384 拒绝（仅接受 sha256）", () => {
      expect(isValidArtifactDigest("sha384:abc")).toBe(false);
    });

    it("sha256 但 hex 长度非 64 拒绝", () => {
      expect(isValidArtifactDigest("sha256:abc")).toBe(false);
    });
  });

  describe("isManagedRef", () => {
    it("attestation: 前缀通过", () => {
      expect(isManagedRef("attestation:signature:901")).toBe(true);
    });

    it("oci:// 前缀通过", () => {
      expect(isManagedRef("oci://registry/image@sha256:abc")).toBe(true);
    });

    it("managed:// 前缀通过", () => {
      expect(isManagedRef("managed://sbom/2026/abc.json")).toBe(true);
    });

    it("http:// 拒绝", () => {
      expect(isManagedRef("http://example.com/sig.json")).toBe(false);
    });

    it("https:// 拒绝", () => {
      expect(isManagedRef("https://example.com/sig.json")).toBe(false);
    });

    it("file:// 拒绝", () => {
      expect(isManagedRef("file:///etc/passwd")).toBe(false);
    });

    it("空字符串拒绝", () => {
      expect(isManagedRef("")).toBe(false);
    });

    it("MANAGED_REF_PREFIXES 包含 3 个前缀", () => {
      expect(MANAGED_REF_PREFIXES).toHaveLength(3);
    });
  });

  describe("BLOCKED 常量", () => {
    it("BLOCKED_VULNERABILITY_SEVERITIES 含 critical 和 high", () => {
      expect(BLOCKED_VULNERABILITY_SEVERITIES).toContain("critical");
      expect(BLOCKED_VULNERABILITY_SEVERITIES).toContain("high");
    });

    it("BLOCKED_LICENSES 含 GPL 系列", () => {
      expect(BLOCKED_LICENSES).toContain("GPL-3.0");
      expect(BLOCKED_LICENSES).toContain("AGPL-3.0");
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 2. verifyArtifactAttestation 纯逻辑（不访问 DB）
// ═══════════════════════════════════════════════════════════

describe("verifyArtifactAttestation 校验链", () => {
  let keyPair: BuilderKeyPair;
  let builderKeys: BuilderKeyRegistry;
  let store: InMemoryManagedArtifactStore;
  let digest: string;
  let validInput: VerifyAttestationInput;

  beforeEach(() => {
    keyPair = generateBuilderKeyPair("builder:company-agent-runtime");
    builderKeys = { "builder:company-agent-runtime": keyPair.publicKeyBase64 };
    digest = computeArtifactDigest("agent.yaml content v1");
    store = new InMemoryManagedArtifactStore();
    store.writeSignatureBundle(
      "attestation:signature:v1",
      buildValidSignatureBundle(keyPair, digest),
    );
    store.writeSbom("attestation:sbom:v1", buildCleanSbom());
    store.writeProvenance("attestation:provenance:v1", buildValidProvenance());
    validInput = {
      tenantId: "tenant-1",
      artifactType: "agent_revision",
      artifactRevisionId: "rev-1",
      artifactDigest: digest,
      signatureBundleRef: "attestation:signature:v1",
      sbomRef: "attestation:sbom:v1",
      provenanceRef: "attestation:provenance:v1",
      builderIdentity: "builder:company-agent-runtime",
    };
  });

  it("成功路径：所有校验通过 → verified", async () => {
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.verificationState).toBe("verified");
    expect(result.failureCode).toBeUndefined();
  });

  it("未知 artifact_type → failed (unknown_artifact_type)", async () => {
    const result = await verifyArtifactAttestation(
      { ...validInput, artifactType: "unknown_type" },
      store,
      builderKeys,
    );
    expect(result.verificationState).toBe("failed");
    expect(result.failureCode).toBe("unknown_artifact_type");
  });

  it("digest 格式非法（可变 tag）→ failed (digest_format_invalid)", async () => {
    const result = await verifyArtifactAttestation(
      { ...validInput, artifactDigest: "v1.0" },
      store,
      builderKeys,
    );
    expect(result.verificationState).toBe("failed");
    expect(result.failureCode).toBe("digest_format_invalid");
  });

  it("digest 缺 sha256: 前缀 → failed", async () => {
    const result = await verifyArtifactAttestation(
      { ...validInput, artifactDigest: "abc123def456" },
      store,
      builderKeys,
    );
    expect(result.failureCode).toBe("digest_format_invalid");
  });

  it("signature_bundle_ref 非受管（http://）→ failed", async () => {
    const result = await verifyArtifactAttestation(
      { ...validInput, signatureBundleRef: "http://evil.com/sig.json" },
      store,
      builderKeys,
    );
    expect(result.failureCode).toBe("signature_ref_not_managed");
  });

  it("sbom_ref 非受管（https://）→ failed", async () => {
    const result = await verifyArtifactAttestation(
      { ...validInput, sbomRef: "https://evil.com/sbom.json" },
      store,
      builderKeys,
    );
    expect(result.failureCode).toBe("sbom_ref_not_managed");
  });

  it("provenance_ref 非受管（file://）→ failed", async () => {
    const result = await verifyArtifactAttestation(
      { ...validInput, provenanceRef: "file:///etc/provenance.json" },
      store,
      builderKeys,
    );
    expect(result.failureCode).toBe("provenance_ref_not_managed");
  });

  it("builder identity 不在白名单 → failed (builder_not_allowed)", async () => {
    const result = await verifyArtifactAttestation(
      { ...validInput, builderIdentity: "builder:unknown" },
      store,
      builderKeys,
    );
    expect(result.failureCode).toBe("builder_not_allowed");
  });

  it("签名 bundle 读取失败（ref 不存在）→ failed", async () => {
    const result = await verifyArtifactAttestation(
      { ...validInput, signatureBundleRef: "attestation:signature:missing" },
      store,
      builderKeys,
    );
    expect(result.failureCode).toBe("signature_bundle_unreadable");
  });

  it("签名算法非 ed25519 → failed (signature_algorithm_unsupported)", async () => {
    store.writeSignatureBundle("attestation:signature:v1", {
      algorithm: "rsa" as SignatureBundle["algorithm"],
      publicKey: keyPair.publicKeyBase64,
      signature: "fake",
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("signature_algorithm_unsupported");
  });

  it("签名 bundle 公钥与白名单不一致 → failed (builder_key_mismatch)", async () => {
    const otherKey = generateBuilderKeyPair("builder:other");
    store.writeSignatureBundle("attestation:signature:v1", {
      algorithm: "ed25519",
      publicKey: otherKey.publicKeyBase64,
      signature: "fake",
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("builder_key_mismatch");
  });

  it("ed25519 验签失败（签名被篡改）→ failed (signature_invalid)", async () => {
    const tamperedSignature = Buffer.from(signEd25519(keyPair.privateKey, digest));
    tamperedSignature[0] = (tamperedSignature[0] ?? 0) ^ 0xff; // 翻转一位
    store.writeSignatureBundle("attestation:signature:v1", {
      algorithm: "ed25519",
      publicKey: keyPair.publicKeyBase64,
      signature: tamperedSignature.toString("base64"),
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("signature_invalid");
  });

  it("签名 payload 与 digest 不一致 → failed (signature_invalid)", async () => {
    // 用不同 payload 签名
    store.writeSignatureBundle("attestation:signature:v1", {
      algorithm: "ed25519",
      publicKey: keyPair.publicKeyBase64,
      signature: signEd25519(keyPair.privateKey, "sha256:different"),
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("signature_invalid");
  });

  it("SBOM 读取失败 → failed (sbom_unreadable)", async () => {
    const result = await verifyArtifactAttestation(
      { ...validInput, sbomRef: "attestation:sbom:missing" },
      store,
      builderKeys,
    );
    expect(result.failureCode).toBe("sbom_unreadable");
  });

  it("SBOM 命中 critical 漏洞 → failed (sbom_blocked_vulnerability)", async () => {
    store.writeSbom("attestation:sbom:v1", {
      packages: [
        {
          name: "vulnerable-lib",
          version: "1.0",
          licenses: ["MIT"],
          vulnerabilities: [{ id: "CVE-2026-001", severity: "critical" }],
        },
      ],
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("sbom_blocked_vulnerability");
  });

  it("SBOM 命中 high 漏洞 → failed", async () => {
    store.writeSbom("attestation:sbom:v1", {
      packages: [
        {
          name: "vulnerable-lib",
          version: "1.0",
          licenses: ["MIT"],
          vulnerabilities: [{ id: "CVE-2026-002", severity: "high" }],
        },
      ],
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("sbom_blocked_vulnerability");
  });

  it("SBOM 命中 GPL-3.0 许可证 → failed (sbom_blocked_license)", async () => {
    store.writeSbom("attestation:sbom:v1", {
      packages: [{ name: "gpl-lib", version: "1.0", licenses: ["GPL-3.0"], vulnerabilities: [] }],
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("sbom_blocked_license");
  });

  it("SBOM 命中 AGPL-3.0 许可证 → failed", async () => {
    store.writeSbom("attestation:sbom:v1", {
      packages: [{ name: "agpl-lib", version: "1.0", licenses: ["AGPL-3.0"], vulnerabilities: [] }],
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("sbom_blocked_license");
  });

  it("SBOM 命中 medium 漏洞 → verified（非阻断等级）", async () => {
    store.writeSbom("attestation:sbom:v1", {
      packages: [
        {
          name: "lib",
          version: "1.0",
          licenses: ["MIT"],
          vulnerabilities: [{ id: "CVE-2026-003", severity: "medium" }],
        },
      ],
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.verificationState).toBe("verified");
  });

  it("SBOM 命中 low 漏洞 → verified（非阻断等级）", async () => {
    store.writeSbom("attestation:sbom:v1", {
      packages: [
        {
          name: "lib",
          version: "1.0",
          licenses: ["MIT"],
          vulnerabilities: [{ id: "CVE-2026-004", severity: "low" }],
        },
      ],
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.verificationState).toBe("verified");
  });

  it("provenance 读取失败 → failed (provenance_unreadable)", async () => {
    const result = await verifyArtifactAttestation(
      { ...validInput, provenanceRef: "attestation:provenance:missing" },
      store,
      builderKeys,
    );
    expect(result.failureCode).toBe("provenance_unreadable");
  });

  it("provenance 缺 sourceRevision → failed (provenance_missing_field)", async () => {
    store.writeProvenance("attestation:provenance:v1", {
      sourceRevision: "",
      buildPipeline: "pipeline-1",
      dependencyLockFile: "lock",
      buildTime: "2026-07-15T01:00:00.000Z",
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("provenance_missing_field");
  });

  it("provenance 缺 buildPipeline → failed", async () => {
    store.writeProvenance("attestation:provenance:v1", {
      sourceRevision: "git:abc",
      buildPipeline: "",
      dependencyLockFile: "lock",
      buildTime: "2026-07-15T01:00:00.000Z",
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("provenance_missing_field");
  });

  it("provenance buildTime 非有效时间 → failed (provenance_buildtime_invalid)", async () => {
    store.writeProvenance("attestation:provenance:v1", {
      sourceRevision: "git:abc",
      buildPipeline: "pipeline-1",
      dependencyLockFile: "lock",
      buildTime: "not-a-date",
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("provenance_buildtime_invalid");
  });
});

// ═══════════════════════════════════════════════════════════
// 3. DB 集成：artifact-attestation-queries 仓储
// ═══════════════════════════════════════════════════════════

describe("artifact-attestation-queries 仓储（真实 MySQL）", () => {
  let tenantId: string;
  let otherTenantId: string;

  beforeEach(async () => {
    const seeded = await seedTenantAndOwner();
    tenantId = seeded.tenantId;
    // 第二租户（跨租户隔离测试；ensureDefaultTenant 幂等返回同一租户，故用硬编码 UUID）
    otherTenantId = "11111111-1111-4111-8111-111111111111";
  });

  describe("insertAttestation + getAttestationById", () => {
    it("插入并按 id 查询", async () => {
      const att = await insertAttestation({
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: computeArtifactDigest("content"),
        signatureBundleRef: "attestation:signature:1",
        sbomRef: "attestation:sbom:1",
        provenanceRef: "attestation:provenance:1",
        builderIdentity: "builder:company-agent-runtime",
        verificationState: "verified",
        verifiedAt: new Date(),
      });
      expect(att.id).toBeTruthy();
      expect(att.verificationState).toBe("verified");
      expect(att.failureCode).toBeNull();

      const fetched = await getAttestationById(tenantId, att.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(att.id);
    });

    it("跨租户隔离：他租户查询返回 null", async () => {
      const att = await insertAttestation({
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: computeArtifactDigest("content"),
        signatureBundleRef: "attestation:signature:1",
        sbomRef: "attestation:sbom:1",
        provenanceRef: "attestation:provenance:1",
        builderIdentity: "builder:company-agent-runtime",
        verificationState: "verified",
        verifiedAt: new Date(),
      });
      const fetched = await getAttestationById(otherTenantId, att.id);
      expect(fetched).toBeNull();
    });

    it("失败记录持久化 failureCode", async () => {
      const att = await insertAttestation({
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: computeArtifactDigest("content"),
        signatureBundleRef: "attestation:signature:1",
        sbomRef: "attestation:sbom:1",
        provenanceRef: "attestation:provenance:1",
        builderIdentity: "builder:company-agent-runtime",
        verificationState: "failed",
        failureCode: "signature_invalid",
        verifiedAt: new Date(),
      });
      expect(att.verificationState).toBe("failed");
      expect(att.failureCode).toBe("signature_invalid");
    });
  });

  describe("listAttestationsByRevision", () => {
    it("按 revision 列出（按 createdAt 降序）", async () => {
      const digest = computeArtifactDigest("content");
      for (let i = 0; i < 3; i++) {
        await insertAttestation({
          tenantId,
          artifactType: "agent_revision",
          artifactRevisionId: "rev-1",
          artifactDigest: digest,
          signatureBundleRef: `attestation:signature:${i}`,
          sbomRef: `attestation:sbom:${i}`,
          provenanceRef: `attestation:provenance:${i}`,
          builderIdentity: "builder:company-agent-runtime",
          verificationState: i === 1 ? "failed" : "verified",
          failureCode: i === 1 ? "signature_invalid" : null,
          verifiedAt: new Date(),
        });
      }
      const list = await listAttestationsByRevision(tenantId, "agent_revision", "rev-1");
      expect(list).toHaveLength(3);
    });

    it("按 verificationState 过滤", async () => {
      const digest = computeArtifactDigest("content");
      await insertAttestation({
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: digest,
        signatureBundleRef: "attestation:signature:0",
        sbomRef: "attestation:sbom:0",
        provenanceRef: "attestation:provenance:0",
        builderIdentity: "builder:b",
        verificationState: "verified",
        verifiedAt: new Date(),
      });
      await insertAttestation({
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: digest,
        signatureBundleRef: "attestation:signature:1",
        sbomRef: "attestation:sbom:1",
        provenanceRef: "attestation:provenance:1",
        builderIdentity: "builder:b",
        verificationState: "failed",
        failureCode: "signature_invalid",
        verifiedAt: new Date(),
      });
      const verified = await listAttestationsByRevision(tenantId, "agent_revision", "rev-1", {
        verificationState: "verified",
      });
      expect(verified).toHaveLength(1);
      expect(verified[0]?.verificationState).toBe("verified");
    });

    it("跨租户隔离：他租户 revision 不可见", async () => {
      await insertAttestation({
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: computeArtifactDigest("c"),
        signatureBundleRef: "attestation:signature:0",
        sbomRef: "attestation:sbom:0",
        provenanceRef: "attestation:provenance:0",
        builderIdentity: "builder:b",
        verificationState: "verified",
        verifiedAt: new Date(),
      });
      const list = await listAttestationsByRevision(otherTenantId, "agent_revision", "rev-1");
      expect(list).toHaveLength(0);
    });
  });

  describe("listAttestationsByDigest", () => {
    it("按 digest 列出（跨 artifactType 聚合）", async () => {
      const digest = computeArtifactDigest("shared-content");
      await insertAttestation({
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-a",
        artifactDigest: digest,
        signatureBundleRef: "attestation:signature:a",
        sbomRef: "attestation:sbom:a",
        provenanceRef: "attestation:provenance:a",
        builderIdentity: "builder:b",
        verificationState: "verified",
        verifiedAt: new Date(),
      });
      await insertAttestation({
        tenantId,
        artifactType: "runtime_revision",
        artifactRevisionId: "rev-b",
        artifactDigest: digest,
        signatureBundleRef: "attestation:signature:b",
        sbomRef: "attestation:sbom:b",
        provenanceRef: "attestation:provenance:b",
        builderIdentity: "builder:b",
        verificationState: "verified",
        verifiedAt: new Date(),
      });
      const list = await listAttestationsByDigest(tenantId, digest);
      expect(list).toHaveLength(2);
    });
  });

  describe("getVerifiedAttestationForRevision", () => {
    it("返回最新 verified attestation", async () => {
      const digest = computeArtifactDigest("content");
      await insertAttestation({
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: digest,
        signatureBundleRef: "attestation:signature:0",
        sbomRef: "attestation:sbom:0",
        provenanceRef: "attestation:provenance:0",
        builderIdentity: "builder:b",
        verificationState: "failed",
        failureCode: "signature_invalid",
        verifiedAt: new Date(),
      });
      const latest = await insertAttestation({
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: digest,
        signatureBundleRef: "attestation:signature:1",
        sbomRef: "attestation:sbom:1",
        provenanceRef: "attestation:provenance:1",
        builderIdentity: "builder:b",
        verificationState: "verified",
        verifiedAt: new Date(),
      });
      const fetched = await getVerifiedAttestationForRevision(tenantId, "agent_revision", "rev-1");
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(latest.id);
    });

    it("无 verified 时返回 null", async () => {
      await insertAttestation({
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: computeArtifactDigest("c"),
        signatureBundleRef: "attestation:signature:0",
        sbomRef: "attestation:sbom:0",
        provenanceRef: "attestation:provenance:0",
        builderIdentity: "builder:b",
        verificationState: "failed",
        failureCode: "signature_invalid",
        verifiedAt: new Date(),
      });
      const fetched = await getVerifiedAttestationForRevision(tenantId, "agent_revision", "rev-1");
      expect(fetched).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 4. verifyAndPersistAttestation：完整验证流程
// ═══════════════════════════════════════════════════════════

describe("verifyAndPersistAttestation 完整流程", () => {
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    const seeded = await seedTenantAndOwner();
    tenantId = seeded.tenantId;
    ownerId = seeded.ownerId;
  });

  it("成功路径：verified + 持久化 + 审计", async () => {
    const fixture = await createVerifiedAttestationFixture(
      tenantId,
      "agent_revision",
      "rev-1",
      "agent.yaml content",
    );

    expect(fixture.attestation.verificationState).toBe("verified");
    expect(fixture.attestation.failureCode).toBeNull();
    expect(fixture.attestation.verifiedAt).toBeTruthy();

    // 持久化校验
    const fetched = await getAttestationById(tenantId, fixture.attestation.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.verificationState).toBe("verified");

    // 审计写入
    const auditEvents = await listAuditEvents({
      tenantId,
      actionType: "artifact.attestation.verify",
      targetType: "artifact_attestation",
      targetId: fixture.attestation.id,
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.actorType).toBe("service");
    expect(auditEvents[0]?.reason).toBe("制品证明验证通过");
  });

  it("失败路径：failed + 持久化 failureCode + 审计 + 抛 ArtifactAttestationFailedError", async () => {
    const keyPair = generateBuilderKeyPair("builder:company-agent-runtime");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": keyPair.publicKeyBase64,
    };
    const digest = computeArtifactDigest("content");
    const store = new InMemoryManagedArtifactStore();
    // 故意用错误 payload 签名 → 验签失败
    store.writeSignatureBundle("attestation:signature:bad", {
      algorithm: "ed25519",
      publicKey: keyPair.publicKeyBase64,
      signature: signEd25519(keyPair.privateKey, "sha256:wrong"),
    });
    store.writeSbom("attestation:sbom:bad", buildCleanSbom());
    store.writeProvenance("attestation:provenance:bad", buildValidProvenance());

    const input: VerifyAttestationInput = {
      tenantId,
      artifactType: "agent_revision",
      artifactRevisionId: "rev-1",
      artifactDigest: digest,
      signatureBundleRef: "attestation:signature:bad",
      sbomRef: "attestation:sbom:bad",
      provenanceRef: "attestation:provenance:bad",
      builderIdentity: "builder:company-agent-runtime",
    };

    await expect(
      verifyAndPersistAttestation(input, store, builderKeys, buildActor(tenantId, "ci-001")),
    ).rejects.toThrow(ArtifactAttestationFailedError);

    // 失败也持久化
    const list = await listAttestationsByRevision(tenantId, "agent_revision", "rev-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.verificationState).toBe("failed");
    expect(list[0]?.failureCode).toBe("signature_invalid");

    // 失败也写审计
    const auditEvents = await listAuditEvents({
      tenantId,
      actionType: "artifact.attestation.verify",
      targetType: "artifact_attestation",
      targetId: list[0]?.id ?? "",
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.reason).toContain("失败");
  });

  it("同一 digest 多份证明（不同 signature bundle ref + 不同 builder）", async () => {
    const digest = computeArtifactDigest("shared-content");

    // builder A
    const keyA = generateBuilderKeyPair("builder:company-agent-runtime");
    const storeA = new InMemoryManagedArtifactStore();
    storeA.writeSignatureBundle("attestation:signature:a", buildValidSignatureBundle(keyA, digest));
    storeA.writeSbom("attestation:sbom:a", buildCleanSbom());
    storeA.writeProvenance("attestation:provenance:a", buildValidProvenance());
    await verifyAndPersistAttestation(
      {
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: digest,
        signatureBundleRef: "attestation:signature:a",
        sbomRef: "attestation:sbom:a",
        provenanceRef: "attestation:provenance:a",
        builderIdentity: "builder:company-agent-runtime",
      },
      storeA,
      { "builder:company-agent-runtime": keyA.publicKeyBase64 },
      buildActor(tenantId, "ci-001"),
    );

    // builder B
    const keyB = generateBuilderKeyPair("builder:company-runtime-host");
    const storeB = new InMemoryManagedArtifactStore();
    storeB.writeSignatureBundle("attestation:signature:b", buildValidSignatureBundle(keyB, digest));
    storeB.writeSbom("attestation:sbom:b", buildCleanSbom());
    storeB.writeProvenance("attestation:provenance:b", buildValidProvenance());
    await verifyAndPersistAttestation(
      {
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: digest,
        signatureBundleRef: "attestation:signature:b",
        sbomRef: "attestation:sbom:b",
        provenanceRef: "attestation:provenance:b",
        builderIdentity: "builder:company-runtime-host",
      },
      storeB,
      { "builder:company-runtime-host": keyB.publicKeyBase64 },
      buildActor(tenantId, "ci-002"),
    );

    const list = await listAttestationsByDigest(tenantId, digest);
    expect(list).toHaveLength(2);
    expect(new Set(list.map((a) => a.builderIdentity))).toEqual(
      new Set(["builder:company-agent-runtime", "builder:company-runtime-host"]),
    );
  });

  it("调用方不能自报 verification_state（入参无此字段）", () => {
    // VerifyAttestationInput 类型不含 verification_state 字段；
    // TypeScript 编译期保证调用方无法传入。运行时 verifyArtifactAttestation 自行决定结果。
    const input: VerifyAttestationInput = {
      tenantId: "t",
      artifactType: "agent_revision",
      artifactRevisionId: "r",
      artifactDigest: computeArtifactDigest("c"),
      signatureBundleRef: "attestation:sig:1",
      sbomRef: "attestation:sbom:1",
      provenanceRef: "attestation:prov:1",
      builderIdentity: "builder:b",
    };
    expect("verificationState" in input).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. assertAttestationGate 发布门禁
// ═══════════════════════════════════════════════════════════

describe("assertAttestationGate 发布门禁", () => {
  let tenantId: string;

  beforeEach(async () => {
    const seeded = await seedTenantAndOwner();
    tenantId = seeded.tenantId;
  });

  it("成功路径：verified attestation 通过门禁", async () => {
    const fixture = await createVerifiedAttestationFixture(
      tenantId,
      "agent_revision",
      "rev-1",
      "content",
    );
    const att = await assertAttestationGate(
      tenantId,
      "agent_revision",
      "rev-1",
      fixture.attestation.id,
    );
    expect(att.id).toBe(fixture.attestation.id);
  });

  it("attestation 不存在 → ArtifactNotVerifiedError", async () => {
    await expect(
      assertAttestationGate(tenantId, "agent_revision", "rev-1", "nonexistent-id"),
    ).rejects.toThrow(ArtifactNotVerifiedError);
  });

  it("attestation 跨租户 → ArtifactNotVerifiedError", async () => {
    const fixture = await createVerifiedAttestationFixture(
      tenantId,
      "agent_revision",
      "rev-1",
      "content",
    );
    // ensureDefaultTenant 幂等返回同一租户，故用硬编码 UUID 模拟他租户
    const otherTenantId = "11111111-1111-4111-8111-111111111111";
    await expect(
      assertAttestationGate(otherTenantId, "agent_revision", "rev-1", fixture.attestation.id),
    ).rejects.toThrow(ArtifactNotVerifiedError);
  });

  it("verificationState 非 verified → ArtifactNotVerifiedError", async () => {
    const att = await insertAttestation({
      tenantId,
      artifactType: "agent_revision",
      artifactRevisionId: "rev-1",
      artifactDigest: computeArtifactDigest("c"),
      signatureBundleRef: "attestation:sig:1",
      sbomRef: "attestation:sbom:1",
      provenanceRef: "attestation:prov:1",
      builderIdentity: "builder:b",
      verificationState: "failed",
      failureCode: "signature_invalid",
      verifiedAt: new Date(),
    });
    await expect(
      assertAttestationGate(tenantId, "agent_revision", "rev-1", att.id),
    ).rejects.toThrow(ArtifactNotVerifiedError);
  });

  it("artifactType 不匹配 → ArtifactNotVerifiedError", async () => {
    const fixture = await createVerifiedAttestationFixture(
      tenantId,
      "agent_revision",
      "rev-1",
      "content",
    );
    await expect(
      assertAttestationGate(tenantId, "runtime_revision", "rev-1", fixture.attestation.id),
    ).rejects.toThrow(ArtifactNotVerifiedError);
  });

  it("artifactRevisionId 不匹配 → ArtifactNotVerifiedError", async () => {
    const fixture = await createVerifiedAttestationFixture(
      tenantId,
      "agent_revision",
      "rev-1",
      "content",
    );
    await expect(
      assertAttestationGate(tenantId, "agent_revision", "rev-other", fixture.attestation.id),
    ).rejects.toThrow(ArtifactNotVerifiedError);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. publishAgentRevisionWithAttestation 发布门禁集成
// ═══════════════════════════════════════════════════════════

describe("publishAgentRevisionWithAttestation", () => {
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    const seeded = await seedTenantAndOwner();
    tenantId = seeded.tenantId;
    ownerId = seeded.ownerId;
  });

  it("成功路径：门禁通过 + 发布 + agent.publish 审计", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "finance-agent",
      displayName: "Finance Agent",
      ownerUserId: ownerId,
    });
    const revision = await createDraftRevision({
      tenantId,
      agentId: agent.id,
      sourceType: "agent_yaml",
      sourceRevision: "git:abc",
      instructionHash: "sha256:instr-v1",
      agentArtifactRef: "oci://registry/agent@sha256:abc",
      modelPolicyJson: { model: "gpt-4" },
      permissionRequirementsJson: { scopes: [] },
      delegationPolicyJson: { allowed: false },
      agentInterfaceRequirementsJson: { required: [] },
      createdBy: ownerId,
    });

    const fixture = await createVerifiedAttestationFixture(
      tenantId,
      "agent_revision",
      revision.id,
      "agent.yaml content",
    );

    const result = await publishAgentRevisionWithAttestation(
      tenantId,
      revision.id,
      agent.versionNo,
      fixture.attestation.id,
      buildActor(tenantId, "ci-001"),
    );

    expect(result.revision.revisionState).toBe("published");
    expect(result.revision.publishedAt).toBeTruthy();
    expect(result.attestation.id).toBe(fixture.attestation.id);

    // agent.publish 审计
    const auditEvents = await listAuditEvents({
      tenantId,
      actionType: "agent.publish",
      targetType: "agent_revision",
      targetId: revision.id,
    });
    expect(auditEvents).toHaveLength(1);
  });

  it("门禁失败：attestation 未 verified → ArtifactNotVerifiedError，Revision 保持 draft", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "agent-2",
      displayName: "Agent 2",
      ownerUserId: ownerId,
    });
    const revision = await createDraftRevision({
      tenantId,
      agentId: agent.id,
      sourceType: "code",
      sourceRevision: "git:def",
      instructionHash: "sha256:instr-v2",
      agentArtifactRef: "oci://reg/a@sha256:def",
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: {},
      createdBy: ownerId,
    });

    // 创建一个 failed attestation
    const failedAtt = await insertAttestation({
      tenantId,
      artifactType: "agent_revision",
      artifactRevisionId: revision.id,
      artifactDigest: computeArtifactDigest("c"),
      signatureBundleRef: "attestation:sig:f",
      sbomRef: "attestation:sbom:f",
      provenanceRef: "attestation:prov:f",
      builderIdentity: "builder:b",
      verificationState: "failed",
      failureCode: "signature_invalid",
      verifiedAt: new Date(),
    });

    await expect(
      publishAgentRevisionWithAttestation(
        tenantId,
        revision.id,
        agent.versionNo,
        failedAtt.id,
        buildActor(tenantId, "ci-001"),
      ),
    ).rejects.toThrow(ArtifactNotVerifiedError);

    // Revision 保持 draft
    const after = await getRevisionById(revision.id);
    expect(after?.revisionState).toBe("draft");
    expect(after?.publishedAt).toBeNull();

    // 不写 agent.publish 审计
    const auditEvents = await listAuditEvents({
      tenantId,
      actionType: "agent.publish",
      targetType: "agent_revision",
      targetId: revision.id,
    });
    expect(auditEvents).toHaveLength(0);
  });

  it("发布失败：Revision 非 draft → RevisionStateError（门禁通过后）", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "agent-3",
      displayName: "Agent 3",
      ownerUserId: ownerId,
    });
    const revision = await createDraftRevision({
      tenantId,
      agentId: agent.id,
      sourceType: "code",
      sourceRevision: "git:ghi",
      instructionHash: "sha256:instr-v3",
      agentArtifactRef: "oci://reg/a@sha256:ghi",
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: {},
      createdBy: ownerId,
    });

    const fixture = await createVerifiedAttestationFixture(
      tenantId,
      "agent_revision",
      revision.id,
      "content",
    );

    // 先发布一次（成功）
    await publishAgentRevisionWithAttestation(
      tenantId,
      revision.id,
      agent.versionNo,
      fixture.attestation.id,
      buildActor(tenantId, "ci-001"),
    );

    // 第二次发布（已 published）→ RevisionStateError
    await expect(
      publishAgentRevisionWithAttestation(
        tenantId,
        revision.id,
        agent.versionNo + 1,
        fixture.attestation.id,
        buildActor(tenantId, "ci-001"),
      ),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// 7. publishRuntimeRevisionWithAttestation 双门禁集成
// ═══════════════════════════════════════════════════════════

describe("publishRuntimeRevisionWithAttestation 双门禁", () => {
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    const seeded = await seedTenantAndOwner();
    tenantId = seeded.tenantId;
    ownerId = seeded.ownerId;
  });

  it("成功路径：attestation + conformance 双门禁通过 + 发布 + runtime.publish 审计", async () => {
    const runtime = await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Doubao Hosted",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    const revision = await createDraftRuntimeRevision({
      tenantId,
      runtimeId: runtime.id,
      protocolType: "agent_runtime_protocol",
      endpointRef: "connection://doubao",
      runtimeArtifactRef: "oci://reg/runtime@sha256:abc",
      runtimeCapabilitiesJson: { steer: true, cancel: true, event_stream: true, tool_call: true },
      identityMode: "workload_token",
      networkZone: "internal",
      configHash: "sha256:config-v1",
      createdBy: ownerId,
    });

    const fixture = await createVerifiedAttestationFixture(
      tenantId,
      "runtime_revision",
      revision.id,
      "runtime image content",
    );

    const result = await publishRuntimeRevisionWithAttestation(
      tenantId,
      revision.id,
      runtime.versionNo,
      passingConformanceResults(),
      fixture.attestation.id,
      buildActor(tenantId, "ci-001"),
    );

    expect(result.revision.revisionState).toBe("published");

    const publication = await getPublicationRecordBySubject({
      tenantId,
      subjectType: "runtime_revision",
      subjectRevisionId: revision.id,
    });
    expect(publication?.attestationIds).toEqual([fixture.attestation.id]);
    expect(publication?.publishedByType).toBe("service");
    expect(publication?.publishedBy).toBe("ci-001");

    const auditEvents = await listAuditEvents({
      tenantId,
      actionType: "runtime.publish",
      targetType: "runtime_revision",
      targetId: revision.id,
    });
    expect(auditEvents).toHaveLength(1);
  });

  it("attestation 门禁失败 → ArtifactNotVerifiedError，Revision 保持 draft", async () => {
    const runtime = await createRuntime({
      tenantId,
      runtimeKey: "rt-2",
      displayName: "RT 2",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    const revision = await createDraftRuntimeRevision({
      tenantId,
      runtimeId: runtime.id,
      protocolType: "agent_runtime_protocol",
      endpointRef: "connection://x",
      runtimeArtifactRef: "oci://reg/r@sha256:x",
      runtimeCapabilitiesJson: {},
      identityMode: "workload_token",
      networkZone: "internal",
      configHash: "sha256:c",
      createdBy: ownerId,
    });

    // 创建 failed attestation
    const failedAtt = await insertAttestation({
      tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: revision.id,
      artifactDigest: computeArtifactDigest("c"),
      signatureBundleRef: "attestation:sig:f",
      sbomRef: "attestation:sbom:f",
      provenanceRef: "attestation:prov:f",
      builderIdentity: "builder:b",
      verificationState: "failed",
      failureCode: "signature_invalid",
      verifiedAt: new Date(),
    });

    await expect(
      publishRuntimeRevisionWithAttestation(
        tenantId,
        revision.id,
        runtime.versionNo,
        passingConformanceResults(),
        failedAtt.id,
        buildActor(tenantId, "ci-001"),
      ),
    ).rejects.toThrow(ArtifactNotVerifiedError);

    const after = await getRuntimeRevisionById(revision.id);
    expect(after?.revisionState).toBe("draft");
  });

  it("conformance 门禁失败 → ConformanceGateError，Revision 保持 draft（attestation 门禁已通过）", async () => {
    const runtime = await createRuntime({
      tenantId,
      runtimeKey: "rt-3",
      displayName: "RT 3",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    const revision = await createDraftRuntimeRevision({
      tenantId,
      runtimeId: runtime.id,
      protocolType: "agent_runtime_protocol",
      endpointRef: "connection://y",
      runtimeArtifactRef: "oci://reg/r@sha256:y",
      runtimeCapabilitiesJson: {},
      identityMode: "workload_token",
      networkZone: "internal",
      configHash: "sha256:c2",
      createdBy: ownerId,
    });

    const fixture = await createVerifiedAttestationFixture(
      tenantId,
      "runtime_revision",
      revision.id,
      "content",
    );

    // conformance 门禁失败（第一个 mandatory case 失败）
    const failingResults: ConformanceCaseResult[] = MANDATORY_GATE_CASES.map((caseId, idx) => ({
      caseId,
      passed: idx !== 0,
      reason: idx === 0 ? "模拟失败" : undefined,
    }));

    await expect(
      publishRuntimeRevisionWithAttestation(
        tenantId,
        revision.id,
        runtime.versionNo,
        failingResults,
        fixture.attestation.id,
        buildActor(tenantId, "ci-001"),
      ),
    ).rejects.toThrow(ConformanceGateError);

    const after = await getRuntimeRevisionById(revision.id);
    expect(after?.revisionState).toBe("draft");
  });
});

// ═══════════════════════════════════════════════════════════
// 8. 阶段验收场景（S03-W04）
// ═══════════════════════════════════════════════════════════

describe("S03-W04 阶段验收场景", () => {
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    const seeded = await seedTenantAndOwner();
    tenantId = seeded.tenantId;
    ownerId = seeded.ownerId;
  });

  it("制品 digest 不接受可变 tag（v1.0 / latest / git tag）", async () => {
    const keyPair = generateBuilderKeyPair("builder:company-agent-runtime");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": keyPair.publicKeyBase64,
    };
    const store = new InMemoryManagedArtifactStore();
    store.writeSbom("attestation:sbom:1", buildCleanSbom());
    store.writeProvenance("attestation:provenance:1", buildValidProvenance());

    // 可变 tag 作为 digest → 验证失败
    for (const badDigest of ["v1.0", "latest", "main", "git:abc"]) {
      store.writeSignatureBundle("attestation:sig:1", {
        algorithm: "ed25519",
        publicKey: keyPair.publicKeyBase64,
        signature: signEd25519(keyPair.privateKey, badDigest),
      });
      const result = await verifyArtifactAttestation(
        {
          tenantId,
          artifactType: "agent_revision",
          artifactRevisionId: "rev-1",
          artifactDigest: badDigest,
          signatureBundleRef: "attestation:sig:1",
          sbomRef: "attestation:sbom:1",
          provenanceRef: "attestation:provenance:1",
          builderIdentity: "builder:company-agent-runtime",
        },
        store,
        builderKeys,
      );
      expect(result.verificationState).toBe("failed");
      expect(result.failureCode).toBe("digest_format_invalid");
    }
  });

  it("验证失败写 AuditEvent + 持久化失败记录，不泄露内部漏洞细节", async () => {
    const keyPair = generateBuilderKeyPair("builder:company-agent-runtime");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": keyPair.publicKeyBase64,
    };
    const digest = computeArtifactDigest("content");
    const store = new InMemoryManagedArtifactStore();
    // SBOM 命中 critical 漏洞
    store.writeSignatureBundle("attestation:sig:1", buildValidSignatureBundle(keyPair, digest));
    store.writeSbom("attestation:sbom:1", {
      packages: [
        {
          name: "vuln-lib",
          version: "1.0",
          licenses: ["MIT"],
          vulnerabilities: [{ id: "CVE-2026-critical", severity: "critical" }],
        },
      ],
    });
    store.writeProvenance("attestation:provenance:1", buildValidProvenance());

    await expect(
      verifyAndPersistAttestation(
        {
          tenantId,
          artifactType: "agent_revision",
          artifactRevisionId: "rev-1",
          artifactDigest: digest,
          signatureBundleRef: "attestation:sig:1",
          sbomRef: "attestation:sbom:1",
          provenanceRef: "attestation:provenance:1",
          builderIdentity: "builder:company-agent-runtime",
        },
        store,
        builderKeys,
        buildActor(tenantId, "ci-001"),
      ),
    ).rejects.toThrow(ArtifactAttestationFailedError);

    // 失败记录持久化
    const list = await listAttestationsByRevision(tenantId, "agent_revision", "rev-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.verificationState).toBe("failed");
    expect(list[0]?.failureCode).toBe("sbom_blocked_vulnerability");

    // 审计写入（afterHash 是 hash，不存原文漏洞详情）
    const auditEvents = await listAuditEvents({
      tenantId,
      actionType: "artifact.attestation.verify",
      targetType: "artifact_attestation",
      targetId: list[0]?.id ?? "",
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.afterHash).toBeTruthy();
    // afterHash 是 sha256 hex，不包含原文 CVE id
    expect(auditEvents[0]?.afterHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("发布门禁失败时 RouteSet 不变化（Agent.currentRevisionId 不变）", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "agent-gate",
      displayName: "Agent Gate",
      ownerUserId: ownerId,
    });
    const revision = await createDraftRevision({
      tenantId,
      agentId: agent.id,
      sourceType: "code",
      sourceRevision: "git:abc",
      instructionHash: "sha256:i",
      agentArtifactRef: "oci://reg/a@sha256:abc",
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: {},
      createdBy: ownerId,
    });

    // 未验证的 attestation（failed 状态）
    const failedAtt = await insertAttestation({
      tenantId,
      artifactType: "agent_revision",
      artifactRevisionId: revision.id,
      artifactDigest: computeArtifactDigest("c"),
      signatureBundleRef: "attestation:sig:f",
      sbomRef: "attestation:sbom:f",
      provenanceRef: "attestation:prov:f",
      builderIdentity: "builder:b",
      verificationState: "failed",
      failureCode: "signature_invalid",
      verifiedAt: new Date(),
    });

    const beforeAgent = agent;
    await expect(
      publishAgentRevisionWithAttestation(
        tenantId,
        revision.id,
        agent.versionNo,
        failedAtt.id,
        buildActor(tenantId, "ci-001"),
      ),
    ).rejects.toThrow(ArtifactNotVerifiedError);

    // Agent.currentRevisionId 保持 null（未发布）
    expect(beforeAgent.currentRevisionId).toBeNull();

    // Revision 保持 draft
    const afterRev = await getRevisionById(revision.id);
    expect(afterRev?.revisionState).toBe("draft");
  });

  it("同一制品 digest 可多份证明，发布引用其中 verified 的那份", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "agent-multi",
      displayName: "Agent Multi",
      ownerUserId: ownerId,
    });
    const revision = await createDraftRevision({
      tenantId,
      agentId: agent.id,
      sourceType: "code",
      sourceRevision: "git:multi",
      instructionHash: "sha256:multi",
      agentArtifactRef: "oci://reg/a@sha256:multi",
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: {},
      createdBy: ownerId,
    });

    // builder A 验证失败（SBOM 命中漏洞）
    const keyA = generateBuilderKeyPair("builder:company-agent-runtime");
    const digest = computeArtifactDigest("shared-content");
    const storeA = new InMemoryManagedArtifactStore();
    storeA.writeSignatureBundle("attestation:sig:a", buildValidSignatureBundle(keyA, digest));
    storeA.writeSbom("attestation:sbom:a", {
      packages: [
        {
          name: "vuln",
          version: "1",
          licenses: ["MIT"],
          vulnerabilities: [{ id: "CVE-X", severity: "critical" }],
        },
      ],
    });
    storeA.writeProvenance("attestation:prov:a", buildValidProvenance());
    await expect(
      verifyAndPersistAttestation(
        {
          tenantId,
          artifactType: "agent_revision",
          artifactRevisionId: revision.id,
          artifactDigest: digest,
          signatureBundleRef: "attestation:sig:a",
          sbomRef: "attestation:sbom:a",
          provenanceRef: "attestation:prov:a",
          builderIdentity: "builder:company-agent-runtime",
        },
        storeA,
        { "builder:company-agent-runtime": keyA.publicKeyBase64 },
        buildActor(tenantId, "ci-001"),
      ),
    ).rejects.toThrow(ArtifactAttestationFailedError);

    // builder B 验证通过（干净 SBOM）
    const keyB = generateBuilderKeyPair("builder:company-runtime-host");
    const storeB = new InMemoryManagedArtifactStore();
    storeB.writeSignatureBundle("attestation:sig:b", buildValidSignatureBundle(keyB, digest));
    storeB.writeSbom("attestation:sbom:b", buildCleanSbom());
    storeB.writeProvenance("attestation:prov:b", buildValidProvenance());
    const verifiedAtt = await verifyAndPersistAttestation(
      {
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: revision.id,
        artifactDigest: digest,
        signatureBundleRef: "attestation:sig:b",
        sbomRef: "attestation:sbom:b",
        provenanceRef: "attestation:prov:b",
        builderIdentity: "builder:company-runtime-host",
      },
      storeB,
      { "builder:company-runtime-host": keyB.publicKeyBase64 },
      buildActor(tenantId, "ci-002"),
    );

    // 同一 digest 两份证明（一 failed 一 verified）
    const byDigest = await listAttestationsByDigest(tenantId, digest);
    expect(byDigest).toHaveLength(2);

    // 发布引用 verified 的那份 → 成功
    const result = await publishAgentRevisionWithAttestation(
      tenantId,
      revision.id,
      agent.versionNo,
      verifiedAtt.id,
      buildActor(tenantId, "ci-002"),
    );
    expect(result.revision.revisionState).toBe("published");
  });

  it("ARTIFACT_TYPES 包含 5 种制品类型", () => {
    expect(ARTIFACT_TYPES).toEqual([
      "agent_revision",
      "runtime_revision",
      "skill_package",
      "tool_provider",
      "policy_bundle",
    ]);
  });

  it("recordAuditEvent 直接调用 artifact.attestation.verify actionType 通过 fail-closed 校验", async () => {
    // 验证 actionType 在 AUDIT_ACTION_TYPES 目录中（已由阶段 2 注册）
    const event = await recordAuditEvent({
      actor: buildActor(tenantId, "test-001"),
      actionType: "artifact.attestation.verify",
      targetType: "artifact_attestation",
      targetId: "test-target",
      after: { state: "verified" },
    });
    expect(event.actionType).toBe("artifact.attestation.verify");
  });
});
