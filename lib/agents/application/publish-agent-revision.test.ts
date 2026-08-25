import { createPublishAgentRevision } from "@/lib/agents/application/publish-agent-revision";
import {
  AgentPublicationDescriptorSnapshotMissingError,
  AgentRevisionPublicationNotFoundError,
} from "@/lib/agents/domain/agent-revision-publication-policy";
import type {
  AgentPublicationSession,
  AgentPublicationStore,
} from "@/lib/agents/persistence/agent-publication-store";
import { createAgent, getAgentById } from "@/lib/agents/persistence/agent-queries";
import {
  createDraftRevision,
  getRevisionById,
  getRevisionsByAgent,
} from "@/lib/agents/persistence/agent-revision-queries";
import { mysqlAgentPublicationStore } from "@/lib/agents/persistence/mysql-agent-publication-store";
import { insertAttestation } from "@/lib/artifacts/persistence/artifact-attestation-writer";
import { artifact } from "@/lib/artifacts/persistence/artifact-record";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import {
  getIdempotencyRecordById,
  insertProcessingRecord,
} from "@/lib/identity/idempotency-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { agentRevisionTable } from "@/lib/persistence/schema/agents";
import { tenant } from "@/lib/persistence/schema/identity";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import { getPublicationRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import { ensureAgentDescriptorSnapshotBoundForRevision } from "@/lib/test-support/ensure-agent-descriptor-snapshot";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

async function seedPublicationFixture() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "agent-publication-owner",
    email: "agent-publication-owner@example.com",
    displayName: "Agent Publication Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "agent-publication-owner",
    displayName: "Agent Publication Owner",
    userIdentityId: identity.id,
  });
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: "publication-agent",
    displayName: "Publication Agent",
    ownerUserId: identity.id,
  });
  const revision = await createDraftRevision({
    tenantId: tenant.id,
    agentId: agent.id,
    sourceType: "agent_yaml",
    sourceRevision: "git:publication-v1",
    instructionHash: "sha256:publication-instruction",
    agentArtifactRef: "oci://registry/agent@sha256:publication",
    modelPolicyJson: { model: "gpt-4" },
    permissionRequirementsJson: {},
    delegationPolicyJson: {},
    agentInterfaceRequirementsJson: { required: [], optional: [] },
    createdBy: identity.id,
  });
  const artifactDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const attestation = await insertAttestation({
    tenantId: tenant.id,
    artifactType: "agent_revision",
    artifactRevisionId: revision.id,
    artifactDigest,
    dsseEnvelopeRef: "attestation:signature:publication",
    sbomRef: "attestation:sbom:publication",
    provenanceRef: "attestation:provenance:publication",
    builderIdentity: "builder:publication-test",
    verificationState: "verified",
    verifiedAt: new Date(),
  });
  const [authority] = await db
    .select()
    .from(artifact)
    .where(and(eq(artifact.tenantId, tenant.id), eq(artifact.digest, artifactDigest)))
    .limit(1);
  if (!authority) throw new Error("Agent publication fixture Artifact 未创建");
  await db
    .update(agentRevisionTable)
    .set({ artifactId: authority.id, artifactDigest: authority.digest })
    .where(eq(agentRevisionTable.id, revision.id));
  // Batch 2：发布命令强制 Revision 绑定 AgentDescriptorSnapshot（权威外部合同）。
  const descriptorSnapshot = await ensureAgentDescriptorSnapshotBoundForRevision(
    revision.id,
    tenant.id,
  );
  const idempotency = await insertProcessingRecord({
    tenantId: tenant.id,
    audience: "admin",
    callerType: "user",
    callerId: identity.id,
    commandScope: `agent.publish:${revision.id}`,
    idempotencyKey: "publish-agent-revision-success",
    requestHash: "a".repeat(64),
  });
  return {
    tenantId: tenant.id,
    ownerId: identity.id,
    agent,
    revision,
    attestation,
    descriptorSnapshot,
    idempotency,
  };
}

type PublicationStep =
  | "appendPublication"
  | "markRevisionPublished"
  | "setAgentCurrentRevision"
  | "appendAudit"
  | "appendOutbox"
  | "completeIdempotency";

function failAfterStep(store: AgentPublicationStore, failureStep: PublicationStep) {
  return {
    transaction: <T>(operation: (session: AgentPublicationSession) => Promise<T>) =>
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
          setAgentCurrentRevision: (params) =>
            failAfter("setAgentCurrentRevision", session.setAgentCurrentRevision(params)),
          appendAudit: (params) => failAfter("appendAudit", session.appendAudit(params)),
          appendOutbox: (params) => failAfter("appendOutbox", session.appendOutbox(params)),
          completeIdempotency: (params) =>
            failAfter("completeIdempotency", session.completeIdempotency(params)),
        });
      }),
  } satisfies AgentPublicationStore;
}

function publicationCommand(fixture: Awaited<ReturnType<typeof seedPublicationFixture>>) {
  return {
    tenantId: fixture.tenantId,
    revisionId: fixture.revision.id,
    agentExpectedVersionNo: fixture.agent.versionNo,
    attestationId: fixture.attestation.id,
    actor: {
      tenantId: fixture.tenantId,
      actorType: "user" as const,
      actorId: fixture.ownerId,
    },
    requestId: "req-agent-publication",
    idempotencyKey: fixture.idempotency.idempotencyKey,
    idempotency: {
      recordId: fixture.idempotency.id,
      httpStatus: 200,
      responseRef: fixture.revision.id,
      serializeResponse: (published: {
        revision: { id: string; revisionState: string; publishedAt: Date | null };
        auditEventId: string;
      }) =>
        JSON.stringify({
          id: published.revision.id,
          revision_state: published.revision.revisionState,
          published_at: published.revision.publishedAt?.toISOString() ?? null,
          audit_event_id: published.auditEventId,
        }),
    },
  };
}

describe("PublishAgentRevision Application Service", () => {
  it("在一个事务中发布 Revision、更新 Agent 指针并写入 Audit、Outbox 和 Idempotency", async () => {
    const fixture = await seedPublicationFixture();
    const publishAgentRevision = createPublishAgentRevision({
      store: mysqlAgentPublicationStore,
    });

    const result = await publishAgentRevision({
      tenantId: fixture.tenantId,
      revisionId: fixture.revision.id,
      agentExpectedVersionNo: fixture.agent.versionNo,
      attestationId: fixture.attestation.id,
      actor: { tenantId: fixture.tenantId, actorType: "user", actorId: fixture.ownerId },
      requestId: "req-agent-publication-success",
      idempotencyKey: fixture.idempotency.idempotencyKey,
      idempotency: {
        recordId: fixture.idempotency.id,
        httpStatus: 200,
        responseRef: fixture.revision.id,
        serializeResponse: (published) =>
          JSON.stringify({
            id: published.revision.id,
            revision_state: published.revision.revisionState,
            published_at: published.revision.publishedAt?.toISOString() ?? null,
            audit_event_id: published.auditEventId,
          }),
      },
    });

    expect(result.revision.revisionState).toBe("published");
    const publication = await getPublicationRecordBySubject({
      tenantId: fixture.tenantId,
      subjectType: "agent_revision",
      subjectRevisionId: fixture.revision.id,
    });
    expect(publication).toMatchObject({
      id: result.publicationRecordId,
      subjectType: "agent_revision",
      subjectRevisionId: fixture.revision.id,
      attestationIds: [fixture.attestation.id],
      conformanceRunId: null,
      approvals: [],
      publishedByType: "user",
      publishedBy: fixture.ownerId,
      idempotencyKey: fixture.idempotency.idempotencyKey,
      idempotencyRecordId: fixture.idempotency.id,
      // Batch 2：Publication 精确绑定 DescriptorSnapshot 证据
      agentDescriptorSnapshotId: fixture.descriptorSnapshot.id,
      agentProviderDescriptorDigest: fixture.descriptorSnapshot.providerDescriptorDigest,
      agentCapabilityManifestDigest: fixture.descriptorSnapshot.capabilityManifestDigest,
      agentInvocationContextContractDigest:
        fixture.descriptorSnapshot.invocationContextContractDigest,
    });
    expect(publication?.publicationSequence).toBeGreaterThan(0);
    expect(publication?.evidenceSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const agent = await getAgentById(fixture.tenantId, fixture.agent.id);
    expect(agent?.currentRevisionId).toBe(fixture.revision.id);
    expect(agent?.versionNo).toBe(fixture.agent.versionNo + 1);

    const revisions = await getRevisionsByAgent(fixture.agent.id);
    expect(revisions).toHaveLength(1);
    expect((await getRevisionById(fixture.revision.id))?.publishedAt).not.toBeNull();

    const auditEvents = await listAuditEvents({
      tenantId: fixture.tenantId,
      actionType: "agent.publish",
      targetId: fixture.revision.id,
    });
    expect(auditEvents.map((event) => event.id)).toEqual([result.auditEventId]);

    const outboxEvents = await db
      .select()
      .from(controlPlaneOutboxEvent)
      .where(eq(controlPlaneOutboxEvent.aggregateId, fixture.revision.id));
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]?.eventType).toBe("agent.revision.published");

    const idempotency = await getIdempotencyRecordById(fixture.idempotency.id);
    expect(idempotency?.processingState).toBe("completed");
    expect(idempotency?.responseRef).toBe(fixture.revision.id);
    expect(JSON.parse(idempotency?.responseRedactedJson ?? "{}")).toMatchObject({
      id: fixture.revision.id,
      revision_state: "published",
      audit_event_id: result.auditEventId,
    });
  });

  it("两个并发发布只有一个提交，且不会产生重复 Audit 或 Outbox", async () => {
    const fixture = await seedPublicationFixture();
    const publishAgentRevision = createPublishAgentRevision({ store: mysqlAgentPublicationStore });
    const command = { ...publicationCommand(fixture), idempotency: undefined };

    const outcomes = await Promise.allSettled([
      publishAgentRevision({ ...command, requestId: "req-concurrent-1" }),
      publishAgentRevision({ ...command, requestId: "req-concurrent-2" }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((await getRevisionById(fixture.revision.id))?.revisionState).toBe("published");
    expect((await getAgentById(fixture.tenantId, fixture.agent.id))?.currentRevisionId).toBe(
      fixture.revision.id,
    );
    expect(
      await listAuditEvents({
        tenantId: fixture.tenantId,
        actionType: "agent.publish",
        targetId: fixture.revision.id,
      }),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(controlPlaneOutboxEvent)
        .where(eq(controlPlaneOutboxEvent.aggregateId, fixture.revision.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(publicationRecord)
        .where(eq(publicationRecord.subjectRevisionId, fixture.revision.id)),
    ).toHaveLength(1);
  });

  it("应用服务按租户锁定 Revision，跨租户调用不暴露或修改发布事实", async () => {
    const fixture = await seedPublicationFixture();
    const otherTenantId = "tenant-agent-publication-other";
    await db.insert(tenant).values({
      id: otherTenantId,
      key: "agent-publication-other",
      name: "Agent Publication Other",
    });
    const publishAgentRevision = createPublishAgentRevision({ store: mysqlAgentPublicationStore });

    await expect(
      publishAgentRevision({
        ...publicationCommand(fixture),
        tenantId: otherTenantId,
        actor: { tenantId: otherTenantId, actorType: "user", actorId: fixture.ownerId },
        idempotency: undefined,
      }),
    ).rejects.toBeInstanceOf(AgentRevisionPublicationNotFoundError);

    expect((await getRevisionById(fixture.revision.id))?.revisionState).toBe("draft");
    expect((await getAgentById(fixture.tenantId, fixture.agent.id))?.currentRevisionId).toBeNull();
  });

  it.each<PublicationStep>([
    "appendPublication",
    "markRevisionPublished",
    "setAgentCurrentRevision",
    "appendAudit",
    "appendOutbox",
    "completeIdempotency",
  ])("%s 后失败会回滚整个发布事务", async (failureStep) => {
    const fixture = await seedPublicationFixture();
    const publishAgentRevision = createPublishAgentRevision({
      store: failAfterStep(mysqlAgentPublicationStore, failureStep),
    });

    await expect(publishAgentRevision(publicationCommand(fixture))).rejects.toThrow(
      `injected failure after ${failureStep}`,
    );

    const revision = await getRevisionById(fixture.revision.id);
    expect(revision?.revisionState).toBe("draft");
    expect(revision?.publishedAt).toBeNull();
    expect(
      await getPublicationRecordBySubject({
        tenantId: fixture.tenantId,
        subjectType: "agent_revision",
        subjectRevisionId: fixture.revision.id,
      }),
    ).toBeNull();
    const agent = await getAgentById(fixture.tenantId, fixture.agent.id);
    expect(agent?.currentRevisionId).toBeNull();
    expect(agent?.versionNo).toBe(fixture.agent.versionNo);
    expect(
      await listAuditEvents({
        tenantId: fixture.tenantId,
        actionType: "agent.publish",
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

  it("无 source Attestation 时，仅凭 DescriptorSnapshot 证据正式发布（Batch 2 Gate）", async () => {
    const fixture = await seedPublicationFixture();
    const publishAgentRevision = createPublishAgentRevision({ store: mysqlAgentPublicationStore });

    const result = await publishAgentRevision({
      ...publicationCommand(fixture),
      attestationId: null,
      idempotency: undefined,
    });

    expect(result.attestation).toBeNull();
    expect(result.revision.revisionState).toBe("published");

    const publication = await getPublicationRecordBySubject({
      tenantId: fixture.tenantId,
      subjectType: "agent_revision",
      subjectRevisionId: fixture.revision.id,
    });
    // 无 Attestation 但 Descriptor 证据已精确冻结
    expect(publication?.attestationIds).toEqual([]);
    expect(publication?.agentDescriptorSnapshotId).toBe(fixture.descriptorSnapshot.id);
    expect(publication?.agentProviderDescriptorDigest).toBe(
      fixture.descriptorSnapshot.providerDescriptorDigest,
    );
    expect(publication?.agentCapabilityManifestDigest).toBe(
      fixture.descriptorSnapshot.capabilityManifestDigest,
    );
    expect(publication?.agentInvocationContextContractDigest).toBe(
      fixture.descriptorSnapshot.invocationContextContractDigest,
    );
  });

  it("未绑定 AgentDescriptorSnapshot 的 Revision 拒绝发布（AgentPublicationDescriptorSnapshotMissingError）", async () => {
    const fixture = await seedPublicationFixture();
    // 解绑 Snapshot，模拟旧/未绑定 Revision
    await db
      .update(agentRevisionTable)
      .set({ agentDescriptorSnapshotId: null })
      .where(eq(agentRevisionTable.id, fixture.revision.id));
    const publishAgentRevision = createPublishAgentRevision({ store: mysqlAgentPublicationStore });

    await expect(
      publishAgentRevision({
        ...publicationCommand(fixture),
        idempotency: undefined,
      }),
    ).rejects.toBeInstanceOf(AgentPublicationDescriptorSnapshotMissingError);

    expect((await getRevisionById(fixture.revision.id))?.revisionState).toBe("draft");
  });
});
