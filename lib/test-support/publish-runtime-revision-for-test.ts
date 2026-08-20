/**
 * 集成测试专用：把候选 RuntimeRevision 发布为 published。
 *
 * 本 helper 不直接插 Publication、不改 published、不预制 case 结果。它走完整正式链：
 * 1. 创建真实测试 Adapter（Hosted 参考实现），不做任何 Bootstrap / 平台预置。
 * 2. 运行正式 Publication runner（runPublicationConformanceSuite）真实调用 Adapter，
 *    产生真实 case 证据（clean/no-route/no-binding adapter 即可完成）。
 * 3. 用测试 Runner 密钥对真实报告生成 DSSE Envelope。
 * 4. 调用正式 record-runtime-conformance-run 与 createPublishRuntimeRevision 服务。
 *
 * 任一 case 未通过（含 fail-closed）→ overallResult=failed，发布门禁拦截。
 *
 * 仅供测试；生产代码禁止引用。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAttestationById } from "@/lib/artifacts/persistence/artifact-attestation-reader";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { createHostedAdapter } from "@/lib/runtime/adapters/hosted-adapter";
import { createDSSEConformanceVerifier } from "@/lib/runtime/conformance/runtime-conformance-verifier";
import { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";
import {
  PUBLICATION_CONFORMANCE_SUITE_REVISION,
  type PublicationConformanceCaseId,
} from "@/lib/runtime/domain/runtime-conformance-contract";
import {
  type RuntimeConformanceReport,
  computeEvidenceManifestDigest,
} from "@/lib/runtime/domain/runtime-conformance-run";
import { mysqlRuntimeConformanceRunStore } from "@/lib/runtime/persistence/mysql-runtime-conformance-run-store";
import { mysqlRuntimePublicationStore } from "@/lib/runtime/persistence/mysql-runtime-publication-store";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import { createPublishRuntimeRevision } from "@/lib/runtime/provisioning/publish-runtime-revision";
import { createRecordRuntimeConformanceRun } from "@/lib/runtime/provisioning/record-runtime-conformance-run";
import { runPublicationConformanceSuite } from "@/lib/runtime/runtime-conformance-runner";
import {
  buildDsseConformanceEnvelope,
  generateTestRunnerKey,
} from "@/lib/runtime/test-support/build-dsse-conformance-envelope";
import { createCapturingEventBatchSink } from "@/lib/runtime/test-support/capturing-event-batch-sink";

const TEST_RUNNER_KEY = generateTestRunnerKey("test-publication-runner");
const RUNNER_IDENTITY = "test/runtime-publication-runner";
/** 实际执行环境：in-process Hosted Adapter，非 Testcontainers。 */
const TEST_ENVIRONMENT_REVISION = "in-process-hosted-adapter@1";

/**
 * 纯函数：从「仓库相对路径 + 实际源文件字节」计算 runnerArtifactDigest。
 *
 * 只依赖 relativePath + bytes，不含任何绝对路径前缀，因此 cwd / checkout 目录
 * 不同不影响 digest；源文件内容变化会影响 digest。
 */
export function computeRunnerArtifactDigestFromSources(
  sources: Array<{ relativePath: string; bytes: Buffer }>,
): string {
  const canonical = [...sources]
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((source) => ({
      relativePath: source.relativePath,
      sha256: computeCanonicalDigest({ bytes: source.bytes.toString("base64") }),
    }));
  return computeCanonicalDigest(canonical);
}

/**
 * runnerArtifactDigest 必须来自实际执行的 runner 源文件内容（不能是手写 identity
 * JSON 或全零占位）。这里用稳定仓库相对路径读取真实 runner + publication contract
 * 源文件字节，对真实构建制品内容做 sha256；与 cwd 无关。
 */
export async function computeRunnerArtifactDigest(): Promise<string> {
  const cwd = process.cwd();
  const sources = [
    {
      relativePath: "lib/runtime/runtime-conformance-runner.ts",
      bytes: await readFile(resolve(cwd, "lib/runtime/runtime-conformance-runner.ts")),
    },
    {
      relativePath: "lib/runtime/domain/runtime-conformance-contract.ts",
      bytes: await readFile(resolve(cwd, "lib/runtime/domain/runtime-conformance-contract.ts")),
    },
  ];
  return computeRunnerArtifactDigestFromSources(sources);
}

/** 发布门禁：任一 Publication case 失败（含 fail-closed）即抛错，保证不能发布。 */
export function assertPublicationConformancePassed(report: RuntimeConformanceReport): void {
  const failedCases = report.caseResults
    .filter((result) => !result.passed)
    .map((result) => result.caseId);
  if (failedCases.length > 0) {
    throw new PublicationConformanceFailedError(failedCases);
  }
}

export class PublicationConformanceFailedError extends Error {
  constructor(public readonly failedCases: PublicationConformanceCaseId[]) {
    super(`Publication Conformance 存在失败 case，不能发布：${failedCases.join(", ")}`);
    this.name = "PublicationConformanceFailedError";
  }
}

/**
 * 运行正式 Publication Conformance 套件，证据全部来自真实 Adapter 执行：
 * - 创建真实 Hosted 测试 Adapter（in-process）。
 * - 调用正式 runPublicationConformanceSuite（内部只 probe 一次、dispatch 一次）。
 * - evidenceDigest / runnerArtifactDigest / evidenceManifestDigest 全部从真实
 *   证据内容 RFC8785 canonical digest 计算；runnerArtifactDigest 来自真实 runner
 *   源文件（相对路径）。
 * - evidenceManifestDigest canonical 绑定 runtimeRevisionId、artifact digest、
 *   config hash、protocol version、suite revision 与每个 case 的证据。
 * - completedAt 为 suite 真实结束时间 new Date()，不伪造 startedAt+1000。
 */
export async function runPublicationConformanceForTest(params: {
  tenantId: string;
  runtimeRevisionId: string;
  runtimeArtifactDigest: string;
  runtimeConfigDigest: string;
  protocolContractRevision: string;
}): Promise<RuntimeConformanceReport> {
  const startedAt = new Date();

  // 1. 创建真实测试 Adapter（in-process Hosted 参考实现）。
  //    注入进程内捕获型 EventBatchSink：接收并保留真实候选事件，不黑洞、不伪造 ack。
  const capturing = createCapturingEventBatchSink();
  const adapter = createHostedAdapter({
    platformEndpoint: "in-process://conformance-test",
    platformAuthToken: "conformance-test-token",
    eventBatchSink: capturing.sink,
    modelFn: async (message) => `conformance probe reply: ${message}`,
    modelRef: "conformance-test-model",
  });

  // 2. 运行正式 Publication runner。
  const caseResults = await runPublicationConformanceSuite({
    tenantId: params.tenantId,
    runtimeRevisionId: params.runtimeRevisionId,
    runtimeAdapter: adapter,
  });

  const runnerArtifactDigest = await computeRunnerArtifactDigest();
  const allPassed = caseResults.every((result) => result.passed);

  // evidenceManifestDigest 用 domain 唯一权威函数 canonical 绑定 revision 身份 + 全部 case 证据。
  const evidenceManifestDigest = computeEvidenceManifestDigest({
    suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
    testEnvironmentRevision: TEST_ENVIRONMENT_REVISION,
    runtimeRevisionId: params.runtimeRevisionId,
    runtimeArtifactDigest: params.runtimeArtifactDigest,
    runtimeConfigDigest: params.runtimeConfigDigest,
    protocolContractRevision: params.protocolContractRevision,
    runnerArtifactDigest,
    cases: caseResults.map((result) => ({
      caseId: result.caseId,
      passed: result.passed,
      evidenceDigest: result.evidenceDigest,
    })),
  });

  return {
    runId: randomUUID(),
    runtimeRevisionId: params.runtimeRevisionId,
    runtimeArtifactDigest: params.runtimeArtifactDigest,
    runtimeConfigDigest: params.runtimeConfigDigest,
    protocolContractRevision: params.protocolContractRevision,
    suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
    runnerArtifactDigest,
    runnerIdentity: RUNNER_IDENTITY,
    testEnvironmentRevision: TEST_ENVIRONMENT_REVISION,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    overallResult: allPassed ? "passed" : "failed",
    evidenceManifestDigest,
    caseResults: caseResults.map((result) => ({
      caseId: result.caseId,
      passed: result.passed,
      reason: result.passed ? null : (result.reason ?? null),
      evidenceDigest: result.evidenceDigest,
      evidence: result.evidence,
    })),
  };
}

/** 真实 MySQL + DSSE 的测试装配：先记录可信 Run，再通过正式发布服务发布。 */
export async function publishRuntimeRevisionForTest(params: {
  tenantId: string;
  revisionId: string;
  runtimeExpectedVersionNo: number;
  attestationId: string;
}) {
  const revision = await getRuntimeRevisionById(params.revisionId);
  if (!revision) {
    throw new Error(`测试 RuntimeRevision 不存在: ${params.revisionId}`);
  }
  const found = await getAttestationById(params.tenantId, params.attestationId);
  const attestation = found?.attestation;
  if (!attestation?.artifactId || attestation.verificationState !== "verified") {
    throw new Error(`测试 RuntimeRevision 缺少权威 Attestation: ${params.revisionId}`);
  }
  // helper 只校验 Revision 上 artifactId/artifactDigest 与权威 verified Attestation 精确一致；
  // 不一致 fail-closed。不直接更新数据库绑定 artifact（那是正式 createRecordArtifactAttestation 的职责）。
  if (
    !revision.artifactId ||
    revision.artifactId !== attestation.artifactId ||
    !revision.artifactDigest ||
    revision.artifactDigest !== attestation.artifactDigest
  ) {
    throw new Error(
      `测试 RuntimeRevision 的 artifactId/artifactDigest 与权威 Attestation 不一致: ${params.revisionId}`,
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(revision.configHash)) {
    throw new Error(
      `测试 RuntimeRevision 的 configHash 非法（非真实 sha256）: ${params.revisionId}`,
    );
  }

  // 运行正式 Publication Conformance；任一 case 失败（含 fail-closed）→ 拦截发布。
  const report = await runPublicationConformanceForTest({
    tenantId: params.tenantId,
    runtimeRevisionId: revision.id,
    runtimeArtifactDigest: revision.artifactDigest,
    runtimeConfigDigest: revision.configHash,
    protocolContractRevision: revision.protocolContractRevision,
  });
  assertPublicationConformancePassed(report);

  const runId = report.runId;
  const dsseEnvelope = buildDsseConformanceEnvelope(report, TEST_RUNNER_KEY);
  await createRecordRuntimeConformanceRun({
    store: mysqlRuntimeConformanceRunStore,
    verifier: createDSSEConformanceVerifier({
      runnerIdentityRegistry: new RunnerSigningIdentityRegistry([
        {
          keyId: TEST_RUNNER_KEY.keyid,
          publicKey: TEST_RUNNER_KEY.publicKeyBase64,
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
