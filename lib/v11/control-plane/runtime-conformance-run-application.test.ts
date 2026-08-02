import { createHmac, randomUUID } from "node:crypto";
import { mysqlRuntimeConformanceRunStore } from "@/lib/compatibility/runtimes/mysql-runtime-conformance-run-store";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import { createPublishRuntimeRevision } from "@/lib/runtimes/application/publish-runtime-revision";
import { createRecordRuntimeConformanceRun } from "@/lib/runtimes/application/record-runtime-conformance-run";
import {
  ALL_CONFORMANCE_CASES,
  canonicalizeRuntimeConformanceReport,
} from "@/lib/runtimes/domain/runtime-conformance-run";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import { mysqlRuntimePublicationStore } from "@/lib/v11/control-plane/mysql-runtime-publication-store";
import { createRuntime } from "@/lib/v11/control-plane/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/v11/control-plane/runtime-revision-queries";
import { insertProcessingRecord } from "@/lib/v11/identity/idempotency-queries";
import { upsertPrincipalBinding } from "@/lib/v11/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const SECRET = "test-runner-secret-with-at-least-32-bytes";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

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

function buildSignedReport(revisionId: string, overrides: Record<string, unknown> = {}) {
  const startedAt = new Date("2026-08-02T01:00:00.000Z");
  const report = {
    runId: randomUUID(),
    runtimeRevisionId: revisionId,
    runtimeArtifactDigest: DIGEST_A,
    runtimeConfigDigest: DIGEST_B,
    protocolContractRevision: "agent-runtime-protocol@1",
    suiteRevision: "runtime-conformance@1",
    runnerArtifactDigest: DIGEST_C,
    runnerIdentity: "ci/runtime-conformance",
    testEnvironmentRevision: "isolated-mysql8@1",
    startedAt: startedAt.toISOString(),
    completedAt: new Date(startedAt.getTime() + 1000).toISOString(),
    overallResult: "passed" as const,
    evidenceManifestDigest: `sha256:${"d".repeat(64)}`,
    caseResults: ALL_CONFORMANCE_CASES.map((caseId, index) => ({
      caseId,
      passed: true,
      reason: null,
      evidenceDigest: `sha256:${index.toString(16).padStart(64, "0")}`,
    })),
    ...overrides,
  };
  const signature = createHmac("sha256", SECRET)
    .update(canonicalizeRuntimeConformanceReport(report))
    .digest("hex");
  return { report, signature };
}

describe("RuntimeConformanceRun 权威记录", () => {
  beforeEach(async () => resetDatabase(db));

  it("验签后原子写入不可变 Run、16 个 CaseResult、Audit 与 Outbox", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const signed = buildSignedReport(revision.id);
    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      signingSecret: () => SECRET,
    });
    const result = await record({
      tenantId,
      runtimeRevisionId: revision.id,
      idempotencyKey: "run-001",
      requestId: "request-001",
      actor: { actorType: "user", actorId: ownerId },
      ...signed,
    });

    expect(result.run.overallResult).toBe("passed");
    expect(result.caseResults).toHaveLength(16);
    expect(result.replayed).toBe(false);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(1);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(16);
  });

  it("相同 Idempotency-Key 重试返回同一 Run，不重复写入", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const signed = buildSignedReport(revision.id);
    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      signingSecret: () => SECRET,
    });
    const command = {
      tenantId,
      runtimeRevisionId: revision.id,
      idempotencyKey: "run-retry",
      requestId: "request-retry",
      actor: { actorType: "user" as const, actorId: ownerId },
      ...signed,
    };
    const first = await record(command);
    const retry = await record(command);
    expect(retry.run.id).toBe(first.run.id);
    expect(retry.replayed).toBe(true);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(1);
  });

  it("相同命令并发由数据库唯一约束收敛到同一权威 Run", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const signed = buildSignedReport(revision.id);
    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      signingSecret: () => SECRET,
    });
    const command = {
      tenantId,
      runtimeRevisionId: revision.id,
      idempotencyKey: "run-concurrent",
      requestId: "request-concurrent",
      actor: { actorType: "user" as const, actorId: ownerId },
      ...signed,
    };
    const [left, right] = await Promise.all([record(command), record(command)]);
    expect(left.run.id).toBe(right.run.id);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(1);
  });

  it("Runtime 发布只接受显式 Passed Run，并冻结 conformanceRunId", async () => {
    const { tenantId, ownerId, runtime, revision } = await seedRevision();
    const signed = buildSignedReport(revision.id);
    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      signingSecret: () => SECRET,
    });
    const recorded = await record({
      tenantId,
      runtimeRevisionId: revision.id,
      idempotencyKey: "run-for-publication",
      requestId: "request-run-for-publication",
      actor: { actorType: "user", actorId: ownerId },
      ...signed,
    });
    const publish = createPublishRuntimeRevision({ store: mysqlRuntimePublicationStore });
    await publish({
      tenantId,
      revisionId: revision.id,
      runtimeExpectedVersionNo: runtime.versionNo,
      conformanceRunId: recorded.run.id,
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
      signingSecret: () => SECRET,
    });
    await expect(
      record({
        tenantId,
        runtimeRevisionId: revision.id,
        idempotencyKey: "rollback-audit",
        requestId: "request-rollback-audit",
        actor: { actorType: "user", actorId: ownerId },
        ...buildSignedReport(revision.id),
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
      signingSecret: () => SECRET,
    });
    await expect(
      record({
        tenantId,
        runtimeRevisionId: revision.id,
        idempotencyKey: "rollback-outbox",
        requestId: "request-rollback-outbox",
        actor: { actorType: "user", actorId: ownerId },
        ...buildSignedReport(revision.id),
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
      signingSecret: () => SECRET,
    });
    await expect(
      record({
        tenantId,
        runtimeRevisionId: revision.id,
        idempotencyKey: "rollback-idempotency",
        requestId: "request-rollback-idempotency",
        actor: { actorType: "user", actorId: ownerId },
        ...buildSignedReport(revision.id),
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
    const signed = buildSignedReport(revision.id);
    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      signingSecret: () => SECRET,
    });
    await expect(
      record({
        tenantId,
        runtimeRevisionId: revision.id,
        idempotencyKey: "tampered",
        requestId: "request-tampered",
        actor: { actorType: "user", actorId: ownerId },
        report: { ...signed.report, evidenceManifestDigest: `sha256:${"e".repeat(64)}` },
        signature: signed.signature,
      }),
    ).rejects.toThrow("签名");
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
  });

  it("不同 Idempotency-Key 的复测只追加新 Run，历史 Run 不被覆盖", async () => {
    const { tenantId, ownerId, revision } = await seedRevision();
    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      signingSecret: () => SECRET,
    });
    for (const [index, key] of ["retest-1", "retest-2"].entries()) {
      await record({
        tenantId,
        runtimeRevisionId: revision.id,
        idempotencyKey: key,
        requestId: `request-${key}`,
        actor: { actorType: "user", actorId: ownerId },
        ...buildSignedReport(revision.id, {
          evidenceManifestDigest: `sha256:${String(index + 1).repeat(64)}`,
        }),
      });
    }
    const rows = await db
      .select()
      .from(runtimeConformanceRun)
      .where(eq(runtimeConformanceRun.runtimeRevisionId, revision.id));
    expect(rows).toHaveLength(2);
  });
});
