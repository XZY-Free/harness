/**
 * 可复用的权威 Artifact Attestation 装配（真实 DSSE 签名 + 正式验签器）。
 *
 * §11.2「测试可以使用测试密钥/本地 Artifact Store，但必须运行正式
 * production Artifact verifier」：本模块只提供测试密钥与内存 Artifact Store，
 * 验签与落库一律走 `verifyAndPersistAttestation`（正式路径），
 * 不存在 TrustedTestVerifier 或直插 Attestation 的旁路。
 *
 * 消费者：
 * - `lib/test-support/seed-dispatchable-turn.ts`（vitest 集成测试夹具）
 * - `lib/test-support/seed-published-runtime-revision.ts`（e2e 正式链引导，专题01 §15 无默认 Agent）
 */
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type VerifyAttestationInput,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-queries";
import {
  buildDsseArtifactAttestationEnvelope,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import type { AuditActor } from "@/lib/identity/audit";

/** 内存 Artifact Store（§11.2 允许的"本地 Artifact Store"）。 */
export class InMemoryManagedArtifactStore implements ManagedArtifactStore {
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

/** 通过 SBOM 许可证校验的干净物料清单。 */
export function buildCleanSbom(): unknown {
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
    ],
  };
}

/** 通过 provenance 完整性校验的构建溯源文档。 */
export function buildValidProvenance(): ProvenanceDocument {
  return {
    sourceRevision: "git:abc123def456",
    buildPipeline: "ci-cd-pipeline-1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  };
}

/** 构造服务型审计 actor。 */
export function buildActor(tenantId: string, actorId: string): AuditActor {
  return { tenantId, actorType: "service", actorId };
}

/**
 * 用真实 ed25519 测试密钥签出 DSSE 信封，交正式验签器验证并落库。
 *
 * 返回值即正式 `ArtifactAttestation`（verificationState=verified）。
 */
export async function createVerifiedAttestation(
  tenantId: string,
  artifactType: string,
  artifactRevisionId: string,
  artifactContent: string,
) {
  const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
  const builderKeys: BuilderKeyRegistry = {
    "builder:company-agent-runtime": keyPair.publicKeyBase64,
  };
  const digest = computeArtifactDigest(artifactContent);
  const dsseEnvelopeRef = `attestation:signature:${digest.slice(7, 15)}`;
  const sbomRef = `attestation:sbom:${digest.slice(7, 15)}`;
  const provRef = `attestation:provenance:${digest.slice(7, 15)}`;

  const store = new InMemoryManagedArtifactStore();
  store.writeDsseEnvelope(
    dsseEnvelopeRef,
    buildDsseArtifactAttestationEnvelope(keyPair, digest, {
      sbomRef,
      sbomContent: buildCleanSbom(),
      provenanceRef: provRef,
      provenanceContent: buildValidProvenance(),
    }),
  );
  store.writeSbom(sbomRef, buildCleanSbom());
  store.writeProvenance(provRef, buildValidProvenance());

  const input: VerifyAttestationInput = {
    tenantId,
    artifactType,
    artifactRevisionId,
    artifactDigest: digest,
    dsseEnvelopeRef,
    builderIdentity: "builder:company-agent-runtime",
  };

  return verifyAndPersistAttestation(
    input,
    store,
    builderKeys,
    buildActor(tenantId, "ci-service-001"),
  );
}
