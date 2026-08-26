import { createPublishAgentRevision } from "@/lib/agents/application/publish-agent-revision";
import {
  AgentPublicationContractSnapshotMissingError,
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
import { createDraftRevisionWithContractSnapshot } from "@/lib/agents/test-support/create-draft-revision-with-contract";
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
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { tenant } from "@/lib/persistence/schema/identity";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import { getPublicationRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import { ensureAgentContractSnapshotBoundForRevision } from "@/lib/test-support/ensure-agent-contract-snapshot";
import { eq } from "drizzle-orm";
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
  const revision = await createDraftRevisionWithContractSnapshot({
    tenantId: tenant.id,
    agentId: agent.id,
    modelPolicyJson: { model: "gpt-4" },
    permissionRequirementsJson: {},
    delegationPolicyJson: {},
    agentInterfaceRequirementsJson: { required: [], optional: [] },
    createdBy: identity.id,
  });
  // Agent 是源码不可见黑盒：发布权威 = AgentContractSnapshot，无 Artifact/Attestation。
  const contractSnapshot = await ensureAgentContractSnapshotBoundForRevision(
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
    contractSnapshot,
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
      attestationIds: [],
      conformanceRunId: null,
      approvals: [],
      publishedByType: "user",
      publishedBy: fixture.ownerId,
      idempotencyKey: fixture.idempotency.idempotencyKey,
      idempotencyRecordId: fixture.idempotency.id,
      // Publication 精确绑定 AgentContractSnapshot 证据
      agentContractSnapshotId: fixture.contractSnapshot.id,
      agentContractDigest: fixture.contractSnapshot.contractDigest,
      agentCapabilityDigest: fixture.contractSnapshot.capabilityDigest,
      agentContextDigest: fixture.contractSnapshot.contextDigest,
    });
    expect(publication?.publicationSequence).toBeGreaterThan(0);
    expect(publication?.evidenceSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const agent = await getAgentById(fixture.tenantId, fixture.agent.id);
    expect(agent?.currentRevisionId).toBe(fixture.revision.id);
    expect(agent?.versionNo).toBe(fixture.agent.versionNo + 1);
    // 生命周期不变量：draft Agent 首次发布在同一事务内原子启用
    expect(agent?.lifecycleState).toBe("enabled");

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

  it("首次发布 draft Agent 的合法 AgentRevision 时在同一事务内原子启用 Agent", async () => {
    const fixture = await seedPublicationFixture();
    const publishAgentRevision = createPublishAgentRevision({ store: mysqlAgentPublicationStore });

    // 前置：合同登记创建的 Agent 一定是 draft，且从未发布
    expect((await getAgentById(fixture.tenantId, fixture.agent.id))?.lifecycleState).toBe("draft");

    const result = await publishAgentRevision({
      ...publicationCommand(fixture),
      idempotency: undefined,
    });

    expect(result.revision.revisionState).toBe("published");
    const agent = await getAgentById(fixture.tenantId, fixture.agent.id);
    // 精确冻结：enabled + current revision + version 只增加一次，全部由同一发布事务完成
    expect(agent?.lifecycleState).toBe("enabled");
    expect(agent?.currentRevisionId).toBe(fixture.revision.id);
    expect(agent?.versionNo).toBe(fixture.agent.versionNo + 1);
  });

  it("已 enabled 的 Agent 发布新 revision 保持 enabled，version 每次只增加一次", async () => {
    const fixture = await seedPublicationFixture();
    const publishAgentRevision = createPublishAgentRevision({ store: mysqlAgentPublicationStore });

    // 第一次发布：draft → enabled
    await publishAgentRevision({ ...publicationCommand(fixture), idempotency: undefined });
    const afterFirstPublish = await getAgentById(fixture.tenantId, fixture.agent.id);
    expect(afterFirstPublish?.lifecycleState).toBe("enabled");

    // 第二次发布：新 revision，Agent 原本 enabled
    const secondRevision = await createDraftRevisionWithContractSnapshot({
      tenantId: fixture.tenantId,
      agentId: fixture.agent.id,
      modelPolicyJson: { model: "gpt-4o" },
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: fixture.ownerId,
    });
    await ensureAgentContractSnapshotBoundForRevision(secondRevision.id, fixture.tenantId);

    const result = await publishAgentRevision({
      ...publicationCommand(fixture),
      revisionId: secondRevision.id,
      agentExpectedVersionNo: afterFirstPublish!.versionNo,
      idempotency: undefined,
    });

    expect(result.revision.revisionState).toBe("published");
    const agent = await getAgentById(fixture.tenantId, fixture.agent.id);
    expect(agent?.lifecycleState).toBe("enabled");
    expect(agent?.currentRevisionId).toBe(secondRevision.id);
    expect(agent?.versionNo).toBe(afterFirstPublish!.versionNo + 1);
  });

  it("disabled 的 Agent 允许发布新 revision 但保持 disabled，绝不因发布被重新启用", async () => {
    const fixture = await seedPublicationFixture();
    await db
      .update(agentTable)
      .set({ lifecycleState: "disabled" })
      .where(eq(agentTable.id, fixture.agent.id));
    const publishAgentRevision = createPublishAgentRevision({ store: mysqlAgentPublicationStore });

    const result = await publishAgentRevision({
      ...publicationCommand(fixture),
      idempotency: undefined,
    });

    expect(result.revision.revisionState).toBe("published");
    const agent = await getAgentById(fixture.tenantId, fixture.agent.id);
    expect(agent?.currentRevisionId).toBe(fixture.revision.id);
    expect(agent?.versionNo).toBe(fixture.agent.versionNo + 1);
    // 发布不允许偷偷重新启用
    expect(agent?.lifecycleState).toBe("disabled");
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
    const agent = await getAgentById(fixture.tenantId, fixture.agent.id);
    expect(agent?.currentRevisionId).toBe(fixture.revision.id);
    // 幂等/并发：竞争失败方不重放成功方事务，version 只增加一次，lifecycle 只迁移一次
    expect(agent?.versionNo).toBe(fixture.agent.versionNo + 1);
    expect(agent?.lifecycleState).toBe("enabled");
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
    const untouchedAgent = await getAgentById(fixture.tenantId, fixture.agent.id);
    expect(untouchedAgent?.currentRevisionId).toBeNull();
    expect(untouchedAgent?.lifecycleState).toBe("draft");
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
    // 回滚不变量：发布失败绝不留下 enabled 的 draft 流程 Agent
    expect(agent?.lifecycleState).toBe("draft");
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

  it("无 source Attestation 时，仅凭 AgentContractSnapshot 证据正式发布（Gate）", async () => {
    const fixture = await seedPublicationFixture();
    const publishAgentRevision = createPublishAgentRevision({ store: mysqlAgentPublicationStore });

    const result = await publishAgentRevision({
      ...publicationCommand(fixture),
      idempotency: undefined,
    });

    expect(result.revision.revisionState).toBe("published");

    const publication = await getPublicationRecordBySubject({
      tenantId: fixture.tenantId,
      subjectType: "agent_revision",
      subjectRevisionId: fixture.revision.id,
    });
    // 无 Attestation 但 Contract 证据已精确冻结
    expect(publication?.attestationIds).toEqual([]);
    expect(publication?.agentContractSnapshotId).toBe(fixture.contractSnapshot.id);
    expect(publication?.agentContractDigest).toBe(fixture.contractSnapshot.contractDigest);
    expect(publication?.agentCapabilityDigest).toBe(fixture.contractSnapshot.capabilityDigest);
    expect(publication?.agentContextDigest).toBe(fixture.contractSnapshot.contextDigest);
  });

  it("未绑定 AgentContractSnapshot 的 Revision 拒绝发布（AgentPublicationContractSnapshotMissingError）", async () => {
    const fixture = await seedPublicationFixture();
    // 指向不存在的 Snapshot，模拟未绑定/脏引用 Revision
    await db
      .update(agentRevisionTable)
      .set({ agentContractSnapshotId: "not-a-real-snapshot" })
      .where(eq(agentRevisionTable.id, fixture.revision.id));
    const publishAgentRevision = createPublishAgentRevision({ store: mysqlAgentPublicationStore });

    await expect(
      publishAgentRevision({
        ...publicationCommand(fixture),
        idempotency: undefined,
      }),
    ).rejects.toBeInstanceOf(AgentPublicationContractSnapshotMissingError);

    expect((await getRevisionById(fixture.revision.id))?.revisionState).toBe("draft");
  });
});
