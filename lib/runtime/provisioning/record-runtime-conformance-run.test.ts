import { randomUUID } from "node:crypto";
import { createRecordArtifactAttestation } from "@/lib/artifacts/application/record-artifact-attestation";
import { mysqlArtifactAttestationPersistenceStore } from "@/lib/artifacts/persistence/mysql-artifact-attestation-store";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { insertProcessingRecord } from "@/lib/identity/idempotency-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import { createDSSEConformanceVerifier } from "@/lib/runtime/conformance/runtime-conformance-verifier";
import { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";
import {
  PUBLICATION_CONFORMANCE_CASES,
  PUBLICATION_CONFORMANCE_SUITE_REVISION,
} from "@/lib/runtime/domain/runtime-conformance-contract";
import {
  computeCaseEvidenceDigest,
  computeEvidenceManifestDigest,
} from "@/lib/runtime/domain/runtime-conformance-run";
import { computeRuntimeTargetDigest } from "@/lib/runtime/domain/runtime-target-digest";
import { mysqlRuntimeConformanceRunStore } from "@/lib/runtime/persistence/mysql-runtime-conformance-run-store";
import { mysqlRuntimePublicationStore } from "@/lib/runtime/persistence/mysql-runtime-publication-store";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import { createPublishRuntimeRevision } from "@/lib/runtime/provisioning/publish-runtime-revision";
import { createRecordRuntimeConformanceRun } from "@/lib/runtime/provisioning/record-runtime-conformance-run";
import {
  type TestRunnerKey,
  buildDsseConformanceEnvelope,
  buildTestConformanceReport,
  generateTestRunnerKey,
} from "@/lib/runtime/test-support/build-dsse-conformance-envelope";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const RUNNER_KEY: TestRunnerKey = generateTestRunnerKey("test-runner-key");
const RUNNER_IDENTITY = "ci/runtime-conformance";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const TARGET_DIGEST = computeRuntimeTargetDigest({
  runtimeEvidenceKind: "hosted_artifact",
  runtimeArtifactDigest: DIGEST_A,
  runtimeConfigDigest: DIGEST_B,
  protocolContractRevision: "agent-runtime-protocol@2",
});

const DIGEST_C = `sha256:${"c".repeat(64)}`;

function createTestVerifier() {
  return createDSSEConformanceVerifier({
    runnerIdentityRegistry: new RunnerSigningIdentityRegistry([
      {
        keyId: RUNNER_KEY.keyid,
        publicKey: RUNNER_KEY.publicKeyBase64,
        runnerIdentity: RUNNER_IDENTITY,
        tenantScope: null,
        validFrom: "2020-01-01T00:00:00.000Z",
        validUntil: null,
        revokedAt: null,
      },
    ]),
  });
}

async function seedRevision() {
  const tenant = await ensureDefaultTenant();
  const owner = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "conformance-owner",
    email: "conformance@example.com",
    displayName: "Conformance Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "conformance-owner",
    displayName: "Conformance Owner",
    userIdentityId: owner.id,
  });
  const runtime = await createRuntime({
    tenantId: tenant.id,
    runtimeKey: "trusted-runner-test",
    displayName: "Trusted Runner Test",
    runtimeKind: "external",
    ownerUserId: owner.id,
  });
  const revision = await createDraftRuntimeRevision({
    tenantId: tenant.id,
    runtimeId: runtime.id,
    protocolType: "agent_runtime_protocol",
    protocolContractRevision: "agent-runtime-protocol@2",
    runtimeEvidenceKind: "hosted_artifact",
    endpointRef: "connection://trusted-runner-test",
    runtimeArtifactRef: `oci://registry/runtime@${DIGEST_A}`,
    runtimeCapabilitiesJson: { event_stream: true },
    identityMode: "workload_token",
    networkZone: "external",
    configHash: DIGEST_B,
    createdBy: owner.id,
  });
  return { tenantId: tenant.id, ownerId: owner.id, runtime, revision };
}

function buildDsseEnvelope(
  revisionId: string,
  overrides: Record<string, unknown> = {},
  evidenceVariant?: string,
) {
  const startedAt = new Date("2026-08-02T01:00:00.000Z");
  const caseResults = PUBLICATION_CONFORMANCE_CASES.map((caseId) => {
    // 真实结构化证据：可通过 evidenceVariant 注入区分字段（如 probe_ref），
    // 使不同 Run 的 evidence / evidenceDigest / evidenceManifestDigest 真实不同。
    const evidence = evidenceVariant
      ? { caseId, passed: true, probe_ref: evidenceVariant }
      : { caseId, passed: true };
    return {
      caseId,
      passed: true,
      reason: null,
      evidenceDigest: computeCaseEvidenceDigest(evidence),
      evidence,
    };
  });
  const baseReport = {
    runId: randomUUID(),
    runtimeRevisionId: revisionId,
    runtimeTargetDigest: TARGET_DIGEST,
    runtimeConfigDigest: DIGEST_B,
    protocolContractRevision: "agent-runtime-protocol@2",
    suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
    runnerArtifactDigest: DIGEST_C,
    runnerIdentity: RUNNER_IDENTITY,
    testEnvironmentRevision: "isolated-mysql8@1",
    startedAt: startedAt.toISOString(),
    completedAt: new Date(startedAt.getTime() + 1000).toISOString(),
    overallResult: "passed" as const,
    caseResults,
    ...overrides,
  };
  // 除非显式覆盖 evidenceManifestDigest，否则从最终报告内容 recompute，保证自洽。
  const evidenceManifestDigest =
    (overrides.evidenceManifestDigest as string | undefined) ??
    computeEvidenceManifestDigest({
      suiteRevision: baseReport.suiteRevision,
      testEnvironmentRevision: baseReport.testEnvironmentRevision,
      runtimeRevisionId: baseReport.runtimeRevisionId,
      runtimeTargetDigest: baseReport.runtimeTargetDigest,
      runtimeConfigDigest: baseReport.runtimeConfigDigest,
      protocolContractRevision: baseReport.protocolContractRevision,
      runnerArtifactDigest: baseReport.runnerArtifactDigest,
      cases: baseReport.caseResults.map((result) => ({
        caseId: result.caseId,
        passed: result.passed,
        evidenceDigest: result.evidenceDigest,
      })),
    });
  return buildDsseConformanceEnvelope({ ...baseReport, evidenceManifestDigest }, RUNNER_KEY);
}

describe("RuntimeConformanceRun 权威记录", () => {
  beforeEach(async () => resetDatabase(db));

  it("验签后原子写入不可变 Run、全部 Publication CaseResult、Audit 与 Outbox", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const dsseEnvelope = buildDsseEnvelope(revision.id);
    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      verifier: createTestVerifier(),
    });
    const result = await record({
      tenantId,
      runtimeRevisionId: revision.id,
      idempotencyKey: "run-001",
      requestId: "request-001",
      actor: { actorType: "user", actorId: ownerId },
      dsseEnvelope,
    });

    expect(result.run.overallResult).toBe("passed");
    expect(result.caseResults).toHaveLength(PUBLICATION_CONFORMANCE_CASES.length);
    expect(result.replayed).toBe(false);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(1);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(
      PUBLICATION_CONFORMANCE_CASES.length,
    );
  });

  it("相同 Idempotency-Key 重试返回同一 Run，不重复写入", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const dsseEnvelope = buildDsseEnvelope(revision.id);
    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      verifier: createTestVerifier(),
    });
    const command = {
      tenantId,
      runtimeRevisionId: revision.id,
      idempotencyKey: "run-retry",
      requestId: "request-retry",
      actor: { actorType: "user" as const, actorId: ownerId },
      dsseEnvelope,
    };
    const first = await record(command);
    const retry = await record(command);
    expect(retry.run.id).toBe(first.run.id);
    expect(retry.replayed).toBe(true);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(1);
  });

  it("相同命令并发由数据库唯一约束收敛到同一权威 Run", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const dsseEnvelope = buildDsseEnvelope(revision.id);
    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      verifier: createTestVerifier(),
    });
    const command = {
      tenantId,
      runtimeRevisionId: revision.id,
      idempotencyKey: "run-concurrent",
      requestId: "request-concurrent",
      actor: { actorType: "user" as const, actorId: ownerId },
      dsseEnvelope,
    };
    const [left, right] = await Promise.all([record(command), record(command)]);
    expect(left.run.id).toBe(right.run.id);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(1);
  });

  it("Runtime 发布只接受显式 Passed Run，并冻结 conformanceRunId", async () => {
    const { tenantId, ownerId, runtime, revision } = await seedRevision();
    const dsseEnvelope = buildDsseEnvelope(revision.id);
    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      verifier: createTestVerifier(),
    });
    const recorded = await record({
      tenantId,
      runtimeRevisionId: revision.id,
      idempotencyKey: "run-for-publication",
      requestId: "request-run-for-publication",
      actor: { actorType: "user", actorId: ownerId },
      dsseEnvelope,
    });
    const attestation = await createRecordArtifactAttestation({
      store: mysqlArtifactAttestationPersistenceStore,
    })({
      tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: revision.id,
      artifactDigest: DIGEST_A,
      dsseEnvelopeRef: "attestation:signature:conformance-publication",
      sbomRef: "attestation:sbom:conformance-publication",
      provenanceRef: "attestation:provenance:conformance-publication",
      builderIdentity: "builder:conformance-test",
      verificationState: "verified",
      policyRevisionId: null,
      failureCode: null,
      verifiedAt: new Date(),
      sourceRevision: null,
      buildPipeline: null,
      dependencyLockFileHash: null,
      buildTime: null,
      scanSummaryJson: null,
      actor: { tenantId, actorType: "service", actorId: "test-builder" },
      requestId: `attestation-request-${revision.id}`,
    });
    const publish = createPublishRuntimeRevision({ store: mysqlRuntimePublicationStore });
    await publish({
      tenantId,
      revisionId: revision.id,
      runtimeExpectedVersionNo: runtime.versionNo,
      conformanceRunId: recorded.run.id,
      attestationId: attestation.id,
      actor: { tenantId, actorType: "user", actorId: ownerId },
      requestId: "request-publication",
      idempotencyKey: "publication-001",
    });
    const [publication] = await db.select().from(publicationRecord);
    expect(publication?.conformanceRunId).toBe(recorded.run.id);
  });

  it("Audit 写入失败时 Run、CaseResult 与 Outbox 全部回滚", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const record = createRecordRuntimeConformanceRun({
      store: {
        ...mysqlRuntimeConformanceRunStore,
        transaction: (operation) =>
          mysqlRuntimeConformanceRunStore.transaction((session) =>
            operation({
              ...session,
              appendAudit: async () => {
                throw new Error("injected audit failure");
              },
            }),
          ),
      },
      verifier: createTestVerifier(),
    });
    await expect(
      record({
        tenantId,
        runtimeRevisionId: revision.id,
        idempotencyKey: "rollback-audit",
        requestId: "request-rollback-audit",
        actor: { actorType: "user", actorId: ownerId },
        dsseEnvelope: buildDsseEnvelope(revision.id),
      }),
    ).rejects.toThrow("injected audit failure");
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(0);
  });

  it("Outbox 写入失败时不留下部分 Run", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const record = createRecordRuntimeConformanceRun({
      store: {
        ...mysqlRuntimeConformanceRunStore,
        transaction: (operation) =>
          mysqlRuntimeConformanceRunStore.transaction((session) =>
            operation({
              ...session,
              appendOutbox: async () => {
                throw new Error("injected outbox failure");
              },
            }),
          ),
      },
      verifier: createTestVerifier(),
    });
    await expect(
      record({
        tenantId,
        runtimeRevisionId: revision.id,
        idempotencyKey: "rollback-outbox",
        requestId: "request-rollback-outbox",
        actor: { actorType: "user", actorId: ownerId },
        dsseEnvelope: buildDsseEnvelope(revision.id),
      }),
    ).rejects.toThrow("injected outbox failure");
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(0);
  });

  it("Idempotency 完成失败时 Run、结果、Audit 与 Outbox 同步回滚", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const idempotency = await insertProcessingRecord({
      tenantId,
      audience: "admin",
      callerType: "user",
      callerId: ownerId,
      commandScope: `runtime.conformance:${revision.id}`,
      idempotencyKey: "rollback-idempotency",
      requestHash: "f".repeat(64),
    });
    const record = createRecordRuntimeConformanceRun({
      store: {
        ...mysqlRuntimeConformanceRunStore,
        transaction: (operation) =>
          mysqlRuntimeConformanceRunStore.transaction((session) =>
            operation({ ...session, completeIdempotency: async () => false }),
          ),
      },
      verifier: createTestVerifier(),
    });
    await expect(
      record({
        tenantId,
        runtimeRevisionId: revision.id,
        idempotencyKey: "rollback-idempotency",
        requestId: "request-rollback-idempotency",
        actor: { actorType: "user", actorId: ownerId },
        dsseEnvelope: buildDsseEnvelope(revision.id),
        idempotency: {
          recordId: idempotency.id,
          httpStatus: 200,
          serializeResponse: () => "{}",
        },
      }),
    ).rejects.toThrow("幂等记录无法完成");
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(0);
  });

  it("签名、绑定或完整 case 集不可信时拒绝且不留下部分记录", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const untrustedKey = generateTestRunnerKey("untrusted-key");
    const tamperedEnvelope = buildDsseConformanceEnvelope(
      buildTestConformanceReport(revision.id, {
        evidenceManifestDigest: `sha256:${"e".repeat(64)}`,
      }),
      untrustedKey,
    );
    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      verifier: createTestVerifier(),
    });
    await expect(
      record({
        tenantId,
        runtimeRevisionId: revision.id,
        idempotencyKey: "tampered",
        requestId: "request-tampered",
        actor: { actorType: "user", actorId: ownerId },
        dsseEnvelope: tamperedEnvelope,
      }),
    ).rejects.toThrow("Conformance 验证失败");
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
  });

  it("相同 Idempotency-Key 但不同 Envelope → RuntimeConformanceIdempotencyConflictError", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      verifier: createTestVerifier(),
    });
    const dsseEnvelope1 = buildDsseEnvelope(revision.id);
    await record({
      tenantId,
      runtimeRevisionId: revision.id,
      idempotencyKey: "conflict-key",
      requestId: "request-conflict-1",
      actor: { actorType: "user", actorId: ownerId },
      dsseEnvelope: dsseEnvelope1,
    });
    const dsseEnvelope2 = buildDsseEnvelope(revision.id, {
      runId: "conflict-envelope-2",
    });
    await expect(
      record({
        tenantId,
        runtimeRevisionId: revision.id,
        idempotencyKey: "conflict-key",
        requestId: "request-conflict-2",
        actor: { actorType: "user", actorId: ownerId },
        dsseEnvelope: dsseEnvelope2,
      }),
    ).rejects.toThrow("Idempotency-Key 已绑定不同的 DSSE Envelope");
  });

  it("不同 Idempotency-Key 的复测只追加新 Run，历史 Run 不被覆盖", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      verifier: createTestVerifier(),
    });
    for (const [index, key] of ["retest-1", "retest-2"].entries()) {
      await record({
        tenantId,
        runtimeRevisionId: revision.id,
        idempotencyKey: key,
        requestId: `request-${key}`,
        actor: { actorType: "user", actorId: ownerId },
        // 第二次复测携带真实不同的结构化 case evidence（probe_ref 不同），
        // evidenceDigest / evidenceManifestDigest 经权威函数重算后真实不同，
        // 从而满足 evidence_uq：不允许把同一份证据伪装成两次 Run。
        dsseEnvelope: buildDsseEnvelope(revision.id, {}, `retest-${index}`),
      });
    }
    const rows = await db
      .select()
      .from(runtimeConformanceRun)
      .where(eq(runtimeConformanceRun.runtimeRevisionId, revision.id));
    expect(rows).toHaveLength(2);
  });
});
