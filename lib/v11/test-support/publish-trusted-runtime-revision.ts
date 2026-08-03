import { createHash, createHmac, randomUUID } from "node:crypto";
import { mysqlRuntimeConformanceRunStore } from "@/lib/compatibility/runtimes/mysql-runtime-conformance-run-store";
import { createPublishRuntimeRevision } from "@/lib/runtimes/application/publish-runtime-revision";
import { createRecordRuntimeConformanceRun } from "@/lib/runtimes/application/record-runtime-conformance-run";
import {
  ALL_CONFORMANCE_CASES,
  canonicalizeRuntimeConformanceReport,
} from "@/lib/runtimes/domain/runtime-conformance-run";
import { mysqlRuntimePublicationStore } from "@/lib/v11/control-plane/mysql-runtime-publication-store";
import {
  getRuntimeRevisionById,
  updateDraftRuntimeRevisionContent,
} from "@/lib/v11/control-plane/runtime-revision-queries";

/** 真实 MySQL + HMAC 的测试装配：先记录可信 Run，再通过正式发布服务发布。 */
export async function publishTrustedRuntimeRevisionForTest(params: {
  tenantId: string;
  revisionId: string;
  runtimeExpectedVersionNo: number;
}) {
  let revision = await getRuntimeRevisionById(params.revisionId);
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
    suiteRevision: "runtime-conformance@1",
    runnerArtifactDigest: `sha256:${"c".repeat(64)}`,
    runnerIdentity: "test/trusted-runtime-runner",
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
  const secret = "route-test-trusted-runner-secret-32-bytes";
  await createRecordRuntimeConformanceRun({
    store: mysqlRuntimeConformanceRunStore,
    signingSecret: () => secret,
  })({
    tenantId: params.tenantId,
    runtimeRevisionId: revision.id,
    report,
    signature: createHmac("sha256", secret)
      .update(canonicalizeRuntimeConformanceReport(report))
      .digest("hex"),
    idempotencyKey: `runtime-conformance:${runId}`,
    requestId: `test-run:${runId}`,
    actor: { actorType: "system", actorId: "test/trusted-runtime-runner" },
  });

  return createPublishRuntimeRevision({ store: mysqlRuntimePublicationStore })({
    tenantId: params.tenantId,
    revisionId: revision.id,
    runtimeExpectedVersionNo: params.runtimeExpectedVersionNo,
    conformanceRunId: runId,
    actor: {
      tenantId: params.tenantId,
      actorType: "system",
      actorId: "test/trusted-runtime-runner",
    },
    requestId: `test-publish:${revision.id}`,
    idempotencyKey: `test-publish:${revision.id}`,
  });
}
