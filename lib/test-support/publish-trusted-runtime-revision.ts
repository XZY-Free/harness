import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAttestationById } from "@/lib/artifacts/persistence/artifact-attestation-reader";
import { db } from "@/lib/db/client";
import { runtimeRevisionTable } from "@/lib/persistence/schema/runtime";
import { createHostedAdapter } from "@/lib/runtime/adapters/hosted-adapter";
import { createDSSEConformanceVerifier } from "@/lib/runtime/conformance/runtime-conformance-verifier";
import { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";
import {
  ALL_CONFORMANCE_CASES,
  CONFORMANCE_SUITE_REVISION,
  type ConformanceCaseId,
} from "@/lib/runtime/domain/runtime-conformance-contract";
import type { RuntimeConformanceReport } from "@/lib/runtime/domain/runtime-conformance-run";
import { mysqlRuntimeConformanceRunStore } from "@/lib/runtime/persistence/mysql-runtime-conformance-run-store";
import { mysqlRuntimePublicationStore } from "@/lib/runtime/persistence/mysql-runtime-publication-store";
import {
  getRuntimeRevisionById,
  updateDraftRuntimeRevisionContent,
} from "@/lib/runtime/persistence/runtime-revision-queries";
import { createPublishRuntimeRevision } from "@/lib/runtime/provisioning/publish-runtime-revision";
import { createRecordRuntimeConformanceRun } from "@/lib/runtime/provisioning/record-runtime-conformance-run";
import { runConformanceSuite } from "@/lib/runtime/runtime-conformance-runner";
import {
  buildDsseConformanceEnvelope,
  computeSha256Digest,
  generateTestRunnerKey,
} from "@/lib/runtime/test-support/build-dsse-conformance-envelope";
import { runIsolatedConformanceCases } from "@/lib/test-support/isolated-conformance-runner";
import { eq } from "drizzle-orm";

const TRUSTED_RUNNER_KEY = generateTestRunnerKey("test-trusted-runner");
const RUNNER_IDENTITY = "test/trusted-runtime-runner";
const TEST_ENVIRONMENT_REVISION = "testcontainers-mysql8@1";

/**
 * runnerArtifactDigest 必须来自实际执行的 runner 源文件内容（§验收：不能是手写
 * identity JSON）。这里读取两个真实 runner 源文件（生产 runConformanceSuite 与
 * isolated runner）的字节，对真实构建制品内容做 sha256。测试环境能读到真实源文件。
 */
export async function computeRunnerArtifactDigest(): Promise<string> {
  const runnerSources = [
    resolve(process.cwd(), "lib/runtime/runtime-conformance-runner.ts"),
    resolve(process.cwd(), "lib/test-support/isolated-conformance-runner.ts"),
  ];
  const hash = createHash("sha256");
  for (const source of runnerSources) {
    const bytes = await readFile(source);
    hash.update(`file:${source}\n`);
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * 运行 Conformance 套件，证据完全来自真实执行：
 *
 * 1. 基础 adapter probe：调用生产 lib/runtime/runtime-conformance-runner.ts 的
 *    runConformanceSuite（8 个 case 真实验证；其余 fail-closed）。
 * 2. 其余 fail-closed 的 case 交给 isolated runner，对真实生产平台（MySQL /
 *    ingress / Employee command / ExecutionBinding / Tool / Memory / child /
 *    ownership 正式 query/store）执行 given/when/expect。
 * 3. evidenceDigest / runnerArtifactDigest / evidenceManifestDigest 全部从真实
 *    证据内容用 createHash sha256 计算；runnerArtifactDigest 来自真实 runner
 *    源文件，evidenceManifestDigest canonical 绑定 runtimeRevisionId、
 *    runtime artifact digest、config hash、protocol version、suite revision 与
 *    每个 case 的 evidence。
 *
 * 任一 case 未通过（含 fail-closed）→ overallResult=failed，由发布门禁拦截。
 */
export async function runTrustedTestConformanceSuite(params: {
  tenantId: string;
  runtimeRevisionId: string;
  runtimeArtifactDigest: string;
  runtimeConfigDigest: string;
  protocolContractRevision: string;
  failCase?: ConformanceCaseId;
}): Promise<RuntimeConformanceReport> {
  const startedAt = new Date();

  // 1. 基础 adapter probe：生产 runConformanceSuite。
  const adapter = createHostedAdapter({
    platformEndpoint: "in-process://conformance-test",
    platformAuthToken: "conformance-test-token",
    modelFn: async (message) => `conformance probe reply: ${message}`,
    modelRef: "conformance-test-model",
  });
  const productionResults = await runConformanceSuite({
    tenantId: params.tenantId,
    runtimeRevisionId: params.runtimeRevisionId,
    runtimeAdapter: adapter,
  });

  // 2. isolated runner 补齐 production runner fail-closed 的 case。
  const isolatedResult = await runIsolatedConformanceCases({
    tenantId: params.tenantId,
    runtimeRevisionId: params.runtimeRevisionId,
    productionResults,
    failCase: params.failCase,
  });

  // 3. 组装报告。
  const caseResults = isolatedResult.caseResults.map((result) => ({
    caseId: result.caseId,
    passed: result.passed,
    reason: result.passed ? null : result.reason,
    evidenceDigest: result.evidenceDigest,
  }));

  const runnerArtifactDigest = await computeRunnerArtifactDigest();
  const allPassed = caseResults.every((result) => result.passed);

  // evidenceManifestDigest 必须 canonical 绑定 revision 身份 + 全部 case 证据。
  const manifest = {
    suiteRevision: CONFORMANCE_SUITE_REVISION,
    testEnvironmentRevision: TEST_ENVIRONMENT_REVISION,
    runtimeRevisionId: params.runtimeRevisionId,
    runtimeArtifactDigest: params.runtimeArtifactDigest,
    runtimeConfigDigest: params.runtimeConfigDigest,
    protocolContractRevision: params.protocolContractRevision,
    runnerArtifactDigest,
    cases: [...caseResults]
      .sort((a, b) => a.caseId.localeCompare(b.caseId))
      .map((result) => ({
        caseId: result.caseId,
        passed: result.passed,
        evidenceDigest: result.evidenceDigest,
      })),
  };

  return {
    runId: randomUUID(),
    runtimeRevisionId: params.runtimeRevisionId,
    runtimeArtifactDigest: params.runtimeArtifactDigest,
    runtimeConfigDigest: params.runtimeConfigDigest,
    protocolContractRevision: params.protocolContractRevision,
    suiteRevision: CONFORMANCE_SUITE_REVISION,
    runnerArtifactDigest,
    runnerIdentity: RUNNER_IDENTITY,
    testEnvironmentRevision: TEST_ENVIRONMENT_REVISION,
    startedAt: startedAt.toISOString(),
    completedAt: new Date(startedAt.getTime() + 1000).toISOString(),
    overallResult: allPassed ? "passed" : "failed",
    evidenceManifestDigest: computeSha256Digest(JSON.stringify(manifest)),
    caseResults,
  };
}

export class ConformanceSuiteFailedError extends Error {
  constructor(public readonly failedCases: ConformanceCaseId[]) {
    super(`Conformance 存在失败 case，不能发布：${failedCases.join(", ")}`);
    this.name = "ConformanceSuiteFailedError";
  }
}

/** 发布门禁：任一 case 失败（含 fail-closed）即抛错，保证"任一 case 失败不能发布"。 */
export function assertAllConformanceCasesPassed(report: RuntimeConformanceReport): void {
  const failedCases = report.caseResults
    .filter((result) => !result.passed)
    .map((result) => result.caseId);
  if (failedCases.length > 0) {
    throw new ConformanceSuiteFailedError(failedCases);
  }
}

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

  // 运行真实 Conformance 套件；任一 case 失败（含 fail-closed）→ 拦截发布。
  const report = await runTrustedTestConformanceSuite({
    tenantId: params.tenantId,
    runtimeRevisionId: revision.id,
    runtimeArtifactDigest: revision.artifactDigest,
    runtimeConfigDigest: revision.configHash,
    protocolContractRevision: revision.protocolContractRevision,
  });
  assertAllConformanceCasesPassed(report);

  const runId = report.runId;
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
