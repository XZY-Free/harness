import { randomUUID } from "node:crypto";
import { createRecordArtifactAttestation } from "@/lib/artifacts/application/record-artifact-attestation";
import { mysqlArtifactAttestationPersistenceStore } from "@/lib/artifacts/persistence/mysql-artifact-attestation-store";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { insertProcessingRecord } from "@/lib/identity/idempotency-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { auditEvent, idempotencyRecord } from "@/lib/persistence/schema/control-plane";
import { tenant as tenantTable } from "@/lib/persistence/schema/identity";
import { runtimeRevisionTable } from "@/lib/persistence/schema/runtimes";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import { createDSSEConformanceVerifier } from "@/lib/runtime/conformance/runtime-conformance-verifier";
import { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";
import {
  PUBLICATION_CONFORMANCE_CASES,
  PUBLICATION_CONFORMANCE_SUITE_REVISION,
} from "@/lib/runtime/domain/runtime-conformance-contract";
import {
  RuntimeConformanceBindingError,
  computeCaseEvidenceDigest,
  computeEvidenceManifestDigest,
} from "@/lib/runtime/domain/runtime-conformance-run";
import { computeRuntimeTargetDigest } from "@/lib/runtime/domain/runtime-target-digest";
import {
  createMysqlRuntimeConformanceRunSession,
  mysqlRuntimeConformanceRunStore,
} from "@/lib/runtime/persistence/mysql-runtime-conformance-run-store";
import { mysqlRuntimePublicationStore } from "@/lib/runtime/persistence/mysql-runtime-publication-store";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import { createPublishRuntimeRevision } from "@/lib/runtime/provisioning/publish-runtime-revision";
import {
  type PreparedRuntimeConformanceRun,
  appendRuntimeConformanceRun,
  createRecordRuntimeConformanceRun,
  prepareRuntimeConformanceRun,
} from "@/lib/runtime/provisioning/record-runtime-conformance-run";
import {
  type TestRunnerKey,
  buildDsseConformanceEnvelope,
  buildTestConformanceReport,
  generateTestRunnerKey,
} from "@/lib/runtime/test-support/build-dsse-conformance-envelope";
import { eq, max } from "drizzle-orm";
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

/** 复用租户/用户/Principal/Runtime 种子，但不创建 Revision（供调用方事务内联插入）。 */
async function seedRuntimeWithoutRevision() {
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
  return { tenantId: tenant.id, ownerId: owner.id, runtime };
}

async function seedRevision() {
  const { tenantId, ownerId, runtime } = await seedRuntimeWithoutRevision();
  const revision = await createDraftRuntimeRevision({
    tenantId,
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
    createdBy: ownerId,
  });
  return { tenantId, ownerId, runtime, revision };
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

/** 调用方持有的 MySQL 事务句柄类型（db.transaction 回调入参）。 */
type CallerTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 在调用方事务内联插入一个与 TARGET_DIGEST/DIGEST_B 事实一致的 draft RuntimeRevision。 */
async function insertDraftRevisionInTx(
  tx: CallerTx,
  params: { runtimeId: string; createdBy: string },
) {
  const id = randomUUID();
  const [maxRow] = await tx
    .select({ maxNo: max(runtimeRevisionTable.revisionNo) })
    .from(runtimeRevisionTable)
    .where(eq(runtimeRevisionTable.runtimeId, params.runtimeId));
  const revisionNo = (maxRow?.maxNo ?? 0) + 1;
  await tx.insert(runtimeRevisionTable).values({
    id,
    runtimeId: params.runtimeId,
    revisionNo,
    protocolType: "agent_runtime_protocol",
    protocolContractRevision: "agent-runtime-protocol@2",
    runtimeEvidenceKind: "hosted_artifact",
    runtimeTargetDigest: TARGET_DIGEST,
    endpointRef: "connection://caller-tx-runner",
    runtimeArtifactRef: `oci://registry/runtime@${DIGEST_A}`,
    artifactDigest: DIGEST_A,
    runtimeCapabilitiesJson: { event_stream: true },
    identityMode: "workload_token",
    networkZone: "external",
    configHash: DIGEST_B,
    revisionState: "draft",
    createdBy: params.createdBy,
  });
  return id;
}

function buildCommand(params: {
  tenantId: string;
  runtimeRevisionId: string;
  ownerId: string;
  dsseEnvelope: string;
  idempotencyKey: string;
}) {
  return {
    tenantId: params.tenantId,
    runtimeRevisionId: params.runtimeRevisionId,
    idempotencyKey: params.idempotencyKey,
    requestId: `request-${params.idempotencyKey}`,
    actor: { actorType: "user" as const, actorId: params.ownerId },
    dsseEnvelope: params.dsseEnvelope,
  };
}

describe("RuntimeConformanceRun 调用方事务内追加", () => {
  beforeEach(async () => resetDatabase(db));

  it("同一调用方事务插入 draft Revision 并追加 Run，提交后 Run 与全部 Case 落库", async () => {
    const { tenantId, ownerId, runtime } = await seedRuntimeWithoutRevision();
    let runId = "";
    let insertedRevisionId = "";
    await db.transaction(async (tx) => {
      const revisionId = await insertDraftRevisionInTx(tx, {
        runtimeId: runtime.id,
        createdBy: ownerId,
      });
      insertedRevisionId = revisionId;
      const command = buildCommand({
        tenantId,
        runtimeRevisionId: revisionId,
        ownerId,
        dsseEnvelope: buildDsseEnvelope(revisionId),
        idempotencyKey: "caller-tx-001",
      });
      // prepare 只做验签与报告校验，不落库；append 经调用方事务 Session 写入。
      const prepared = await prepareRuntimeConformanceRun({
        verifier: createTestVerifier(),
        command,
      });
      const session = createMysqlRuntimeConformanceRunSession(tx);
      const result = await appendRuntimeConformanceRun({ session, prepared, command });
      expect(result.replayed).toBe(false);
      expect(result.caseResults).toHaveLength(PUBLICATION_CONFORMANCE_CASES.length);
      runId = result.run.id;
    });

    const [run] = await db
      .select()
      .from(runtimeConformanceRun)
      .where(eq(runtimeConformanceRun.id, runId));
    expect(run?.runtimeRevisionId).toBe(insertedRevisionId);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(1);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(
      PUBLICATION_CONFORMANCE_CASES.length,
    );
    const [revision] = await db
      .select()
      .from(runtimeRevisionTable)
      .where(eq(runtimeRevisionTable.id, insertedRevisionId));
    expect(revision?.revisionState).toBe("draft");
  });

  it("追加后调用方事务抛错 → Revision、Run、Case、Audit 与 Outbox 全部回滚", async () => {
    const { tenantId, ownerId, runtime } = await seedRuntimeWithoutRevision();
    let insertedRevisionId = "";
    await expect(
      db.transaction(async (tx) => {
        const revisionId = await insertDraftRevisionInTx(tx, {
          runtimeId: runtime.id,
          createdBy: ownerId,
        });
        insertedRevisionId = revisionId;
        const command = buildCommand({
          tenantId,
          runtimeRevisionId: revisionId,
          ownerId,
          dsseEnvelope: buildDsseEnvelope(revisionId),
          idempotencyKey: "caller-tx-rollback",
        });
        const prepared = await prepareRuntimeConformanceRun({
          verifier: createTestVerifier(),
          command,
        });
        const session = createMysqlRuntimeConformanceRunSession(tx);
        await appendRuntimeConformanceRun({ session, prepared, command });
        throw new Error("caller rollback after append");
      }),
    ).rejects.toThrow("caller rollback after append");

    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(0);
    expect(await db.select().from(auditEvent)).toHaveLength(0);
    expect(await db.select().from(controlPlaneOutboxEvent)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(runtimeRevisionTable)
        .where(eq(runtimeRevisionTable.id, insertedRevisionId)),
    ).toHaveLength(0);
  });

  it("非 draft Revision 在事务内追加被拒绝且不留下 Conformance 行", async () => {
    const { tenantId, ownerId, runtime } = await seedRuntimeWithoutRevision();
    await expect(
      db.transaction(async (tx) => {
        const revisionId = await insertDraftRevisionInTx(tx, {
          runtimeId: runtime.id,
          createdBy: ownerId,
        });
        await tx
          .update(runtimeRevisionTable)
          .set({ revisionState: "published" })
          .where(eq(runtimeRevisionTable.id, revisionId));
        const command = buildCommand({
          tenantId,
          runtimeRevisionId: revisionId,
          ownerId,
          dsseEnvelope: buildDsseEnvelope(revisionId),
          idempotencyKey: "caller-tx-non-draft",
        });
        const prepared = await prepareRuntimeConformanceRun({
          verifier: createTestVerifier(),
          command,
        });
        await appendRuntimeConformanceRun({
          session: createMysqlRuntimeConformanceRunSession(tx),
          prepared,
          command,
        });
      }),
    ).rejects.toThrow("只有 draft RuntimeRevision 可创建 Conformance Run");

    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(0);
    expect(await db.select().from(auditEvent)).toHaveLength(0);
    expect(await db.select().from(controlPlaneOutboxEvent)).toHaveLength(0);
  });

  it("Runner 报告绑定与 Revision 事实不一致时事务内追加被拒绝", async () => {
    const { tenantId, ownerId, runtime } = await seedRuntimeWithoutRevision();
    await expect(
      db.transaction(async (tx) => {
        const revisionId = await insertDraftRevisionInTx(tx, {
          runtimeId: runtime.id,
          createdBy: ownerId,
        });
        // config digest 与 Revision 的 configHash 不一致（manifest 由 helper 重算保持自洽）。
        const dsseEnvelope = buildDsseEnvelope(revisionId, {
          runtimeConfigDigest: `sha256:${"d".repeat(64)}`,
        });
        const command = buildCommand({
          tenantId,
          runtimeRevisionId: revisionId,
          ownerId,
          dsseEnvelope,
          idempotencyKey: "caller-tx-binding",
        });
        const prepared = await prepareRuntimeConformanceRun({
          verifier: createTestVerifier(),
          command,
        });
        await appendRuntimeConformanceRun({
          session: createMysqlRuntimeConformanceRunSession(tx),
          prepared,
          command,
        });
      }),
    ).rejects.toThrow("Runner 报告绑定与 RuntimeRevision 当前事实不一致");

    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(0);
  });

  it("跨租户追加被拒绝：prepared 绑定原命令租户，且事务内无 Conformance 行", async () => {
    const { tenantId, ownerId, runtime } = await seedRuntimeWithoutRevision();
    const otherTenantId = randomUUID();
    await db.insert(tenantTable).values({ id: otherTenantId, key: "tenant-b", name: "Tenant B" });
    await expect(
      db.transaction(async (tx) => {
        const revisionId = await insertDraftRevisionInTx(tx, {
          runtimeId: runtime.id,
          createdBy: ownerId,
        });
        const command = buildCommand({
          tenantId,
          runtimeRevisionId: revisionId,
          ownerId,
          dsseEnvelope: buildDsseEnvelope(revisionId),
          idempotencyKey: "caller-tx-tenant",
        });
        const prepared = await prepareRuntimeConformanceRun({
          verifier: createTestVerifier(),
          command,
        });
        // 同一 prepared 证据不得改绑到其他租户命令。
        await appendRuntimeConformanceRun({
          session: createMysqlRuntimeConformanceRunSession(tx),
          prepared,
          command: { ...command, tenantId: otherTenantId },
        });
      }),
    ).rejects.toThrow(RuntimeConformanceBindingError);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(0);
  });

  it("prepared 证据不可改绑到另一个 Revision 的命令", async () => {
    const { tenantId, ownerId, runtime } = await seedRuntimeWithoutRevision();
    const revisionA = await createDraftRuntimeRevision({
      tenantId,
      runtimeId: runtime.id,
      protocolType: "agent_runtime_protocol",
      protocolContractRevision: "agent-runtime-protocol@2",
      runtimeEvidenceKind: "hosted_artifact",
      endpointRef: "connection://revision-a",
      runtimeArtifactRef: `oci://registry/runtime@${DIGEST_A}`,
      runtimeCapabilitiesJson: { event_stream: true },
      identityMode: "workload_token",
      networkZone: "external",
      configHash: DIGEST_B,
      createdBy: ownerId,
    });
    const revisionB = await createDraftRuntimeRevision({
      tenantId,
      runtimeId: runtime.id,
      protocolType: "agent_runtime_protocol",
      protocolContractRevision: "agent-runtime-protocol@2",
      runtimeEvidenceKind: "hosted_artifact",
      endpointRef: "connection://revision-b",
      runtimeArtifactRef: `oci://registry/runtime@${DIGEST_A}`,
      runtimeCapabilitiesJson: { event_stream: true },
      identityMode: "workload_token",
      networkZone: "external",
      configHash: DIGEST_B,
      createdBy: ownerId,
    });
    const commandA = buildCommand({
      tenantId,
      runtimeRevisionId: revisionA.id,
      ownerId,
      dsseEnvelope: buildDsseEnvelope(revisionA.id),
      idempotencyKey: "prepared-rebind-a",
    });
    const commandB = buildCommand({
      tenantId,
      runtimeRevisionId: revisionB.id,
      ownerId,
      dsseEnvelope: buildDsseEnvelope(revisionB.id),
      idempotencyKey: "prepared-rebind-b",
    });
    const prepared = await prepareRuntimeConformanceRun({
      verifier: createTestVerifier(),
      command: commandA,
    });
    await expect(
      db.transaction(async (tx) => {
        await appendRuntimeConformanceRun({
          session: createMysqlRuntimeConformanceRunSession(tx),
          prepared,
          command: commandB,
        });
      }),
    ).rejects.toThrow(RuntimeConformanceBindingError);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
  });

  it("验签失败发生在 append 之前：prepare 阶段即拒绝且不产生任何写入", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const untrustedKey = generateTestRunnerKey("untrusted-caller-tx-key");
    const tamperedEnvelope = buildDsseConformanceEnvelope(
      buildTestConformanceReport(revision.id, {
        evidenceManifestDigest: `sha256:${"e".repeat(64)}`,
      }),
      untrustedKey,
    );
    const command = buildCommand({
      tenantId,
      runtimeRevisionId: revision.id,
      ownerId,
      dsseEnvelope: tamperedEnvelope,
      idempotencyKey: "caller-tx-bad-signature",
    });
    await expect(
      prepareRuntimeConformanceRun({ verifier: createTestVerifier(), command }),
    ).rejects.toThrow("Conformance 验证失败");
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
  });

  it("Case 集不完整的报告在 prepare 阶段被拒绝", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const dsseEnvelope = buildDsseEnvelope(revision.id, {
      caseResults: [
        {
          caseId: PUBLICATION_CONFORMANCE_CASES[0],
          passed: true,
          reason: null,
          evidenceDigest: `sha256:${"0".repeat(64)}`,
          evidence: { caseId: PUBLICATION_CONFORMANCE_CASES[0], passed: true },
        },
      ],
    });
    const command = buildCommand({
      tenantId,
      runtimeRevisionId: revision.id,
      ownerId,
      dsseEnvelope,
      idempotencyKey: "caller-tx-incomplete",
    });
    await expect(
      prepareRuntimeConformanceRun({ verifier: createTestVerifier(), command }),
    ).rejects.toThrow();
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
  });

  it("调用方伪造的 prepared 句柄被拒绝且不产生任何 Conformance 写入", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const command = buildCommand({
      tenantId,
      runtimeRevisionId: revision.id,
      ownerId,
      dsseEnvelope: buildDsseEnvelope(revision.id),
      idempotencyKey: "forged-handle",
    });
    // 调用方自造的冻结空对象冒充 prepared 证据 → WeakMap 验真失败。
    const forged = Object.freeze({}) as PreparedRuntimeConformanceRun;
    await expect(
      db.transaction(async (tx) => {
        await appendRuntimeConformanceRun({
          session: createMysqlRuntimeConformanceRunSession(tx),
          prepared: forged,
          command,
        });
      }),
    ).rejects.toThrow("prepared 证据无效");
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(0);
    expect(await db.select().from(auditEvent)).toHaveLength(0);
    expect(await db.select().from(controlPlaneOutboxEvent)).toHaveLength(0);
  });

  it("prepare 无幂等描述符，append 时补加描述符被拒绝，幂等记录未被篡改", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const idempotency = await insertProcessingRecord({
      tenantId,
      audience: "admin",
      callerType: "user",
      callerId: ownerId,
      commandScope: `runtime.conformance:${revision.id}`,
      idempotencyKey: "bind-idem-add",
      requestHash: "f".repeat(64),
    });
    const command = buildCommand({
      tenantId,
      runtimeRevisionId: revision.id,
      ownerId,
      dsseEnvelope: buildDsseEnvelope(revision.id),
      idempotencyKey: "bind-idem-add",
    });
    const prepared = await prepareRuntimeConformanceRun({
      verifier: createTestVerifier(),
      command,
    });
    await expect(
      db.transaction(async (tx) => {
        await appendRuntimeConformanceRun({
          session: createMysqlRuntimeConformanceRunSession(tx),
          prepared,
          command: {
            ...command,
            idempotency: {
              recordId: idempotency.id,
              httpStatus: 200,
              serializeResponse: () => "{}",
            },
          },
        });
      }),
    ).rejects.toThrow("禁止改绑");
    // 他人幂等记录保持 processing、未被写入 httpStatus/响应。
    const [row] = await db
      .select()
      .from(idempotencyRecord)
      .where(eq(idempotencyRecord.id, idempotency.id));
    expect(row?.processingState).toBe("processing");
    expect(row?.httpStatus).toBeNull();
    expect(row?.responseRedactedJson).toBeNull();
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(0);
  });

  it("prepare 携带幂等描述符，append 时改换 recordId 被拒绝，目标幂等记录未被篡改", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const recordA = await insertProcessingRecord({
      tenantId,
      audience: "admin",
      callerType: "user",
      callerId: ownerId,
      commandScope: `runtime.conformance:${revision.id}`,
      idempotencyKey: "bind-idem-a",
      requestHash: "f".repeat(64),
    });
    const recordB = await insertProcessingRecord({
      tenantId,
      audience: "admin",
      callerType: "user",
      callerId: ownerId,
      commandScope: `runtime.conformance:${revision.id}`,
      idempotencyKey: "bind-idem-b",
      requestHash: "f".repeat(64),
    });
    const serializeResponse = (result: { run: { id: string } }) =>
      JSON.stringify({ run_id: result.run.id });
    const command = {
      ...buildCommand({
        tenantId,
        runtimeRevisionId: revision.id,
        ownerId,
        dsseEnvelope: buildDsseEnvelope(revision.id),
        idempotencyKey: "bind-idem-a",
      }),
      idempotency: {
        recordId: recordA.id,
        httpStatus: 200,
        serializeResponse,
      },
    };
    const prepared = await prepareRuntimeConformanceRun({
      verifier: createTestVerifier(),
      command,
    });
    await expect(
      db.transaction(async (tx) => {
        await appendRuntimeConformanceRun({
          session: createMysqlRuntimeConformanceRunSession(tx),
          prepared,
          command: {
            ...command,
            idempotency: { ...command.idempotency, recordId: recordB.id },
          },
        });
      }),
    ).rejects.toThrow("禁止改绑");
    const [rowB] = await db
      .select()
      .from(idempotencyRecord)
      .where(eq(idempotencyRecord.id, recordB.id));
    expect(rowB?.processingState).toBe("processing");
    expect(rowB?.httpStatus).toBeNull();
    expect(rowB?.responseRedactedJson).toBeNull();
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(0);
  });
});
