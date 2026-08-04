/**
 * 测试工具：为 RuntimeRevision 创建权威 Artifact + Attestation。
 *
 * 直接写入数据库，不走完整的 verifyAndPersistAttestation 流程。
 * 仅用于集成测试，不得用于生产代码。
 */
import { randomUUID } from "node:crypto";
import { artifact, artifactAttestation } from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
import { runtimeRevisionTable } from "@/lib/persistence/schema/control-plane";
import { eq } from "drizzle-orm";

export interface SeedAttestationResult {
  artifactId: string;
  attestationId: string;
  artifactDigest: string;
}

/**
 * 为 RuntimeRevision 创建权威 Artifact + Attestation，并更新 Revision 的 artifactId/artifactDigest。
 *
 * 返回 attestationId，可直接传给 PublishRuntimeRevisionCommand。
 */
export async function seedVerifiedRuntimeAttestation(
  tenantId: string,
  revisionId: string,
): Promise<SeedAttestationResult> {
  const artifactId = randomUUID();
  const artifactDigest = `sha256:${randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64)}`;
  const attestationId = randomUUID();

  await db.insert(artifact).values({
    id: artifactId,
    tenantId,
    kind: "runtime_revision",
    digest: artifactDigest,
    mediaType: "application/vnd.snowharness.runtime+json",
    contentRef: `oci://registry/runtime@${artifactDigest}`,
    sourceRevision: "test-pipeline@1",
    buildMetadata: { builder: "test" },
  });

  await db.insert(artifactAttestation).values({
    id: attestationId,
    tenantId,
    artifactId,
    artifactType: "runtime_revision",
    artifactRevisionId: revisionId,
    artifactDigest,
    signatureBundleRef: `attestation:signature:${artifactDigest.slice(7, 19)}`,
    sbomRef: `attestation:sbom:${artifactDigest.slice(7, 19)}`,
    provenanceRef: `attestation:provenance:${artifactDigest.slice(7, 19)}`,
    builderIdentity: "builder:company-agent-runtime",
    verificationState: "verified",
    verifiedAt: new Date(),
  });

  // 更新 RuntimeRevision 的 artifactId 和 artifactDigest 以保持绑定一致
  await db
    .update(runtimeRevisionTable)
    .set({ artifactId, artifactDigest })
    .where(eq(runtimeRevisionTable.id, revisionId));

  return { artifactId, attestationId, artifactDigest };
}
