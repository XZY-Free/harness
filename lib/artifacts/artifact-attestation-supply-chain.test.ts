/**
 * S12-W04：制品与依赖供应链集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - provenance 摘要持久化：verifyAndPersistAttestation 成功后写入 sourceRevision/buildPipeline/
 *   dependencyLockFileHash/buildTime/scanSummaryJson。
 * - listAttestations：分页（cursor）+ 过滤（artifactType / verificationState / revoked）。
 * - revokeAttestation：成功 + 审计 + 跨租户隔离 + 幂等保护 + 已撤销阻止 getVerifiedAttestationForRevision。
 * - assertAttestationGate：已撤销 attestation 被拒绝。
 * - getVerifiedAttestationForRevision：撤销后不再返回此 attestation。
 * - ATTESTATION_FAILURE_CODES 包含 attestation_revoked。
 *
 * 真实签名（ed25519）+ InMemoryManagedArtifactStore，复用 artifact-attestation.test.ts 的辅助模式。
 */
import { randomUUID } from "node:crypto";
import {
  AttestationAlreadyRevokedError,
  AttestationNotFoundError,
} from "@/lib/artifacts/application/revoke-artifact-attestation";
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type VerifyAttestationInput,
  computeArtifactDigest,
  verifyArtifactAttestation,
} from "@/lib/artifacts/domain/artifact-attestation";
import {
  getAttestationById,
  getVerifiedAttestationForRevision,
  listAttestations,
  listAttestationsByRevision,
} from "@/lib/artifacts/persistence/artifact-attestation-reader";
import {
  assertAttestationGate,
  insertAttestation,
  revokeAttestation,
  verifyAndPersistAttestation,
} from "@/lib/artifacts/persistence/artifact-attestation-writer";

import {
  type PredicateSupplyChain,
  type TestBuilderKey,
  buildDsseArtifactAttestationEnvelope,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { type AuditActor, recordAuditEvent } from "@/lib/identity/audit";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  ATTESTATION_FAILURE_CODES,
  type ArtifactAttestation,
} from "@/lib/persistence/schema/artifact";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：InMemoryManagedArtifactStore（与 artifact-attestation.test.ts 一致） ──

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

// ─── 辅助：ed25519 密钥对 + DSSE Envelope（来自 test-support） ──

/** 构造符合 CycloneDX 1.6 Schema 的干净 SBOM（与 artifact-attestation.test.ts 一致）。 */
function buildCleanSbom(): unknown {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: { type: "application", name: "test-app", version: "1.0.0" } },
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

// ─── 辅助：seed ────────────────────────────────────────────

async function seedTenantAndOwner() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "supply-chain-owner-001",
    email: "supply-chain-owner@example.com",
    displayName: "Supply Chain Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "supply-chain-owner-001",
    displayName: "Supply Chain Owner",
    userIdentityId: identity.id,
  });
  return { tenantId: tenant.id, ownerId: identity.id };
}

function buildActor(tenantId: string, actorId: string): AuditActor {
  return { tenantId, actorType: "service", actorId };
}

/** 构造一个完整通过的 verified attestation（含真实 ed25519 签名 + provenance 摘要）。 */
async function createVerifiedAttestation(
  tenantId: string,
  artifactType: string,
  artifactRevisionId: string,
  artifactContent: string,
  builderIdentity = "builder:company-agent-runtime",
  actor: AuditActor = buildActor(tenantId, "ci-service-001"),
): Promise<{ attestation: ArtifactAttestation; keyPair: TestBuilderKey; digest: string }> {
  const keyPair = generateTestBuilderKey(builderIdentity);
  const builderKeys: BuilderKeyRegistry = { [builderIdentity]: keyPair.publicKeyBase64 };
  const digest = computeArtifactDigest(artifactContent);
  const dsseEnvelopeRef = `attestation:signature:${digest.slice(7, 19)}`;
  const sbomRef = `attestation:sbom:${digest.slice(7, 19)}`;
  const provenanceRef = `attestation:provenance:${digest.slice(7, 19)}`;

  const sbomContent = buildCleanSbom();
  const provenanceContent = buildValidProvenance();
  const supplyChain: PredicateSupplyChain = {
    sbomRef,
    sbomContent,
    provenanceRef,
    provenanceContent,
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

  const attestation = await verifyAndPersistAttestation(input, store, builderKeys, actor);

  return { attestation, keyPair, digest };
}

// ═══════════════════════════════════════════════════════════
// 1. provenance 摘要持久化
// ═══════════════════════════════════════════════════════════

describe("S12-W04 provenance 摘要持久化", () => {
  let tenantId: string;

  beforeEach(async () => {
    const seeded = await seedTenantAndOwner();
    tenantId = seeded.tenantId;
  });

  it("verifyAndPersistAttestation 成功后写入 sourceRevision/buildPipeline/dependencyLockFileHash/buildTime", async () => {
    const { attestation } = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-prov-1",
      "agent.yaml content with provenance",
    );

    expect(attestation.sourceRevision).toBe("git:abc123def456");
    expect(attestation.buildPipeline).toBe("ci-cd-pipeline-1");
    expect(attestation.dependencyLockFileHash).toBe("package-lock.json:sha256:lockhash");
    expect(attestation.buildTime).toEqual(new Date("2026-07-15T01:00:00.000Z"));
  });

  it("verifyAndPersistAttestation 成功后写入 scanSummaryJson（含 packagesScanned/vulnerabilityCount/blockedLicenseCount）", async () => {
    const { attestation } = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-prov-2",
      "agent.yaml content with scan summary",
    );

    expect(attestation.scanSummaryJson).not.toBeNull();
    const summary = attestation.scanSummaryJson as Record<string, unknown>;
    expect(summary.packagesScanned).toBe(2);
    expect(summary.vulnerabilityCount).toBe(0);
    expect(summary.blockedLicenseCount).toBe(0);
  });

  it("重新读取持久化记录包含 provenance 字段（不丢失）", async () => {
    const { attestation } = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-prov-3",
      "agent.yaml content reread",
    );

    const fetched = await getAttestationById(tenantId, attestation.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.attestation.sourceRevision).toBe("git:abc123def456");
    expect(fetched?.attestation.buildPipeline).toBe("ci-cd-pipeline-1");
    expect(fetched?.attestation.dependencyLockFileHash).toBe("package-lock.json:sha256:lockhash");
    expect(fetched?.attestation.buildTime).toEqual(new Date("2026-07-15T01:00:00.000Z"));
    expect(fetched?.attestation.scanSummaryJson).not.toBeNull();
  });

  it("验证失败记录不持久化 provenance 摘要（failureCode 写入但 provenance 字段为 null）", async () => {
    const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": keyPair.publicKeyBase64,
    };
    const digest = computeArtifactDigest("failure content");
    const failSbomRef = "attestation:sbom:fail";
    const failProvRef = "attestation:provenance:fail";
    const failSbomContent = buildCleanSbom();
    const failProvContent = buildValidProvenance();
    const failSupplyChain: PredicateSupplyChain = {
      sbomRef: failSbomRef,
      sbomContent: failSbomContent,
      provenanceRef: failProvRef,
      provenanceContent: failProvContent,
    };
    const store = new InMemoryManagedArtifactStore();
    // 故意用错误 subject digest → 验签失败
    store.writeDsseEnvelope(
      "attestation:signature:fail",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, failSupplyChain, {
        subjectDigest: "sha256:wrong",
      }),
    );
    store.writeSbom(failSbomRef, failSbomContent);
    store.writeProvenance(failProvRef, failProvContent);

    const input: VerifyAttestationInput = {
      tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: "rev-fail-1",
      artifactDigest: digest,
      dsseEnvelopeRef: "attestation:signature:fail",
      builderIdentity: "builder:company-agent-runtime",
    };

    await expect(
      verifyAndPersistAttestation(input, store, builderKeys, buildActor(tenantId, "ci-001")),
    ).rejects.toThrow();

    const list = await listAttestationsByRevision(tenantId, "runtime_revision", "rev-fail-1");
    expect(list).toHaveLength(1);
    const failed = list[0];
    expect(failed?.attestation.verificationState).toBe("failed");
    expect(failed?.attestation.failureCode).toBe("signature_invalid");
    // 验证失败不持久化 provenance 摘要（按当前实现：result.provenanceSummary 仅成功时存在）
    expect(failed?.attestation.sourceRevision).toBeNull();
    expect(failed?.attestation.buildPipeline).toBeNull();
    expect(failed?.attestation.dependencyLockFileHash).toBeNull();
    expect(failed?.attestation.buildTime).toBeNull();
    expect(failed?.attestation.scanSummaryJson).toBeNull();
  });

  it("verifyArtifactAttestation 成功返回 provenanceSummary 与 scanSummary", async () => {
    const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": keyPair.publicKeyBase64,
    };
    const digest = computeArtifactDigest("pure-logic content");
    const pureSbomRef = "attestation:sbom:pure";
    const pureProvRef = "attestation:provenance:pure";
    const pureSbomContent = buildCleanSbom();
    const pureProvContent = buildValidProvenance();
    const pureSupplyChain: PredicateSupplyChain = {
      sbomRef: pureSbomRef,
      sbomContent: pureSbomContent,
      provenanceRef: pureProvRef,
      provenanceContent: pureProvContent,
    };
    const store = new InMemoryManagedArtifactStore();
    store.writeDsseEnvelope(
      "attestation:signature:pure",
      buildDsseArtifactAttestationEnvelope(keyPair, digest, pureSupplyChain),
    );
    store.writeSbom(pureSbomRef, pureSbomContent);
    store.writeProvenance(pureProvRef, pureProvContent);

    const result = await verifyArtifactAttestation(
      {
        tenantId,
        artifactType: "runtime_revision",
        artifactRevisionId: "rev-pure-1",
        artifactDigest: digest,
        dsseEnvelopeRef: "attestation:signature:pure",
        builderIdentity: "builder:company-agent-runtime",
      },
      store,
      builderKeys,
    );

    expect(result.verificationState).toBe("verified");
    expect(result.provenanceSummary).toBeDefined();
    expect(result.provenanceSummary?.sourceRevision).toBe("git:abc123def456");
    expect(result.provenanceSummary?.buildPipeline).toBe("ci-cd-pipeline-1");
    expect(result.provenanceSummary?.dependencyLockFile).toBe("package-lock.json:sha256:lockhash");
    expect(result.provenanceSummary?.buildTime).toBe("2026-07-15T01:00:00.000Z");
    expect(result.scanSummary).toBeDefined();
    expect(result.scanSummary?.packagesScanned).toBe(2);
    expect(result.scanSummary?.vulnerabilityCount).toBe(0);
    expect(result.scanSummary?.blockedLicenseCount).toBe(0);
  });

  it("验证成功创建独立Artifact并让Attestation引用该权威对象", async () => {
    const { attestation, digest } = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-authoritative-artifact",
      "authoritative artifact content",
    );

    const [tables] = (await db.execute("SHOW TABLES LIKE 'Artifact'")) as unknown as [unknown[]];
    expect(tables).toHaveLength(1);

    const [artifacts] = (await db.execute(sql`
      SELECT \`id\`, \`tenantId\`, \`digest\`
      FROM \`Artifact\`
      WHERE \`tenantId\` = ${tenantId} AND \`digest\` = ${digest}
    `)) as unknown as [Array<{ id: string; tenantId: string; digest: string }>];
    expect(artifacts).toHaveLength(1);
    expect((attestation as unknown as { artifactId: string | null }).artifactId).toBe(
      artifacts[0]?.id,
    );
  });

  it("并发验证同一Digest只创建一个权威Artifact", async () => {
    const [left, right] = await Promise.all([
      createVerifiedAttestation(
        tenantId,
        "runtime_revision",
        "rev-concurrent-artifact-left",
        "shared concurrent artifact",
      ),
      createVerifiedAttestation(
        tenantId,
        "runtime_revision",
        "rev-concurrent-artifact-right",
        "shared concurrent artifact",
      ),
    ]);

    expect(left.attestation.artifactId).toBe(right.attestation.artifactId);
    const [rows] = (await db.execute(sql`
      SELECT \`id\` FROM \`Artifact\`
      WHERE \`tenantId\` = ${tenantId} AND \`digest\` = ${left.digest}
    `)) as unknown as [Array<{ id: string }>];
    expect(rows).toHaveLength(1);
  });

  it("Audit写入失败会回滚Artifact、Attestation和Outbox", async () => {
    const revisionId = "rev-verification-rollback";
    const content = "verification rollback artifact";
    const digest = computeArtifactDigest(content);
    const invalidActor: AuditActor = {
      tenantId,
      actorType: "invalid" as AuditActor["actorType"],
      actorId: "invalid-audit-actor",
    };

    await expect(
      createVerifiedAttestation(
        tenantId,
        "runtime_revision",
        revisionId,
        content,
        "builder:company-agent-runtime",
        invalidActor,
      ),
    ).rejects.toThrow();

    const [artifacts] = (await db.execute(sql`
      SELECT \`id\` FROM \`Artifact\`
      WHERE \`tenantId\` = ${tenantId} AND \`digest\` = ${digest}
    `)) as unknown as [unknown[]];
    const [attestations] = (await db.execute(sql`
      SELECT \`id\` FROM \`ArtifactAttestation\`
      WHERE \`tenantId\` = ${tenantId} AND \`artifactRevisionId\` = ${revisionId}
    `)) as unknown as [unknown[]];
    expect(artifacts).toHaveLength(0);
    expect(attestations).toHaveLength(0);
    expect(await db.select().from(controlPlaneOutboxEvent)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. listAttestations 分页 + 过滤
// ═══════════════════════════════════════════════════════════

describe("S12-W04 listAttestations 分页 + 过滤", () => {
  let tenantId: string;
  const otherTenantId = "11111111-1111-4111-8111-111111111111";

  beforeEach(async () => {
    const seeded = await seedTenantAndOwner();
    tenantId = seeded.tenantId;
  });

  it("按 createdAt 降序返回，无 cursor 时返回首页", async () => {
    const digest = computeArtifactDigest("list-content");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const att = await insertAttestation({
        tenantId,
        artifactType: "runtime_revision",
        artifactRevisionId: `rev-list-${i}`,
        artifactDigest: digest,
        dsseEnvelopeRef: `attestation:signature:list-${i}`,
        sbomRef: `attestation:sbom:list-${i}`,
        provenanceRef: `attestation:provenance:list-${i}`,
        builderIdentity: "builder:company-agent-runtime",
        verificationState: "verified",
        verifiedAt: new Date(),
      });
      ids.push(att.id);
    }
    // MySQL datetime 精度 ms 可能相同，强制 sleep 1ms 后再插一条保证顺序
    await new Promise((r) => setTimeout(r, 5));
    const fourth = await insertAttestation({
      tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: "rev-list-latest",
      artifactDigest: digest,
      dsseEnvelopeRef: "attestation:signature:list-latest",
      sbomRef: "attestation:sbom:list-latest",
      provenanceRef: "attestation:provenance:list-latest",
      builderIdentity: "builder:company-agent-runtime",
      verificationState: "verified",
      verifiedAt: new Date(),
    });
    ids.push(fourth.id);

    const result = await listAttestations(tenantId, { limit: 10 });
    expect(result.items).toHaveLength(4);
    expect(result.nextCursor).toBeNull();
    // 最新创建的排第一
    expect(result.items[0]?.attestation.id).toBe(fourth.id);
  });

  it("limit 触发分页 → 返回 nextCursor", async () => {
    const digest = computeArtifactDigest("page-content");
    for (let i = 0; i < 5; i++) {
      await insertAttestation({
        tenantId,
        artifactType: "runtime_revision",
        artifactRevisionId: `rev-page-${i}`,
        artifactDigest: digest,
        dsseEnvelopeRef: `attestation:signature:page-${i}`,
        sbomRef: `attestation:sbom:page-${i}`,
        provenanceRef: `attestation:provenance:page-${i}`,
        builderIdentity: "builder:company-agent-runtime",
        verificationState: "verified",
        verifiedAt: new Date(),
      });
      await new Promise((r) => setTimeout(r, 5));
    }

    const first = await listAttestations(tenantId, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
  });

  it("按 artifactType 过滤", async () => {
    const digest = computeArtifactDigest("filter-content");
    await insertAttestation({
      tenantId,
      artifactType: "skill_package",
      artifactRevisionId: "rev-filter-1",
      artifactDigest: digest,
      dsseEnvelopeRef: "attestation:signature:f1",
      sbomRef: "attestation:sbom:f1",
      provenanceRef: "attestation:provenance:f1",
      builderIdentity: "builder:company-agent-runtime",
      verificationState: "verified",
      verifiedAt: new Date(),
    });
    await insertAttestation({
      tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: "rev-filter-2",
      artifactDigest: digest,
      dsseEnvelopeRef: "attestation:signature:f2",
      sbomRef: "attestation:sbom:f2",
      provenanceRef: "attestation:provenance:f2",
      builderIdentity: "builder:company-agent-runtime",
      verificationState: "verified",
      verifiedAt: new Date(),
    });

    const result = await listAttestations(tenantId, {
      artifactType: "runtime_revision",
      limit: 10,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.attestation.artifactType).toBe("runtime_revision");
  });

  it("按 verificationState 过滤", async () => {
    const digest = computeArtifactDigest("state-content");
    await insertAttestation({
      tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: "rev-state-1",
      artifactDigest: digest,
      dsseEnvelopeRef: "attestation:signature:s1",
      sbomRef: "attestation:sbom:s1",
      provenanceRef: "attestation:provenance:s1",
      builderIdentity: "builder:company-agent-runtime",
      verificationState: "verified",
      verifiedAt: new Date(),
    });
    await insertAttestation({
      tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: "rev-state-2",
      artifactDigest: digest,
      dsseEnvelopeRef: "attestation:signature:s2",
      sbomRef: "attestation:sbom:s2",
      provenanceRef: "attestation:provenance:s2",
      builderIdentity: "builder:company-agent-runtime",
      verificationState: "failed",
      failureCode: "signature_invalid",
      verifiedAt: new Date(),
    });

    const verified = await listAttestations(tenantId, {
      verificationState: "verified",
      limit: 10,
    });
    expect(verified.items).toHaveLength(1);
    expect(verified.items[0]?.attestation.verificationState).toBe("verified");

    const failed = await listAttestations(tenantId, {
      verificationState: "failed",
      limit: 10,
    });
    expect(failed.items).toHaveLength(1);
    expect(failed.items[0]?.attestation.verificationState).toBe("failed");
  });

  it("按 revoked=true 过滤仅返回已撤销", async () => {
    const { attestation: att1 } = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-revoke-filter-1",
      "content-revoke-1",
    );
    await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-revoke-filter-2",
      "content-revoke-2",
    );

    // 撤销第一个
    await revokeAttestation(tenantId, att1.id, buildActor(tenantId, "admin-001"), "测试撤销过滤");

    const revokedOnly = await listAttestations(tenantId, { revoked: true, limit: 10 });
    expect(revokedOnly.items).toHaveLength(1);
    expect(revokedOnly.items[0]?.attestation.id).toBe(att1.id);
    expect(revokedOnly.items[0]?.revocation?.revokedAt).not.toBeNull();

    const activeOnly = await listAttestations(tenantId, { revoked: false, limit: 10 });
    // 仅返回未撤销；rev-revoke-filter-2 创建的 attestation 未撤销
    const activeIds = activeOnly.items.map((a) => a.attestation.id);
    expect(activeIds).not.toContain(att1.id);
    expect(activeOnly.items.every((a) => a.revocation === null)).toBe(true);
  });

  it("跨租户隔离：他租户不可见", async () => {
    await insertAttestation({
      tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: "rev-iso-1",
      artifactDigest: computeArtifactDigest("iso"),
      dsseEnvelopeRef: "attestation:signature:iso",
      sbomRef: "attestation:sbom:iso",
      provenanceRef: "attestation:provenance:iso",
      builderIdentity: "builder:company-agent-runtime",
      verificationState: "verified",
      verifiedAt: new Date(),
    });

    const result = await listAttestations(otherTenantId, { limit: 10 });
    expect(result.items).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. revokeAttestation 撤销流程
// ═══════════════════════════════════════════════════════════

describe("S12-W04 revokeAttestation 撤销流程", () => {
  let tenantId: string;
  const otherTenantId = "11111111-1111-4111-8111-111111111111";

  beforeEach(async () => {
    const seeded = await seedTenantAndOwner();
    tenantId = seeded.tenantId;
  });

  it("成功撤销：追加 AttestationRevocationRecord 权威事实 + 写审计", async () => {
    const { attestation } = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-revoke-1",
      "content-revoke-1",
    );

    const reason = "发现供应链投毒（CVE-2026-9999）";
    const actor = buildActor(tenantId, "security-admin-001");
    const updated = await revokeAttestation(tenantId, attestation.id, actor, reason);

    expect(updated.revocation?.revokedAt).not.toBeNull();
    expect(updated.revocation?.revokedBy).toBe("security-admin-001");
    expect(updated.revocation?.reason).toBe(reason);

    // 重新读取验证持久化
    const fetched = await getAttestationById(tenantId, attestation.id);
    expect(fetched?.revocation?.revokedAt).not.toBeNull();
    expect(fetched?.revocation?.revokedBy).toBe("security-admin-001");
    expect(fetched?.revocation?.reason).toBe(reason);

    // 审计写入 artifact.attestation.revoke
    const auditEvents = await listAuditEvents({
      tenantId,
      actionType: "artifact.attestation.revoke",
      targetType: "artifact_attestation",
      targetId: attestation.id,
    });
    expect(auditEvents).toHaveLength(1);
    const ev = auditEvents[0];
    expect(ev?.actorType).toBe("service");
    expect(ev?.actorId).toBe("security-admin-001");
    expect(ev?.reason).toBe(reason);
    // before/after 摘要存在
    expect(ev?.beforeHash).toBeTruthy();
    expect(ev?.afterHash).toBeTruthy();
  });

  it("撤销追加AttestationRevocationRecord且不改写原Attestation", async () => {
    const { attestation } = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-append-only-revocation",
      "append-only revocation content",
    );

    await revokeAttestation(
      tenantId,
      attestation.id,
      buildActor(tenantId, "admin-append-only"),
      "供应链密钥泄露",
    );

    // 原 Attestation 事实未被改写：撤销权威在独立 AttestationRevocationRecord，
    // ArtifactAttestation 的权威字段保持不变（撤销列已物理移除，结构上不可能被改写）。
    const [attestationRows] = (await db.execute(sql`
      SELECT \`verificationState\`, \`artifactDigest\`, \`verificationEngineVersion\`
      FROM \`ArtifactAttestation\`
      WHERE \`id\` = ${attestation.id}
    `)) as unknown as [
      Array<{
        verificationState: string;
        artifactDigest: string;
        verificationEngineVersion: string | null;
      }>,
    ];
    expect(attestationRows[0]).toEqual({
      verificationState: attestation.verificationState,
      artifactDigest: attestation.artifactDigest,
      verificationEngineVersion: attestation.verificationEngineVersion,
    });

    const [revocations] = (await db.execute(sql`
      SELECT \`attestationId\`, \`reason\`, \`revokedBy\`
      FROM \`AttestationRevocationRecord\`
      WHERE \`attestationId\` = ${attestation.id}
    `)) as unknown as [Array<{ attestationId: string; reason: string; revokedBy: string }>];
    expect(revocations).toEqual([
      {
        attestationId: attestation.id,
        reason: "供应链密钥泄露",
        revokedBy: "admin-append-only",
      },
    ]);
  });

  it("两个并发撤销只有一个权威撤销事实", async () => {
    const { attestation } = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-concurrent-revocation",
      "concurrent revocation content",
    );

    const outcomes = await Promise.allSettled([
      revokeAttestation(
        tenantId,
        attestation.id,
        buildActor(tenantId, "security-admin-left"),
        "密钥泄露",
      ),
      revokeAttestation(
        tenantId,
        attestation.id,
        buildActor(tenantId, "security-admin-right"),
        "密钥泄露",
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(
      AttestationAlreadyRevokedError,
    );
    const [rows] = (await db.execute(sql`
      SELECT \`id\` FROM \`AttestationRevocationRecord\`
      WHERE \`attestationId\` = ${attestation.id}
    `)) as unknown as [unknown[]];
    expect(rows).toHaveLength(1);
  });

  it("Outbox写入失败会回滚撤销记录和Audit", async () => {
    const { attestation } = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-revocation-rollback",
      "revocation rollback content",
    );
    await db.insert(controlPlaneOutboxEvent).values({
      id: randomUUID(),
      tenantId,
      eventKey: `artifact-attestation-revoked:${attestation.id}`,
      eventType: "test.conflict",
      aggregateType: "artifact_attestation",
      aggregateId: attestation.id,
      payloadJson: {},
      occurredAt: new Date(),
    });

    await expect(
      revokeAttestation(
        tenantId,
        attestation.id,
        buildActor(tenantId, "security-admin-rollback"),
        "故障注入",
      ),
    ).rejects.toThrow();

    const [rows] = (await db.execute(sql`
      SELECT \`id\` FROM \`AttestationRevocationRecord\`
      WHERE \`attestationId\` = ${attestation.id}
    `)) as unknown as [unknown[]];
    expect(rows).toHaveLength(0);
    expect(
      await listAuditEvents({
        tenantId,
        actionType: "artifact.attestation.revoke",
        targetId: attestation.id,
      }),
    ).toHaveLength(0);
  });

  it("撤销不存在 attestation → AttestationNotFoundError", async () => {
    await expect(
      revokeAttestation(
        tenantId,
        "nonexistent-attestation-id",
        buildActor(tenantId, "admin-001"),
        "test",
      ),
    ).rejects.toThrow(AttestationNotFoundError);
  });

  it("撤销跨租户 attestation → AttestationNotFoundError", async () => {
    const { attestation } = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-revoke-cross-1",
      "content-revoke-cross",
    );

    await expect(
      revokeAttestation(
        otherTenantId,
        attestation.id,
        buildActor(otherTenantId, "admin-other"),
        "跨租户尝试",
      ),
    ).rejects.toThrow(AttestationNotFoundError);
  });

  it("重复撤销 → AttestationAlreadyRevokedError（幂等保护）", async () => {
    const { attestation } = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-revoke-2",
      "content-revoke-2",
    );

    await revokeAttestation(
      tenantId,
      attestation.id,
      buildActor(tenantId, "admin-001"),
      "第一次撤销",
    );

    await expect(
      revokeAttestation(tenantId, attestation.id, buildActor(tenantId, "admin-002"), "第二次撤销"),
    ).rejects.toThrow(AttestationAlreadyRevokedError);

    // 仍只有一条撤销审计
    const auditEvents = await listAuditEvents({
      tenantId,
      actionType: "artifact.attestation.revoke",
      targetType: "artifact_attestation",
      targetId: attestation.id,
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.actorId).toBe("admin-001");
    expect(auditEvents[0]?.reason).toBe("第一次撤销");
  });

  it("撤销后 getVerifiedAttestationForRevision 不再返回此 attestation", async () => {
    const { attestation } = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-revoke-verified-1",
      "content-revoke-verified",
    );

    // 撤销前可以查询到
    const before = await getVerifiedAttestationForRevision(
      tenantId,
      "runtime_revision",
      "rev-revoke-verified-1",
    );
    expect(before).not.toBeNull();
    expect(before?.attestation.id).toBe(attestation.id);

    // 撤销
    await revokeAttestation(
      tenantId,
      attestation.id,
      buildActor(tenantId, "admin-001"),
      "撤销后阻止 verified 查询",
    );

    // 撤销后 getVerifiedAttestationForRevision 返回 null
    const after = await getVerifiedAttestationForRevision(
      tenantId,
      "runtime_revision",
      "rev-revoke-verified-1",
    );
    expect(after).toBeNull();
  });

  it("撤销后 assertAttestationGate 拒绝已撤销 attestation", async () => {
    const { attestation } = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      "rev-revoke-gate-1",
      "content-revoke-gate",
    );

    // 撤销前门禁通过
    await assertAttestationGate(tenantId, "runtime_revision", "rev-revoke-gate-1", attestation.id);

    // 撤销
    await revokeAttestation(
      tenantId,
      attestation.id,
      buildActor(tenantId, "admin-001"),
      "撤销后阻止门禁",
    );

    // 撤销后 assertAttestationGate 抛错
    await expect(
      assertAttestationGate(tenantId, "runtime_revision", "rev-revoke-gate-1", attestation.id),
    ).rejects.toThrow(/已撤销/);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. ATTESTATION_FAILURE_CODES 目录
// ═══════════════════════════════════════════════════════════

describe("S12-W04 ATTESTATION_FAILURE_CODES 目录", () => {
  it("包含 attestation_revoked 失败码", () => {
    expect(ATTESTATION_FAILURE_CODES).toContain("attestation_revoked");
  });

  it("artifact.attestation.revoke actionType 已在 AUDIT_ACTION_TYPES 目录中（recordAuditEvent 通过 fail-closed 校验）", async () => {
    const tenant = await ensureDefaultTenant();
    const event = await recordAuditEvent({
      actor: buildActor(tenant.id, "test-001"),
      actionType: "artifact.attestation.revoke",
      targetType: "artifact_attestation",
      targetId: "test-target",
      after: { state: "revoked" },
    });
    expect(event.actionType).toBe("artifact.attestation.revoke");
  });
});
