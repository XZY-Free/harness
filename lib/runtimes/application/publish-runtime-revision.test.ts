import { createHmac, randomUUID } from "node:crypto";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { createRecordArtifactAttestation } from "@/lib/artifacts/application/record-artifact-attestation";
import { mysqlArtifactAttestationPersistenceStore } from "@/lib/artifacts/persistence/mysql-artifact-attestation-store";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import { getPublicationRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import { createPublishRuntimeRevision } from "@/lib/runtimes/application/publish-runtime-revision";
import { createRecordRuntimeConformanceRun } from "@/lib/runtimes/application/record-runtime-conformance-run";
import { createLegacyHMACConformanceVerifier } from "@/lib/runtimes/verification/runtime-conformance-verifier";
import { seedVerifiedRuntimeAttestation } from "@/lib/runtimes/test-support/seed-verified-runtime-attestation";
import { MANDATORY_GATE_CASES } from "@/lib/runtimes/domain/runtime-conformance";
import {
  ALL_CONFORMANCE_CASES,
  canonicalizeRuntimeConformanceReport,
} from "@/lib/runtimes/domain/runtime-conformance-run";
import { mysqlRuntimeConformanceRunStore } from "@/lib/runtimes/persistence/mysql-runtime-conformance-run-store";
import { mysqlRuntimePublicationStore } from "@/lib/runtimes/persistence/mysql-runtime-publication-store";
import type {
  RuntimePublicationSession,
  RuntimePublicationStore,
} from "@/lib/runtimes/persistence/runtime-publication-store";
import { createRuntime, getRuntimeById } from "@/lib/runtimes/persistence/runtime-queries";
import {
  createDraftRuntimeRevision,
  getRuntimeRevisionById,
} from "@/lib/runtimes/persistence/runtime-revision-queries";
import {
  getIdempotencyRecordById,
  insertProcessingRecord,
} from "@/lib/v11/identity/idempotency-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { listConformanceResultsByRevision } from "@/lib/v11/runtime/runtime-conformance-result-queries";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

async function seedRuntimePublicationFixture(suffix = "") {
  const tenant = await ensureDefaultTenant();
  const owner = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "runtime-publication-owner",
    email: "runtime-publication-owner@example.com",
    displayName: "Runtime Publication Owner",
  });
  const runtime = await createRuntime({
    tenantId: tenant.id,
    runtimeKey: `runtime-publication${suffix}`,
    displayName: "Runtime Publication",
    runtimeKind: "external",
    ownerUserId: owner.id,
  });
  const revision = await createDraftRuntimeRevision({
    tenantId: tenant.id,
    runtimeId: runtime.id,
    protocolType: "agent_runtime_protocol",
    endpointRef: "managed://runtime/publication",
    runtimeArtifactRef: `oci://registry/runtime@sha256:${"a".repeat(64)}`,
    runtimeCapabilitiesJson: { capabilities: ["event_stream"] },
    identityMode: "workload_token",
    networkZone: "external",
    configHash: `sha256:${"b".repeat(64)}`,
    createdBy: owner.id,
  });
  const idempotency = await insertProcessingRecord({
    tenantId: tenant.id,
    audience: "admin",
    callerType: "user",
    callerId: owner.id,
    commandScope: `runtime.conformance:${revision.id}`,
    idempotencyKey: "publish-runtime-revision-success",
    requestHash: "b".repeat(64),
  });
  const report = {
    runId: randomUUID(),
    runtimeRevisionId: revision.id,
    runtimeArtifactDigest: `sha256:${"a".repeat(64)}`,
    runtimeConfigDigest: `sha256:${"b".repeat(64)}`,
    protocolContractRevision: revision.protocolContractRevision,
    suiteRevision: "runtime-conformance@1",
    runnerArtifactDigest: `sha256:${"c".repeat(64)}`,
    runnerIdentity: "ci/runtime-conformance",
    testEnvironmentRevision: "isolated-mysql8@1",
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
  const secret = "publication-test-secret-at-least-32-bytes";
  await createRecordRuntimeConformanceRun({
    store: mysqlRuntimeConformanceRunStore,
    verifier: createLegacyHMACConformanceVerifier({ allowNewHmacReports: true }),
  })({
    tenantId: tenant.id,
    runtimeRevisionId: revision.id,
    report,
    signature: createHmac("sha256", secret)
      .update(canonicalizeRuntimeConformanceReport(report))
      .digest("hex"),
    idempotencyKey: `run-${report.runId}`,
    requestId: `request-${report.runId}`,
    actor: { actorType: "system", actorId: "test-trusted-runner" },
  });
  const attestation = await createRecordArtifactAttestation({
    store: mysqlArtifactAttestationPersistenceStore,
  })({
    tenantId: tenant.id,
    artifactType: "runtime_revision",
    artifactRevisionId: revision.id,
    artifactDigest: `sha256:${"a".repeat(64)}`,
    signatureBundleRef: `attestation:signature:${suffix || "default"}`,
    sbomRef: `attestation:sbom:${suffix || "default"}`,
    provenanceRef: `attestation:provenance:${suffix || "default"}`,
    builderIdentity: "builder:publication-test",
    verificationState: "verified",
    policyRevisionId: null,
    failureCode: null,
    verifiedAt: new Date(),
    sourceRevision: null,
    buildPipeline: null,
    dependencyLockFileHash: null,
    buildTime: null,
    scanSummaryJson: null,
    actor: { tenantId: tenant.id, actorType: "service", actorId: "test-builder" },
    requestId: `attestation-request-${revision.id}`,
  });
  return {
    tenantId: tenant.id,
    ownerId: owner.id,
    runtime,
    revision,
    idempotency,
    conformanceRunId: report.runId,
    attestationId: attestation.id,
  };
}

const passingConformanceResults = () =>
  MANDATORY_GATE_CASES.map((caseId) => ({ caseId, passed: true }));

type PublicationStep =
  | "appendPublication"
  | "markRevisionPublished"
  | "setRuntimeCurrentRevision"
  | "appendAudit"
  | "appendOutbox"
  | "completeIdempotency";

function failAfterStep(store: RuntimePublicationStore, failureStep: PublicationStep) {
  return {
    transaction: <T>(operation: (session: RuntimePublicationSession) => Promise<T>) =>
      store.transaction((session) => {
        const failAfter = async <TResult>(step: PublicationStep, result: Promise<TResult>) => {
          const value = await result;
          if (step === failureStep) throw new Error(`injected failure after ${step}`);
          return value;
        };
        return operation({
          ...session,
          appendPublication: (params) =>
            failAfter("appendPublication", session.appendPublication(params)),
          markRevisionPublished: (revisionId, publishedAt) =>
            failAfter(
              "markRevisionPublished",
              session.markRevisionPublished(revisionId, publishedAt),
            ),
          setRuntimeCurrentRevision: (params) =>
            failAfter("setRuntimeCurrentRevision", session.setRuntimeCurrentRevision(params)),
          appendAudit: (params) => failAfter("appendAudit", session.appendAudit(params)),
          appendOutbox: (params) => failAfter("appendOutbox", session.appendOutbox(params)),
          completeIdempotency: (params) =>
            failAfter("completeIdempotency", session.completeIdempotency(params)),
        });
      }),
  } satisfies RuntimePublicationStore;
}

function publicationCommand(fixture: Awaited<ReturnType<typeof seedRuntimePublicationFixture>>) {
  return {
    tenantId: fixture.tenantId,
    revisionId: fixture.revision.id,
    runtimeExpectedVersionNo: fixture.runtime.versionNo,
    conformanceRunId: fixture.conformanceRunId,
    attestationId: fixture.attestationId,
    actor: {
      tenantId: fixture.tenantId,
      actorType: "user" as const,
      actorId: fixture.ownerId,
    },
    requestId: "req-runtime-publication",
    idempotencyKey: fixture.idempotency.idempotencyKey,
    idempotency: {
      recordId: fixture.idempotency.id,
      httpStatus: 200,
      responseRef: fixture.revision.id,
      serializeResponse: (published: {
        revision: { id: string; revisionState: string };
        auditEventId: string;
      }) =>
        JSON.stringify({
          runtime_revision_id: published.revision.id,
          revision_state: published.revision.revisionState,
          audit_event_id: published.auditEventId,
        }),
    },
  };
}

describe("RuntimeRevision publication application boundary", () => {
  it("显式 Passed Run 发布在同一结果中写入PublicationRecord、Runtime指针、Audit与Outbox", async () => {
    const fixture = await seedRuntimePublicationFixture();

    const publish = createPublishRuntimeRevision({ store: mysqlRuntimePublicationStore });
    const { revision } = await publish({
      ...publicationCommand(fixture),
      idempotency: undefined,
    });

    expect(revision.revisionState).toBe("published");
    expect((await getRuntimeById(fixture.tenantId, fixture.runtime.id))?.currentRevisionId).toBe(
      revision.id,
    );

    const publication = await getPublicationRecordBySubject({
      tenantId: fixture.tenantId,
      subjectType: "runtime_revision",
      subjectRevisionId: revision.id,
    });
    expect(publication).toMatchObject({
      subjectType: "runtime_revision",
      subjectRevisionId: revision.id,
      attestationIds: [fixture.attestationId],
      conformanceRunId: fixture.conformanceRunId,
      publishedByType: "user",
    });

    const auditEvents = await listAuditEvents({
      tenantId: fixture.tenantId,
      actionType: "runtime.publish",
      targetId: revision.id,
    });
    expect(auditEvents).toHaveLength(1);

    const outboxEvents = await db
      .select()
      .from(controlPlaneOutboxEvent)
      .where(eq(controlPlaneOutboxEvent.aggregateId, revision.id));
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]?.eventType).toBe("runtime.revision.published");
  });

  it("发布事实和Admin幂等完成在同一事务中提交", async () => {
    const fixture = await seedRuntimePublicationFixture();
    const publishRuntimeRevision = createPublishRuntimeRevision({
      store: mysqlRuntimePublicationStore,
    });

    const result = await publishRuntimeRevision({
      tenantId: fixture.tenantId,
      revisionId: fixture.revision.id,
      runtimeExpectedVersionNo: fixture.runtime.versionNo,
      conformanceRunId: fixture.conformanceRunId,
      attestationId: fixture.attestationId,
      actor: {
        tenantId: fixture.tenantId,
        actorType: "user",
        actorId: fixture.ownerId,
      },
      requestId: "req-runtime-publication",
      idempotencyKey: fixture.idempotency.idempotencyKey,
      idempotency: {
        recordId: fixture.idempotency.id,
        httpStatus: 200,
        responseRef: fixture.revision.id,
        serializeResponse: (published) =>
          JSON.stringify({
            runtime_revision_id: published.revision.id,
            revision_state: published.revision.revisionState,
            audit_event_id: published.auditEventId,
          }),
      },
    });

    const publication = await getPublicationRecordBySubject({
      tenantId: fixture.tenantId,
      subjectType: "runtime_revision",
      subjectRevisionId: fixture.revision.id,
    });
    expect(publication).toMatchObject({
      id: result.publicationRecordId,
      idempotencyKey: fixture.idempotency.idempotencyKey,
      idempotencyRecordId: fixture.idempotency.id,
      publishedByType: "user",
      publishedBy: fixture.ownerId,
    });

    const idempotency = await getIdempotencyRecordById(fixture.idempotency.id);
    expect(idempotency).toMatchObject({
      processingState: "completed",
      httpStatus: 200,
      responseRef: fixture.revision.id,
    });
    expect(JSON.parse(idempotency?.responseRedactedJson ?? "{}")).toMatchObject({
      runtime_revision_id: fixture.revision.id,
      revision_state: "published",
      audit_event_id: result.auditEventId,
    });
  });

  it("两个并发发布只有一个权威结果且不重复写Audit或Outbox", async () => {
    const fixture = await seedRuntimePublicationFixture();
    const publishRuntimeRevision = createPublishRuntimeRevision({
      store: mysqlRuntimePublicationStore,
    });
    const command = { ...publicationCommand(fixture), idempotency: undefined };

    const outcomes = await Promise.allSettled([
      publishRuntimeRevision({ ...command, requestId: "req-runtime-concurrent-1" }),
      publishRuntimeRevision({ ...command, requestId: "req-runtime-concurrent-2" }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((await getRuntimeRevisionById(fixture.revision.id))?.revisionState).toBe("published");
    expect((await getRuntimeById(fixture.tenantId, fixture.runtime.id))?.currentRevisionId).toBe(
      fixture.revision.id,
    );
    expect(
      await listAuditEvents({
        tenantId: fixture.tenantId,
        actionType: "runtime.publish",
        targetId: fixture.revision.id,
      }),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(controlPlaneOutboxEvent)
        .where(eq(controlPlaneOutboxEvent.aggregateId, fixture.revision.id)),
    ).toHaveLength(1);
  });

  it("Runtime CAS冲突不会留下conformance、发布事实或published投影", async () => {
    const fixture = await seedRuntimePublicationFixture();
    const publishRuntimeRevision = createPublishRuntimeRevision({
      store: mysqlRuntimePublicationStore,
    });

    await expect(
      publishRuntimeRevision({
        ...publicationCommand(fixture),
        runtimeExpectedVersionNo: fixture.runtime.versionNo + 100,
        idempotency: undefined,
      }),
    ).rejects.toThrow();

    expect((await getRuntimeRevisionById(fixture.revision.id))?.revisionState).toBe("draft");
    expect(
      (await getRuntimeById(fixture.tenantId, fixture.runtime.id))?.currentRevisionId,
    ).toBeNull();
    expect(await listConformanceResultsByRevision(fixture.revision.id)).toHaveLength(0);
    expect(
      await getPublicationRecordBySubject({
        tenantId: fixture.tenantId,
        subjectType: "runtime_revision",
        subjectRevisionId: fixture.revision.id,
      }),
    ).toBeNull();
  });

  it("PublicationRecord 的 EvidenceSetDigest 冻结所选 Conformance Run", async () => {
    const first = await seedRuntimePublicationFixture("-digest-a");
    const second = await seedRuntimePublicationFixture("-digest-b");
    const publishRuntimeRevision = createPublishRuntimeRevision({
      store: mysqlRuntimePublicationStore,
    });

    await publishRuntimeRevision({
      ...publicationCommand(first),
      idempotency: undefined,
    });
    await publishRuntimeRevision({
      ...publicationCommand(second),
      idempotency: undefined,
    });

    const firstPublication = await getPublicationRecordBySubject({
      tenantId: first.tenantId,
      subjectType: "runtime_revision",
      subjectRevisionId: first.revision.id,
    });
    const secondPublication = await getPublicationRecordBySubject({
      tenantId: second.tenantId,
      subjectType: "runtime_revision",
      subjectRevisionId: second.revision.id,
    });
    expect(secondPublication?.evidenceSetDigest).not.toBe(firstPublication?.evidenceSetDigest);
  });

  it.each<PublicationStep>([
    "appendPublication",
    "markRevisionPublished",
    "setRuntimeCurrentRevision",
    "appendAudit",
    "appendOutbox",
    "completeIdempotency",
  ])("%s失败时回滚全部Runtime发布写入", async (failureStep) => {
    const fixture = await seedRuntimePublicationFixture();
    const publishRuntimeRevision = createPublishRuntimeRevision({
      store: failAfterStep(mysqlRuntimePublicationStore, failureStep),
    });

    await expect(publishRuntimeRevision(publicationCommand(fixture))).rejects.toThrow(
      `injected failure after ${failureStep}`,
    );

    expect((await getRuntimeRevisionById(fixture.revision.id))?.revisionState).toBe("draft");
    const runtime = await getRuntimeById(fixture.tenantId, fixture.runtime.id);
    expect(runtime?.currentRevisionId).toBeNull();
    expect(runtime?.versionNo).toBe(fixture.runtime.versionNo);
    expect(await listConformanceResultsByRevision(fixture.revision.id)).toHaveLength(0);
    expect(
      await getPublicationRecordBySubject({
        tenantId: fixture.tenantId,
        subjectType: "runtime_revision",
        subjectRevisionId: fixture.revision.id,
      }),
    ).toBeNull();
    expect(
      await listAuditEvents({
        tenantId: fixture.tenantId,
        actionType: "runtime.publish",
        targetId: fixture.revision.id,
      }),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(controlPlaneOutboxEvent)
        .where(eq(controlPlaneOutboxEvent.aggregateId, fixture.revision.id)),
    ).toHaveLength(0);
    expect((await getIdempotencyRecordById(fixture.idempotency.id))?.processingState).toBe(
      "processing",
    );
  });
});
