import { randomUUID } from "node:crypto";
import { ArtifactNotVerifiedError } from "@/lib/artifacts/domain/artifact-attestation";
import { getAttestationById } from "@/lib/artifacts/persistence/artifact-attestation-reader";
import type { ArtifactAttestation } from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
import type { AuditActor } from "@/lib/identity/audit";
import { runtimeRevisionTable } from "@/lib/persistence/schema/control-plane";
import type { RuntimeRevisionRow } from "@/lib/persistence/schema/control-plane";
import { PUBLICATION_CONFORMANCE_SUITE_REVISION } from "@/lib/runtime/domain/runtime-conformance-contract";
import {
  RuntimeArtifactAttestationInvalidError,
  RuntimeConformanceRunRequiredError,
} from "@/lib/runtime/domain/runtime-revision-publication-policy";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import { publishRuntimeRevisionThroughControlPlane } from "@/lib/runtime/provisioning/publish-runtime-revision-service";
import { eq } from "drizzle-orm";

export interface PublishRuntimeRevisionWithAttestationResult {
  revision: RuntimeRevisionRow;
  attestation: ArtifactAttestation;
  auditEventId: string;
}

/**
 * 在 DB 中直接插入 ConformanceRun + CaseResult 行，
 * 使 publishRuntimeRevisionThroughControlPlane 的 FOR UPDATE 查询能命中。
 */
async function insertConformanceRunInDb(params: {
  tenantId: string;
  revisionId: string;
  runtimeArtifactDigest: string;
  runtimeConfigDigest: string;
  protocolContractRevision: string;
  overallResult: "passed" | "failed";
  caseResults: Array<{ caseId: string; passed: boolean; reason?: string }>;
}): Promise<string> {
  const runId = randomUUID();
  const now = new Date();
  const envelopeJson = JSON.stringify({ test: true, runId });
  const envelopeDigest = `sha256:${Buffer.from(envelopeJson, "utf-8").toString("hex").slice(0, 64)}`;

  await db.insert(runtimeConformanceRun).values({
    id: runId,
    tenantId: params.tenantId,
    runtimeRevisionId: params.revisionId,
    runtimeArtifactDigest: params.runtimeArtifactDigest,
    runtimeConfigDigest: params.runtimeConfigDigest,
    protocolContractRevision: params.protocolContractRevision,
    suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
    runnerArtifactDigest: params.runtimeArtifactDigest,
    runnerIdentity: "test-runner",
    testEnvironmentRevision: "test-env@1",
    startedAt: now,
    completedAt: now,
    overallResult: params.overallResult,
    evidenceManifestDigest: `sha256:${randomUUID().replace(/-/g, "")}`,
    envelopeDigest,
    envelopeJson,
    payloadDigest: `sha256:${randomUUID().replace(/-/g, "")}`,
    signingKeyId: "test-signing-key",
    verificationEngine: "test-verifier",
    verificationEngineVersion: "1.0",
    predicateType: "https://snowharness.dev/conformance/runtime/v1",
    verifiedAt: now,
    idempotencyKey: `conformance-run:${runId}`,
    requestId: `req:${runId}`,
    recordedAt: now,
  });

  const caseRows = params.caseResults.map((cr) => ({
    id: randomUUID(),
    runId,
    caseId: cr.caseId,
    passed: cr.passed,
    reason: cr.reason ?? null,
    evidenceDigest: `sha256:${randomUUID().replace(/-/g, "")}`,
  }));
  await db.insert(runtimeConformanceCaseResult).values(caseRows);

  return runId;
}

/**
 * 测试有 Attestation + ConformanceRun 时的发布行为。
 *
 * 从 DB 读取 Revision 真实的 artifactDigest / configHash / protocolContractRevision，
 * 在 DB 中创建与之绑定的真实 ConformanceRun，传递真实 conformanceRunId
 * 给生产函数 publishRuntimeRevisionThroughControlPlane。
 */
export async function publishRuntimeRevisionWithAttestation(
  tenantId: string,
  revisionId: string,
  runtimeExpectedVersionNo: number,
  conformanceResults: Array<{ caseId: string; passed: boolean; reason?: string }>,
  attestationId: string,
  actor: AuditActor,
  requestId?: string,
): Promise<PublishRuntimeRevisionWithAttestationResult> {
  // 从 DB 读取 Revision 真实字段，确保 ConformanceRun 绑定一致
  const [revisionRow] = await db
    .select()
    .from(runtimeRevisionTable)
    .where(eq(runtimeRevisionTable.id, revisionId))
    .limit(1);
  if (!revisionRow) throw new Error(`RuntimeRevision ${revisionId} 不存在`);

  // 判断整体结果：全部 passed 才是 passed
  const overallResult = conformanceResults.every((r) => r.passed) ? "passed" : "failed";

  // 在 DB 中插入 ConformanceRun，使 findPassedConformanceRun 能查到
  const conformanceRunId = await insertConformanceRunInDb({
    tenantId,
    revisionId,
    runtimeArtifactDigest: revisionRow.artifactDigest ?? "",
    runtimeConfigDigest: revisionRow.configHash,
    protocolContractRevision: revisionRow.protocolContractRevision,
    overallResult,
    caseResults: conformanceResults,
  });

  try {
    const result = await publishRuntimeRevisionThroughControlPlane({
      tenantId,
      revisionId,
      runtimeExpectedVersionNo,
      attestationId,
      conformanceRunId,
      actor,
      requestId: requestId ?? `runtime-publish:${randomUUID()}`,
      idempotencyKey: `runtime-attested-publish:${revisionId}`,
    });
    const found = await getAttestationById(tenantId, attestationId);
    if (!found) throw new ArtifactNotVerifiedError(attestationId, "attestation 不存在");
    return {
      revision: result.revision as RuntimeRevisionRow,
      attestation: found.attestation,
      auditEventId: result.auditEventId,
    };
  } catch (error) {
    if (error instanceof RuntimeArtifactAttestationInvalidError) {
      throw new ArtifactNotVerifiedError(error.attestationId, error.message);
    }
    if (error instanceof RuntimeConformanceRunRequiredError) {
      throw new ArtifactNotVerifiedError(attestationId, error.message);
    }
    throw error;
  }
}
