import { randomUUID } from "node:crypto";
import { createRecordArtifactAttestation } from "@/lib/artifacts/application/record-artifact-attestation";
import { mysqlArtifactAttestationPersistenceStore } from "@/lib/artifacts/persistence/mysql-artifact-attestation-store";
import type { RuntimeRevisionRow } from "@/lib/persistence/schema/control-plane";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import { publishRuntimeRevisionThroughControlPlane } from "@/lib/runtime/provisioning/publish-runtime-revision-service";

/**
 * 专用于缺少可信 Conformance Run 的 fail-closed 负路径测试辅助。
 *
 * 当前发布合同要求 attestationId + conformanceRunId 必填。
 * 此入口仅用于验证缺少必填证明时抛出正确错误类型。
 *
 * 为抵达 ConformanceRun 校验环节，会先创建一份有效的 ArtifactAttestation，
 * 但仍传入不存在的 conformanceRunId，从而触发 RuntimeConformanceRunInvalidError。
 */
export async function publishRuntimeRevision(
  tenantId: string,
  revisionId: string,
  runtimeExpectedVersionNo: number,
  _conformanceResults: unknown[],
  _options?: {
    adapterDigest?: string | null;
    testEnvironment?: string | null;
    evidenceRef?: string | null;
  },
): Promise<RuntimeRevisionRow> {
  const revision = await getRuntimeRevisionById(revisionId);
  if (!revision) throw new Error(`Revision 不存在: ${revisionId}`);
  const artifactDigest = revision.artifactDigest;
  if (!artifactDigest) {
    throw new Error(`Revision ${revisionId} 缺少 artifactDigest，无法创建有效 Attestation`);
  }

  const attestation = await createRecordArtifactAttestation({
    store: mysqlArtifactAttestationPersistenceStore,
  })({
    tenantId,
    artifactType: "runtime_revision",
    artifactRevisionId: revisionId,
    artifactDigest,
    dsseEnvelopeRef: `attestation:dsse:${revisionId}`,
    sbomRef: `attestation:sbom:${revisionId}`,
    provenanceRef: `attestation:provenance:${revisionId}`,
    builderIdentity: "builder:conformance-test-support",
    verificationState: "verified",
    policyRevisionId: null,
    failureCode: null,
    verifiedAt: new Date(),
    sourceRevision: null,
    buildPipeline: null,
    dependencyLockFileHash: null,
    buildTime: null,
    scanSummaryJson: null,
    actor: { tenantId, actorType: "service", actorId: "test-support" },
    requestId: `attestation-${revisionId}`,
  });

  const result = await publishRuntimeRevisionThroughControlPlane({
    tenantId,
    revisionId,
    runtimeExpectedVersionNo,
    conformanceRunId: "test-missing-conformance-run-id",
    attestationId: attestation.id,
    actor: {
      tenantId,
      actorType: "system",
      actorId: "test-support",
    },
    requestId: `test-runtime-publish:${randomUUID()}`,
    idempotencyKey: `test-runtime-publish:${revisionId}`,
  });
  return result.revision as RuntimeRevisionRow;
}
