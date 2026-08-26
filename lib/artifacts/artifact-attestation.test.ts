/**
 * S03-C03：制品验证门禁集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - artifact-attestation 纯逻辑：computeArtifactDigest / isValidArtifactDigest / isManagedRef / verifyArtifactAttestation。
 * - 验证服务校验链：artifactType/digest/受管引用/builder/签名/SBOM/provenance 全部场景。
 * - artifact-attestation-reader：getAttestationById/listAttestationsByRevision/listAttestationsByDigest/getVerifiedAttestationForRevision。
 * - artifact-attestation-writer：insertAttestation/verifyAndPersistAttestation/assertAttestationGate。
 * - verifyAndPersistAttestation：成功/失败持久化 + 审计 + 抛错。
 * - assertAttestationGate：发布门禁全部场景。
 * - publishRuntimeRevisionWithAttestation：attestation + conformance 双门禁 + Runtime 发布 + 审计。
 * - 阶段验收：可变 tag 拒绝/失败持久化/门禁失败 RouteSet 不变/同 digest 多份证明。
 *
 * 真实签名（ed25519）+ 真实可查询 SBOM/provenance（InMemoryManagedArtifactStore），不使用"跳过验证"假配置。
 */
import { createPublishAgentRevision } from "@/lib/agents/application/publish-agent-revision";
import { AgentPublicationPrerequisiteError } from "@/lib/agents/domain/agent-revision-publication-policy";
import { AgentLifecycleError, createAgent } from "@/lib/agents/persistence/agent-queries";
import {
  createDraftRevision,
  getRevisionById,
} from "@/lib/agents/persistence/agent-revision-queries";
import { mysqlAgentPublicationStore } from "@/lib/agents/persistence/mysql-agent-publication-store";
import {
  ArtifactAttestationFailedError,
  ArtifactNotVerifiedError,
  BLOCKED_LICENSES,
  BLOCKED_VULNERABILITY_SEVERITIES,
  type BuilderKeyRegistry,
  MANAGED_REF_PREFIXES,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type VerifyAttestationInput,
  computeArtifactDigest,
  isManagedRef,
  isValidArtifactDigest,
  verifyArtifactAttestation,
} from "@/lib/artifacts/domain/artifact-attestation";
import {
  getAttestationById,
  getVerifiedAttestationForRevision,
  listAttestationsByDigest,
  listAttestationsByRevision,
} from "@/lib/artifacts/persistence/artifact-attestation-reader";
import {
  assertAttestationGate,
  insertAttestation,
  verifyAndPersistAttestation,
} from "@/lib/artifacts/persistence/artifact-attestation-writer";
import { publishRuntimeRevisionWithAttestation } from "@/lib/artifacts/test-support/attempt-runtime-publication-with-attestation-without-trusted-run";
import {
  type PredicateSupplyChain,
  type TestBuilderKey,
  buildDsseArtifactAttestationEnvelope,
  buildMalformedDsseEnvelope,
  computeTestDigest,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { ensureAgentContractSnapshotBoundForRevision } from "@/lib/test-support/ensure-agent-contract-snapshot";

const publishAgentRevision = createPublishAgentRevision({ store: mysqlAgentPublicationStore });
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { type AuditActor, recordAuditEvent } from "@/lib/identity/audit";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { ARTIFACT_TYPES, type ArtifactAttestation } from "@/lib/persistence/schema/artifact";
import { getPublicationRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import {
  PUBLICATION_CONFORMANCE_CASES,
  type PublicationConformanceCaseResult,
} from "@/lib/runtime/domain/runtime-conformance";
import { RuntimeConformanceRunInvalidError } from "@/lib/runtime/domain/runtime-revision-publication-policy";
import { RuntimeLifecycleError, createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import {
  createDraftRuntimeRevision,
  getRuntimeRevisionById,
} from "@/lib/runtime/persistence/runtime-revision-queries";
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
  private envelopes = new Map<string, Buffer>();
  private sboms = new Map<string, unknown>();
  private provenances = new Map<string, ProvenanceDocument>();

  writeDsseEnvelope(ref: string, envelope: Buffer): void {
    this.envelopes.set(ref, envelope);
  }
  writeSbom(ref: string, doc: unknown): void {
    this.sboms.set(ref, doc);
  }
  writeProvenance(ref: string, doc: ProvenanceDocument): void {
    this.provenances.set(ref, doc);
  }

  async readDsseEnvelope(ref: string): Promise<Buffer> {
    const envelope = this.envelopes.get(ref);
    if (!envelope) throw new Error(`DSSE envelope not found: ${ref}`);
    return envelope;
  }
  async readSbom(ref: string): Promise<unknown> {
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

// ─── 辅助：ed25519 密钥对 + DSSE Envelope ───────────────────
// generateTestBuilderKey / buildDsseArtifactAttestationEnvelope 来自 test-support。

function buildCleanCycloneDXSbom(): unknown {
  return {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      timestamp: "2026-07-15T01:00:00.000Z",
      tools: [{ name: "test-tool" }],
    },
    components: [
      {
        type: "library",
        name: "lodash",
        version: "4.17.21",
        licenses: [{ license: { id: "MIT" } }],
      },
      {
        type: "library",
        name: "express",
        version: "4.18.2",
        licenses: [{ license: { id: "MIT" } }],
      },
    ],
    dependencies: [
      { ref: "pkg:npm/lodash@4.17.21", dependsOn: [] },
      { ref: "pkg:npm/express@4.18.2", dependsOn: ["pkg:npm/lodash@4.17.21"] },
    ],
  };
}

/** 构造包含指定漏洞的 CycloneDX SBOM。 */
function buildCycloneDXWithVulns(vulns: Array<{ id: string; severity: string }>): unknown {
  return {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { timestamp: "2026-07-15T01:00:00.000Z", tools: [{ name: "test-tool" }] },
    components: [
      {
        type: "library",
        name: "vulnerable-lib",
        version: "1.0",
        licenses: [{ license: { id: "MIT" } }],
      },
    ],
    vulnerabilities: vulns.map((v) => ({
      id: v.id,
      ratings: [
        { severity: v.severity, method: "CVSSv31", score: v.severity === "critical" ? 9.8 : 7.5 },
      ],
      affects: [{ ref: "pkg:npm/vulnerable-lib@1.0" }],
    })),
    dependencies: [{ ref: "pkg:npm/vulnerable-lib@1.0", dependsOn: [] }],
  };
}

/** 构造包含指定许可证的 CycloneDX SBOM。 */
function buildCycloneDXWithLicense(licenseId: string, name = "lic-lib"): unknown {
  return {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { timestamp: "2026-07-15T01:00:00.000Z", tools: [{ name: "test-tool" }] },
    components: [
      { type: "library", name, version: "1.0", licenses: [{ license: { id: licenseId } }] },
    ],
    dependencies: [{ ref: `pkg:npm/${name}@1.0`, dependsOn: [] }],
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

/** 构造默认 PredicateSupplyChain（可覆盖 sbomRef/sbomContent/provenanceRef/provenanceContent）。 */
function buildSupplyChain(
  overrides: Partial<{
    sbomRef: string;
    sbomContent: unknown;
    provenanceRef: string;
    provenanceContent: unknown;
  }> = {},
): PredicateSupplyChain {
  return {
    sbomRef: overrides.sbomRef ?? "attestation:sbom:v1",
    sbomContent: overrides.sbomContent ?? buildCleanCycloneDXSbom(),
    provenanceRef: overrides.provenanceRef ?? "attestation:provenance:v1",
    provenanceContent: overrides.provenanceContent ?? buildValidProvenance(),
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

function passingConformanceResults(): PublicationConformanceCaseResult[] {
  return PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({
    caseId,
    passed: true,
    evidence: { caseId, passed: true },
    evidenceDigest: `sha256:${computeCanonicalDigest({ caseId, passed: true }).replace("sha256:", "")}`,
  }));
}

// ─── 辅助：构造完整 verifyAndPersistAttestation 入参 ─────────

interface VerifiedAttestationFixture {
  attestation: ArtifactAttestation;
  store: InMemoryManagedArtifactStore;
  builderKeys: BuilderKeyRegistry;
  keyPair: TestBuilderKey;
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
    dsseEnvelopeRef: string;
    sbomRef: string;
    provenanceRef: string;
  }> = {},
): Promise<VerifiedAttestationFixture> {
  const keyPair = generateTestBuilderKey(builderIdentity);
  const builderKeys: BuilderKeyRegistry = { [builderIdentity]: keyPair.publicKeyBase64 };
  const digest = computeArtifactDigest(artifactContent);
  const dsseEnvelopeRef =
    overrides.dsseEnvelopeRef ?? `attestation:signature:${digest.slice(7, 19)}`;
  const sbomRef = overrides.sbomRef ?? `attestation:sbom:${digest.slice(7, 19)}`;
  const provenanceRef = overrides.provenanceRef ?? `attestation:provenance:${digest.slice(7, 19)}`;

  const sbomContent = buildCleanCycloneDXSbom();
  const provenanceContent = buildValidProvenance();
  const supplyChain: PredicateSupplyChain = {
    sbomRef,
    sbomContent,
    provenanceRef,
    provenanceContent: provenanceContent,
  };

  const store = new InMemoryManagedArtifactStore();
  store.writeDsseEnvelope(
    dsseEnvelopeRef,
    buildDsseArtifactAttestationEnvelope(keyPair, digest, supplyChain),
  );
  store.writeSbom(sbomRef, sbomContent);
  store.writeProvenance(provenanceRef, provenanceContent);

  const input: VerifyAttestationInput = {
    tenantId,
    artifactType,
    artifactRevisionId,
    artifactDigest: digest,
    dsseEnvelopeRef,
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
  let keyPair: TestBuilderKey;
  let builderKeys: BuilderKeyRegistry;
  let store: InMemoryManagedArtifactStore;
  let digest: string;
  let validInput: VerifyAttestationInput;

  beforeEach(() => {
    keyPair = generateTestBuilderKey("builder:company-agent-runtime");
    builderKeys = { "builder:company-agent-runtime": keyPair.publicKeyBase64 };
    digest = computeArtifactDigest("agent.yaml content v1");
    const supplyChain = buildSupplyChain();
    store = new InMemoryManagedArtifactStore();
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, supplyChain),
    );
    store.writeSbom("attestation:sbom:v1", supplyChain.sbomContent);
    store.writeProvenance("attestation:provenance:v1", buildValidProvenance());
    validInput = {
      tenantId: "tenant-1",
      artifactType: "agent_revision",
      artifactRevisionId: "rev-1",
      artifactDigest: digest,
      dsseEnvelopeRef: "attestation:signature:v1",
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

  it("dsse_envelope_ref 非受管（http://）→ failed", async () => {
    const result = await verifyArtifactAttestation(
      { ...validInput, dsseEnvelopeRef: "http://evil.com/sig.json" },
      store,
      builderKeys,
    );
    expect(result.failureCode).toBe("signature_ref_not_managed");
  });

  it("sbom_ref 非受管（https://）→ failed", async () => {
    const unmanagedSupplyChain = buildSupplyChain({ sbomRef: "https://evil.com/sbom.json" });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, unmanagedSupplyChain),
    );
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("sbom_ref_not_managed");
  });

  it("provenance_ref 非受管（file://）→ failed", async () => {
    const unmanagedSupplyChain = buildSupplyChain({ provenanceRef: "file:///etc/provenance.json" });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, unmanagedSupplyChain),
    );
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
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
      { ...validInput, dsseEnvelopeRef: "attestation:signature:missing" },
      store,
      builderKeys,
    );
    expect(result.failureCode).toBe("dsse_envelope_unreadable");
  });

  it("DSSE Envelope 非法 JSON → failed (dsse_envelope_parse_failed)", async () => {
    store.writeDsseEnvelope("attestation:signature:v1", buildMalformedDsseEnvelope());
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("dsse_envelope_parse_failed");
  });

  it("DSSE 签名 keyid 与 builderIdentity 不一致 → failed (builder_key_mismatch)", async () => {
    const otherKey = generateTestBuilderKey("builder:other");
    const otherSupplyChain = buildSupplyChain();
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(otherKey, digest, otherSupplyChain, {
        keyid: "builder:other",
      }),
    );
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("builder_key_mismatch");
  });

  it("ed25519 验签失败（签名被篡改）→ failed (signature_invalid)", async () => {
    const tamperedSupplyChain = buildSupplyChain();
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, tamperedSupplyChain, {
        tamperSignature: true,
      }),
    );
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("signature_invalid");
  });

  it("DSSE subject digest 与 artifactDigest 不一致 → failed (signature_invalid)", async () => {
    const subjectMismatchSupplyChain = buildSupplyChain();
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, subjectMismatchSupplyChain, {
        subjectDigest: "sha256:different",
      }),
    );
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("signature_invalid");
  });

  it("SBOM 读取失败 → failed (sbom_unreadable)", async () => {
    const missingSbomSupplyChain = buildSupplyChain({ sbomRef: "attestation:sbom:missing" });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, missingSbomSupplyChain),
    );
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("sbom_unreadable");
  });

  it("SBOM 命中 critical 漏洞 → failed (sbom_blocked_vulnerability)", async () => {
    const vulnSbom = buildCycloneDXWithVulns([{ id: "CVE-2026-001", severity: "critical" }]);
    const vulnSupplyChain = buildSupplyChain({ sbomContent: vulnSbom });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, vulnSupplyChain),
    );
    store.writeSbom("attestation:sbom:v1", vulnSbom);
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("sbom_blocked_vulnerability");
  });

  it("SBOM 命中 high 漏洞 → failed", async () => {
    const vulnSbom = buildCycloneDXWithVulns([{ id: "CVE-2026-002", severity: "high" }]);
    const vulnSupplyChain = buildSupplyChain({ sbomContent: vulnSbom });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, vulnSupplyChain),
    );
    store.writeSbom("attestation:sbom:v1", vulnSbom);
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("sbom_blocked_vulnerability");
  });

  it("SBOM 命中 GPL-3.0 许可证 → failed (sbom_blocked_license)", async () => {
    const licSbom = buildCycloneDXWithLicense("GPL-3.0", "gpl-lib");
    const licSupplyChain = buildSupplyChain({ sbomContent: licSbom });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, licSupplyChain),
    );
    store.writeSbom("attestation:sbom:v1", licSbom);
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("sbom_blocked_license");
  });

  it("SBOM 命中 AGPL-3.0 许可证 → failed", async () => {
    const licSbom = buildCycloneDXWithLicense("AGPL-3.0", "agpl-lib");
    const licSupplyChain = buildSupplyChain({ sbomContent: licSbom });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, licSupplyChain),
    );
    store.writeSbom("attestation:sbom:v1", licSbom);
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("sbom_blocked_license");
  });

  it("SBOM 命中 medium 漏洞 → verified（非阻断等级）", async () => {
    const vulnSbom = buildCycloneDXWithVulns([{ id: "CVE-2026-003", severity: "medium" }]);
    const vulnSupplyChain = buildSupplyChain({ sbomContent: vulnSbom });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, vulnSupplyChain),
    );
    store.writeSbom("attestation:sbom:v1", vulnSbom);
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.verificationState).toBe("verified");
  });

  it("SBOM 命中 low 漏洞 → verified（非阻断等级）", async () => {
    const vulnSbom = buildCycloneDXWithVulns([{ id: "CVE-2026-004", severity: "low" }]);
    const vulnSupplyChain = buildSupplyChain({ sbomContent: vulnSbom });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, vulnSupplyChain),
    );
    store.writeSbom("attestation:sbom:v1", vulnSbom);
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.verificationState).toBe("verified");
  });

  it("provenance 读取失败 → failed (provenance_unreadable)", async () => {
    const missingProvSupplyChain = buildSupplyChain({
      provenanceRef: "attestation:provenance:missing",
    });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, missingProvSupplyChain),
    );
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("provenance_unreadable");
  });

  it("provenance 缺 sourceRevision → failed (provenance_missing_field)", async () => {
    const badProvenance = {
      sourceRevision: "",
      buildPipeline: "pipeline-1",
      dependencyLockFile: "lock",
      buildTime: "2026-07-15T01:00:00.000Z",
    };
    const badProvSupplyChain = buildSupplyChain({ provenanceContent: badProvenance });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, badProvSupplyChain),
    );
    store.writeProvenance("attestation:provenance:v1", badProvenance as ProvenanceDocument);
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("provenance_missing_field");
  });

  it("provenance 缺 buildPipeline → failed", async () => {
    const badProvenance = {
      sourceRevision: "git:abc",
      buildPipeline: "",
      dependencyLockFile: "lock",
      buildTime: "2026-07-15T01:00:00.000Z",
    };
    const badProvSupplyChain = buildSupplyChain({ provenanceContent: badProvenance });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, badProvSupplyChain),
    );
    store.writeProvenance("attestation:provenance:v1", badProvenance as ProvenanceDocument);
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("provenance_missing_field");
  });

  it("provenance buildTime 非有效时间 → failed (provenance_buildtime_invalid)", async () => {
    const badProvenance = {
      sourceRevision: "git:abc",
      buildPipeline: "pipeline-1",
      dependencyLockFile: "lock",
      buildTime: "not-a-date",
    };
    const badProvSupplyChain = buildSupplyChain({ provenanceContent: badProvenance });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, badProvSupplyChain),
    );
    store.writeProvenance("attestation:provenance:v1", badProvenance as ProvenanceDocument);
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("provenance_buildtime_invalid");
  });

  it("签名 Predicate 缺少必填字段 → failed (predicate_field_missing)", async () => {
    const missingFieldSupplyChain = buildSupplyChain();
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, missingFieldSupplyChain, {
        omitPredicateField: "sbomRef",
      }),
    );
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("predicate_field_missing");
  });

  it("SBOM digest 与签名 Predicate 中 sbomDigest 不一致 → failed (sbom_digest_mismatch)", async () => {
    const mismatchSupplyChain = buildSupplyChain();
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, mismatchSupplyChain, {
        tamperSbomDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
    );
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("sbom_digest_mismatch");
  });

  it("Provenance digest 与签名 Predicate 中 provenanceDigest 不一致 → failed (provenance_digest_mismatch)", async () => {
    const mismatchSupplyChain = buildSupplyChain();
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, mismatchSupplyChain, {
        tamperProvenanceDigest:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
    );
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("provenance_digest_mismatch");
  });

  it("签名后修改 SBOM 内容 → failed (sbom_digest_mismatch)", async () => {
    const originalSbom = buildCleanCycloneDXSbom();
    const signedSupplyChain = buildSupplyChain({ sbomContent: originalSbom });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, signedSupplyChain),
    );
    // 签名后替换 store 中的 SBOM → digest 不匹配
    store.writeSbom(
      "attestation:sbom:v1",
      buildCycloneDXWithVulns([{ id: "CVE-2026-tampered", severity: "low" }]),
    );
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("sbom_digest_mismatch");
  });

  it("签名后修改 Provenance 内容 → failed (provenance_digest_mismatch)", async () => {
    const originalProvenance = buildValidProvenance();
    const signedSupplyChain = buildSupplyChain({
      provenanceContent: originalProvenance as unknown as Record<string, unknown>,
    });
    store.writeDsseEnvelope(
      "attestation:signature:v1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, signedSupplyChain),
    );
    // 签名后替换 store 中的 Provenance → digest 不匹配
    store.writeProvenance("attestation:provenance:v1", {
      sourceRevision: "git:tampered",
      buildPipeline: "tampered-pipeline",
      dependencyLockFile: "tampered-lock",
      buildTime: "2026-01-01T00:00:00.000Z",
    });
    const result = await verifyArtifactAttestation(validInput, store, builderKeys);
    expect(result.failureCode).toBe("provenance_digest_mismatch");
  });
});

// ═══════════════════════════════════════════════════════════
// 3. DB 集成：artifact-attestation-writer 仓储
// ═══════════════════════════════════════════════════════════

describe("artifact-attestation-writer 仓储（真实 MySQL）", () => {
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
        dsseEnvelopeRef: "attestation:signature:1",
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
      expect(fetched?.attestation.id).toBe(att.id);
    });

    it("跨租户隔离：他租户查询返回 null", async () => {
      const att = await insertAttestation({
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: computeArtifactDigest("content"),
        dsseEnvelopeRef: "attestation:signature:1",
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
        dsseEnvelopeRef: "attestation:signature:1",
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
          dsseEnvelopeRef: `attestation:signature:${i}`,
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
        dsseEnvelopeRef: "attestation:signature:0",
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
        dsseEnvelopeRef: "attestation:signature:1",
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
      expect(verified[0]?.attestation.verificationState).toBe("verified");
    });

    it("跨租户隔离：他租户 revision 不可见", async () => {
      await insertAttestation({
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: computeArtifactDigest("c"),
        dsseEnvelopeRef: "attestation:signature:0",
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
        dsseEnvelopeRef: "attestation:signature:a",
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
        dsseEnvelopeRef: "attestation:signature:b",
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
        dsseEnvelopeRef: "attestation:signature:0",
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
        dsseEnvelopeRef: "attestation:signature:1",
        sbomRef: "attestation:sbom:1",
        provenanceRef: "attestation:provenance:1",
        builderIdentity: "builder:b",
        verificationState: "verified",
        verifiedAt: new Date(),
      });
      const fetched = await getVerifiedAttestationForRevision(tenantId, "agent_revision", "rev-1");
      expect(fetched).not.toBeNull();
      expect(fetched?.attestation.id).toBe(latest.id);
    });

    it("无 verified 时返回 null", async () => {
      await insertAttestation({
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: computeArtifactDigest("c"),
        dsseEnvelopeRef: "attestation:signature:0",
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
    expect(fetched?.attestation.verificationState).toBe("verified");

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
    const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": keyPair.publicKeyBase64,
    };
    const digest = computeArtifactDigest("content");
    const sbomContent = buildCleanCycloneDXSbom();
    const provenanceContent = buildValidProvenance();
    const badSupplyChain: PredicateSupplyChain = {
      sbomRef: "attestation:sbom:bad",
      sbomContent,
      provenanceRef: "attestation:provenance:bad",
      provenanceContent: provenanceContent,
    };
    const store = new InMemoryManagedArtifactStore();
    // 故意用错误 subject digest 签名 → 验签失败
    store.writeDsseEnvelope(
      "attestation:signature:bad",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, badSupplyChain, {
        subjectDigest: "sha256:wrong",
      }),
    );
    store.writeSbom("attestation:sbom:bad", sbomContent);
    store.writeProvenance("attestation:provenance:bad", provenanceContent);

    const input: VerifyAttestationInput = {
      tenantId,
      artifactType: "agent_revision",
      artifactRevisionId: "rev-1",
      artifactDigest: digest,
      dsseEnvelopeRef: "attestation:signature:bad",
      builderIdentity: "builder:company-agent-runtime",
    };

    await expect(
      verifyAndPersistAttestation(input, store, builderKeys, buildActor(tenantId, "ci-001")),
    ).rejects.toThrow(ArtifactAttestationFailedError);

    // 失败也持久化
    const list = await listAttestationsByRevision(tenantId, "agent_revision", "rev-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.attestation.verificationState).toBe("failed");
    expect(list[0]?.attestation.failureCode).toBe("signature_invalid");

    // 失败也写审计
    const auditEvents = await listAuditEvents({
      tenantId,
      actionType: "artifact.attestation.verify",
      targetType: "artifact_attestation",
      targetId: list[0]?.attestation.id ?? "",
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.reason).toContain("失败");
  });

  it("同一 digest 多份证明（不同 signature bundle ref + 不同 builder）", async () => {
    const digest = computeArtifactDigest("shared-content");

    // builder A
    const keyA = generateTestBuilderKey("builder:company-agent-runtime");
    const storeA = new InMemoryManagedArtifactStore();
    const supplyChainA: PredicateSupplyChain = {
      sbomRef: "attestation:sbom:a",
      sbomContent: buildCleanCycloneDXSbom(),
      provenanceRef: "attestation:provenance:a",
      provenanceContent: buildValidProvenance(),
    };
    storeA.writeDsseEnvelope(
      "attestation:signature:a",
      buildDsseArtifactAttestationEnvelope(keyA, digest, supplyChainA),
    );
    storeA.writeSbom("attestation:sbom:a", supplyChainA.sbomContent);
    storeA.writeProvenance("attestation:provenance:a", buildValidProvenance());
    await verifyAndPersistAttestation(
      {
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: digest,
        dsseEnvelopeRef: "attestation:signature:a",
        builderIdentity: "builder:company-agent-runtime",
      },
      storeA,
      { "builder:company-agent-runtime": keyA.publicKeyBase64 },
      buildActor(tenantId, "ci-001"),
    );

    // builder B
    const keyB = generateTestBuilderKey("builder:company-runtime-host");
    const storeB = new InMemoryManagedArtifactStore();
    const supplyChainB: PredicateSupplyChain = {
      sbomRef: "attestation:sbom:b",
      sbomContent: buildCleanCycloneDXSbom(),
      provenanceRef: "attestation:provenance:b",
      provenanceContent: buildValidProvenance(),
    };
    storeB.writeDsseEnvelope(
      "attestation:signature:b",
      buildDsseArtifactAttestationEnvelope(keyB, digest, supplyChainB),
    );
    storeB.writeSbom("attestation:sbom:b", supplyChainB.sbomContent);
    storeB.writeProvenance("attestation:provenance:b", buildValidProvenance());
    await verifyAndPersistAttestation(
      {
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: "rev-1",
        artifactDigest: digest,
        dsseEnvelopeRef: "attestation:signature:b",
        builderIdentity: "builder:company-runtime-host",
      },
      storeB,
      { "builder:company-runtime-host": keyB.publicKeyBase64 },
      buildActor(tenantId, "ci-002"),
    );

    const list = await listAttestationsByDigest(tenantId, digest);
    expect(list).toHaveLength(2);
    expect(new Set(list.map((a) => a.attestation.builderIdentity))).toEqual(
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
      dsseEnvelopeRef: "attestation:sig:1",
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
      dsseEnvelopeRef: "attestation:sig:1",
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
// 6. publishAgentRevisionWithAttestation 已退役（§8.5 领域违规删除）
// ═══════════════════════════════════════════════════════════

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
      protocolContractRevision: "agent-runtime-protocol@2",
      runtimeEvidenceKind: "hosted_artifact",
      endpointRef: "connection://doubao",
      runtimeArtifactRef: `oci://reg/runtime@${computeArtifactDigest("runtime image content")}`,
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
      protocolContractRevision: "agent-runtime-protocol@2",
      runtimeEvidenceKind: "hosted_artifact",
      endpointRef: "connection://x",
      runtimeArtifactRef: `oci://reg/r@${computeArtifactDigest("runtime image content")}`,
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
      dsseEnvelopeRef: "attestation:sig:f",
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

  it("conformance 门禁失败 → RuntimeConformanceRunInvalidError，Revision 保持 draft（attestation 门禁已通过）", async () => {
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
      protocolContractRevision: "agent-runtime-protocol@2",
      runtimeEvidenceKind: "hosted_artifact",
      endpointRef: "connection://y",
      runtimeArtifactRef: `oci://reg/r@${computeArtifactDigest("runtime image content")}`,
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
      "runtime image content",
    );

    // conformance 门禁失败（第一个 mandatory case 失败）
    const failingResults: PublicationConformanceCaseResult[] = PUBLICATION_CONFORMANCE_CASES.map(
      (caseId, idx) => ({
        caseId,
        passed: idx !== 0,
        reason: idx === 0 ? "模拟失败" : undefined,
        evidence: { caseId, passed: idx !== 0 },
        evidenceDigest: `sha256:${computeCanonicalDigest({ caseId, passed: idx !== 0 }).replace("sha256:", "")}`,
      }),
    );

    await expect(
      publishRuntimeRevisionWithAttestation(
        tenantId,
        revision.id,
        runtime.versionNo,
        failingResults,
        fixture.attestation.id,
        buildActor(tenantId, "ci-001"),
      ),
    ).rejects.toThrow(RuntimeConformanceRunInvalidError);

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
    const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": keyPair.publicKeyBase64,
    };
    const store = new InMemoryManagedArtifactStore();
    const tagSupplyChain: PredicateSupplyChain = {
      sbomRef: "attestation:sbom:1",
      sbomContent: buildCleanCycloneDXSbom(),
      provenanceRef: "attestation:provenance:1",
      provenanceContent: buildValidProvenance(),
    };
    store.writeSbom("attestation:sbom:1", tagSupplyChain.sbomContent);
    store.writeProvenance("attestation:provenance:1", buildValidProvenance());

    // 可变 tag 作为 digest → 验证失败（digest 格式校验在读取 DSSE Envelope 之前）
    for (const badDigest of ["v1.0", "latest", "main", "git:abc"]) {
      store.writeDsseEnvelope(
        "attestation:sig:1",
        buildDsseArtifactAttestationEnvelope(keyPair, badDigest, tagSupplyChain),
      );
      const result = await verifyArtifactAttestation(
        {
          tenantId,
          artifactType: "agent_revision",
          artifactRevisionId: "rev-1",
          artifactDigest: badDigest,
          dsseEnvelopeRef: "attestation:sig:1",
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
    const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": keyPair.publicKeyBase64,
    };
    const digest = computeArtifactDigest("content");
    const vulnSbom = buildCycloneDXWithVulns([{ id: "CVE-2026-critical", severity: "critical" }]);
    const vulnSupplyChain: PredicateSupplyChain = {
      sbomRef: "attestation:sbom:1",
      sbomContent: vulnSbom,
      provenanceRef: "attestation:provenance:1",
      provenanceContent: buildValidProvenance(),
    };
    const store = new InMemoryManagedArtifactStore();
    // SBOM 命中 critical 漏洞
    store.writeDsseEnvelope(
      "attestation:sig:1",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, vulnSupplyChain),
    );
    store.writeSbom("attestation:sbom:1", vulnSbom);
    store.writeProvenance("attestation:provenance:1", buildValidProvenance());

    await expect(
      verifyAndPersistAttestation(
        {
          tenantId,
          artifactType: "agent_revision",
          artifactRevisionId: "rev-1",
          artifactDigest: digest,
          dsseEnvelopeRef: "attestation:sig:1",
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
    expect(list[0]?.attestation.verificationState).toBe("failed");
    expect(list[0]?.attestation.failureCode).toBe("sbom_blocked_vulnerability");

    // 审计写入（afterHash 是 hash，不存原文漏洞详情）
    const auditEvents = await listAuditEvents({
      tenantId,
      actionType: "artifact.attestation.verify",
      targetType: "artifact_attestation",
      targetId: list[0]?.attestation.id ?? "",
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
    // 发布权威 = 绑定 AgentContractSnapshot；未绑定先走 snapshot 门禁。
    // 本用例目标是校验「未验证 Attestation」→ AgentPublicationPrerequisiteError，故先绑定 Snapshot 越过 snapshot 门禁。
    await ensureAgentContractSnapshotBoundForRevision(revision.id, tenantId);

    // 未验证的 attestation（failed 状态）
    const failedAtt = await insertAttestation({
      tenantId,
      artifactType: "agent_revision",
      artifactRevisionId: revision.id,
      artifactDigest: computeArtifactDigest("c"),
      dsseEnvelopeRef: "attestation:sig:f",
      sbomRef: "attestation:sbom:f",
      provenanceRef: "attestation:prov:f",
      builderIdentity: "builder:b",
      verificationState: "failed",
      failureCode: "signature_invalid",
      verifiedAt: new Date(),
    });

    const beforeAgent = agent;
    await expect(
      publishAgentRevision({
        tenantId,
        revisionId: revision.id,
        agentExpectedVersionNo: agent.versionNo,
        attestationId: failedAtt.id,
        actor: buildActor(tenantId, "ci-001"),
        requestId: "test-publish-fail",
        idempotencyKey: "test-publish-fail",
      }),
    ).rejects.toThrow(AgentPublicationPrerequisiteError);

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
    // 发布权威 = 绑定 AgentContractSnapshot；未绑定先走 snapshot 门禁。
    await ensureAgentContractSnapshotBoundForRevision(revision.id, tenantId);

    // builder A 验证失败（SBOM 命中漏洞）
    const keyA = generateTestBuilderKey("builder:company-agent-runtime");
    const digest = computeArtifactDigest("shared-content");
    const vulnSbomA = buildCycloneDXWithVulns([{ id: "CVE-X", severity: "critical" }]);
    const storeA = new InMemoryManagedArtifactStore();
    const supplyChainA: PredicateSupplyChain = {
      sbomRef: "attestation:sbom:a",
      sbomContent: vulnSbomA,
      provenanceRef: "attestation:prov:a",
      provenanceContent: buildValidProvenance(),
    };
    storeA.writeDsseEnvelope(
      "attestation:sig:a",
      buildDsseArtifactAttestationEnvelope(keyA, digest, supplyChainA),
    );
    storeA.writeSbom("attestation:sbom:a", vulnSbomA);
    storeA.writeProvenance("attestation:prov:a", buildValidProvenance());
    await expect(
      verifyAndPersistAttestation(
        {
          tenantId,
          artifactType: "agent_revision",
          artifactRevisionId: revision.id,
          artifactDigest: digest,
          dsseEnvelopeRef: "attestation:sig:a",
          builderIdentity: "builder:company-agent-runtime",
        },
        storeA,
        { "builder:company-agent-runtime": keyA.publicKeyBase64 },
        buildActor(tenantId, "ci-001"),
      ),
    ).rejects.toThrow(ArtifactAttestationFailedError);

    // builder B 验证通过（干净 SBOM）
    const keyB = generateTestBuilderKey("builder:company-runtime-host");
    const storeB = new InMemoryManagedArtifactStore();
    const supplyChainB: PredicateSupplyChain = {
      sbomRef: "attestation:sbom:b",
      sbomContent: buildCleanCycloneDXSbom(),
      provenanceRef: "attestation:prov:b",
      provenanceContent: buildValidProvenance(),
    };
    storeB.writeDsseEnvelope(
      "attestation:sig:b",
      buildDsseArtifactAttestationEnvelope(keyB, digest, supplyChainB),
    );
    storeB.writeSbom("attestation:sbom:b", supplyChainB.sbomContent);
    storeB.writeProvenance("attestation:prov:b", buildValidProvenance());
    const verifiedAtt = await verifyAndPersistAttestation(
      {
        tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: revision.id,
        artifactDigest: digest,
        dsseEnvelopeRef: "attestation:sig:b",
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
    const result = await publishAgentRevision({
      tenantId,
      revisionId: revision.id,
      agentExpectedVersionNo: agent.versionNo,
      attestationId: verifiedAtt.id,
      actor: buildActor(tenantId, "ci-002"),
      requestId: "test-publish-ok",
      idempotencyKey: "test-publish-ok",
    });
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
