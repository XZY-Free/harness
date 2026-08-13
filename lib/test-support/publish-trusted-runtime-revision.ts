import { createHash, randomUUID } from "node:crypto";
import { getAttestationById } from "@/lib/artifacts/persistence/artifact-attestation-reader";
import { db } from "@/lib/db/client";
import { runtimeRevisionTable } from "@/lib/persistence/schema/runtime";
import { createDSSEConformanceVerifier } from "@/lib/runtime/conformance/runtime-conformance-verifier";
import { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";
import {
  ALL_CONFORMANCE_CASES,
  CONFORMANCE_SUITE_REVISION,
} from "@/lib/runtime/domain/runtime-conformance-contract";
import { mysqlRuntimeConformanceRunStore } from "@/lib/runtime/persistence/mysql-runtime-conformance-run-store";
import { mysqlRuntimePublicationStore } from "@/lib/runtime/persistence/mysql-runtime-publication-store";
import {
  getRuntimeRevisionById,
  updateDraftRuntimeRevisionContent,
} from "@/lib/runtime/persistence/runtime-revision-queries";
import { createPublishRuntimeRevision } from "@/lib/runtime/provisioning/publish-runtime-revision";
import { createRecordRuntimeConformanceRun } from "@/lib/runtime/provisioning/record-runtime-conformance-run";
import {
  buildDsseConformanceEnvelope,
  generateTestRunnerKey,
} from "@/lib/runtime/test-support/build-dsse-conformance-envelope";
import { eq } from "drizzle-orm";

const TRUSTED_RUNNER_KEY = generateTestRunnerKey("test-trusted-runner");
const RUNNER_IDENTITY = "test/trusted-runtime-runner";

/** 真实 MySQL + DSSE 的测试装配：先记录可信 Run，再通过正式发布服务发布。 */
export async function publishTrustedRuntimeRevisionForTest(params: {
  tenantId: string;
  revisionId: string;
  runtimeExpectedVersionNo: number;
  attestationId: string;
}) {
  let revision = await getRuntimeRevisionById(params.revisionId);
  const found = await getAttestationById(params.tenantId, params.attestationId);
  const attestation = found?.attestation;
  if (!attestation?.artifactId || attestation.verificationState !== "verified") {
    throw new Error(`测试 RuntimeRevision 缺少权威 Attestation: ${params.revisionId}`);
  }
  await db
    .update(runtimeRevisionTable)
    .set({ artifactId: attestation.artifactId, artifactDigest: attestation.artifactDigest })
    .where(eq(runtimeRevisionTable.id, params.revisionId));
  revision = await getRuntimeRevisionById(params.revisionId);
  if (revision && !/^sha256:[0-9a-f]{64}$/.test(revision.configHash)) {
    revision = await updateDraftRuntimeRevisionContent(revision.id, {
      configHash: `sha256:${createHash("sha256").update(revision.configHash).digest("hex")}`,
    });
  }
  if (!revision?.artifactDigest) {
    throw new Error(`测试 RuntimeRevision 未绑定权威 Artifact: ${params.revisionId}`);
  }
  const runId = randomUUID();
  const report = {
    runId,
    runtimeRevisionId: revision.id,
    runtimeArtifactDigest: revision.artifactDigest,
    runtimeConfigDigest: revision.configHash,
    protocolContractRevision: revision.protocolContractRevision,
    suiteRevision: CONFORMANCE_SUITE_REVISION,
    runnerArtifactDigest: `sha256:${"c".repeat(64)}`,
    runnerIdentity: RUNNER_IDENTITY,
    testEnvironmentRevision: "mysql8-testcontainers@1",
    startedAt: "2026-08-02T01:00:00.000Z",
    completedAt: "2026-08-02T01:00:01.000Z",
    overallResult: "passed" as const,
    evidenceManifestDigest: `sha256:${randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
    caseResults: ALL_CONFORMANCE_CASES.map((caseId, index) => ({
      caseId,
      passed: true,
      reason: null,
      evidenceDigest: `sha256:${index.toString(16).padStart(64, "0")}`,
    })),
  };
  const dsseEnvelope = buildDsseConformanceEnvelope(report, TRUSTED_RUNNER_KEY);
  await createRecordRuntimeConformanceRun({
    store: mysqlRuntimeConformanceRunStore,
    verifier: createDSSEConformanceVerifier({
      runnerIdentityRegistry: new RunnerSigningIdentityRegistry([
        {
          keyId: TRUSTED_RUNNER_KEY.keyid,
          publicKey: TRUSTED_RUNNER_KEY.publicKeyBase64,
          runnerIdentity: RUNNER_IDENTITY,
          tenantScope: null,
          validFrom: "2020-01-01T00:00:00.000Z",
          validUntil: null,
          revokedAt: null,
        },
      ]),
    }),
  })({
    tenantId: params.tenantId,
    runtimeRevisionId: revision.id,
    dsseEnvelope,
    idempotencyKey: `runtime-conformance:${runId}`,
    requestId: `test-run:${runId}`,
    actor: { actorType: "system", actorId: RUNNER_IDENTITY },
  });

  const publication = await createPublishRuntimeRevision({ store: mysqlRuntimePublicationStore })({
    tenantId: params.tenantId,
    revisionId: revision.id,
    runtimeExpectedVersionNo: params.runtimeExpectedVersionNo,
    conformanceRunId: runId,
    attestationId: params.attestationId,
    actor: {
      tenantId: params.tenantId,
      actorType: "system",
      actorId: RUNNER_IDENTITY,
    },
    requestId: `test-publish:${revision.id}`,
    idempotencyKey: `test-publish:${revision.id}`,
  });
  return { ...publication, conformanceRunId: runId };
}
