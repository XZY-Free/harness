import { createWithdrawAgentRevision } from "@/lib/agents/application/withdraw-agent-revision";
import {
  AgentRevisionWithdrawalPublicationNotFoundError,
  AgentRevisionWithdrawalValidationError,
} from "@/lib/agents/domain/agent-revision-withdrawal-policy";
import { createAgent, getAgentById } from "@/lib/agents/persistence/agent-queries";
import {
  createDraftRevision,
  getRevisionById,
  getRevisionsByAgent,
} from "@/lib/agents/persistence/agent-revision-queries";
import type {
  AgentWithdrawalSession,
  AgentWithdrawalStore,
} from "@/lib/agents/persistence/agent-withdrawal-store";
import { mysqlAgentWithdrawalStore } from "@/lib/agents/persistence/mysql-agent-withdrawal-store";
import { publishRevision } from "@/lib/agents/test-support/publish-agent-revision-without-attestation";
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
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import {
  getPublicationRecordBySubject,
  getWithdrawalRecordBySubject,
} from "@/lib/publications/persistence/publication-record-queries";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

async function seedPublishedRevisions(count = 2) {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "agent-withdrawal-owner",
    email: "agent-withdrawal-owner@example.com",
    displayName: "Agent Withdrawal Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "agent-withdrawal-owner",
    displayName: "Agent Withdrawal Owner",
    userIdentityId: identity.id,
  });
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: "withdrawal-agent",
    displayName: "Withdrawal Agent",
    ownerUserId: identity.id,
  });
  const revisions = [];
  let expectedVersionNo = agent.versionNo;
  for (let index = 1; index <= count; index += 1) {
    const draft = await createDraftRevision({
      tenantId: tenant.id,
      agentId: agent.id,
      sourceType: "agent_yaml",
      sourceRevision: `git:withdrawal-v${index}`,
      instructionHash: `sha256:withdrawal-instruction-${index}`,
      agentArtifactRef: `builtin://withdrawal-agent/v${index}`,
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: identity.id,
    });
    revisions.push(await publishRevision(tenant.id, draft.id, expectedVersionNo));
    expectedVersionNo += 1;
  }
  return {
    tenantId: tenant.id,
    ownerId: identity.id,
    agentId: agent.id,
    expectedVersionNo,
    revisions,
  };
}

function withdrawalCommand(fixture: Awaited<ReturnType<typeof seedPublishedRevisions>>) {
  const revision = fixture.revisions.at(-1);
  if (!revision) throw new Error("测试发布数据不完整");
  return {
    tenantId: fixture.tenantId,
    revisionId: revision.id,
    agentExpectedVersionNo: fixture.expectedVersionNo,
    actor: {
      tenantId: fixture.tenantId,
      actorType: "user" as const,
      actorId: fixture.ownerId,
    },
    reasonCode: "security_policy",
    reason: "该版本不再满足安全策略",
    requestId: "req-agent-withdrawal",
  };
}

type WithdrawalStep =
  | "appendWithdrawal"
  | "markRevisionWithdrawn"
  | "setAgentCurrentRevision"
  | "appendAudit"
  | "appendOutbox"
  | "completeIdempotency";

function failAfterStep(store: AgentWithdrawalStore, failureStep: WithdrawalStep) {
  return {
    transaction: <T>(operation: (session: AgentWithdrawalSession) => Promise<T>) =>
      store.transaction((session) => {
        const failAfter = async <TResult>(step: WithdrawalStep, result: Promise<TResult>) => {
          const value = await result;
          if (step === failureStep) throw new Error(`injected failure after ${step}`);
          return value;
        };
        return operation({
          ...session,
          appendWithdrawal: (params) =>
            failAfter("appendWithdrawal", session.appendWithdrawal(params)),
          markRevisionWithdrawn: (revisionId) =>
            failAfter("markRevisionWithdrawn", session.markRevisionWithdrawn(revisionId)),
          setAgentCurrentRevision: (params) =>
            failAfter("setAgentCurrentRevision", session.setAgentCurrentRevision(params)),
          appendAudit: (params) => failAfter("appendAudit", session.appendAudit(params)),
          appendOutbox: (params) => failAfter("appendOutbox", session.appendOutbox(params)),
          completeIdempotency: (params) =>
            failAfter("completeIdempotency", session.completeIdempotency(params)),
        });
      }),
  } satisfies AgentWithdrawalStore;
}

describe("WithdrawAgentRevision Application Service", () => {
  it("撤回当前 Revision 时原子记录 WithdrawalRecord 并重算 Agent 当前指针", async () => {
    const fixture = await seedPublishedRevisions();
    const previousRevision = fixture.revisions[0];
    const currentRevision = fixture.revisions[1];
    if (!previousRevision || !currentRevision) throw new Error("测试发布数据不完整");
    const withdrawAgentRevision = createWithdrawAgentRevision({
      store: mysqlAgentWithdrawalStore,
    });

    const result = await withdrawAgentRevision({
      tenantId: fixture.tenantId,
      revisionId: currentRevision.id,
      agentExpectedVersionNo: fixture.expectedVersionNo,
      actor: {
        tenantId: fixture.tenantId,
        actorType: "user",
        actorId: fixture.ownerId,
      },
      reasonCode: "security_policy",
      reason: "该版本不再满足安全策略",
      requestId: "req-agent-withdrawal-success",
    });

    expect(result.revision.revisionState).toBe("withdrawn");
    expect(result.currentRevisionId).toBe(previousRevision.id);
    expect((await getRevisionById(currentRevision.id))?.revisionState).toBe("withdrawn");
    expect(await getRevisionsByAgent(fixture.agentId)).toHaveLength(2);

    const publication = await getPublicationRecordBySubject({
      tenantId: fixture.tenantId,
      subjectType: "agent_revision",
      subjectRevisionId: currentRevision.id,
    });
    const withdrawal = await getWithdrawalRecordBySubject({
      tenantId: fixture.tenantId,
      subjectType: "agent_revision",
      subjectRevisionId: currentRevision.id,
    });
    expect(publication).not.toBeNull();
    expect(withdrawal).toMatchObject({
      id: result.withdrawalRecordId,
      publicationRecordId: publication?.id,
      reasonCode: "security_policy",
      reason: "该版本不再满足安全策略",
      withdrawnByType: "user",
      withdrawnBy: fixture.ownerId,
    });

    const agent = await getAgentById(fixture.tenantId, fixture.agentId);
    expect(agent?.currentRevisionId).toBe(previousRevision.id);
    expect(agent?.versionNo).toBe(fixture.expectedVersionNo + 1);
    expect(
      await listAuditEvents({
        tenantId: fixture.tenantId,
        actionType: "agent.retract",
        targetId: currentRevision.id,
      }),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(controlPlaneOutboxEvent)
        .where(eq(controlPlaneOutboxEvent.aggregateId, currentRevision.id)),
    ).toHaveLength(2);
  });

  it("只有一个已发布 Revision 时撤回会把 Agent 当前指针置空", async () => {
    const fixture = await seedPublishedRevisions(1);
    const revision = fixture.revisions[0];
    if (!revision) throw new Error("测试发布数据不完整");

    const result = await createWithdrawAgentRevision({ store: mysqlAgentWithdrawalStore })(
      withdrawalCommand(fixture),
    );

    expect(result.currentRevisionId).toBeNull();
    expect((await getAgentById(fixture.tenantId, fixture.agentId))?.currentRevisionId).toBeNull();
    expect((await getRevisionById(revision.id))?.revisionState).toBe("withdrawn");
  });

  it("撤回非当前 Revision 时当前指针保持最新的有效发布", async () => {
    const fixture = await seedPublishedRevisions();
    const olderRevision = fixture.revisions[0];
    const currentRevision = fixture.revisions[1];
    if (!olderRevision || !currentRevision) throw new Error("测试发布数据不完整");

    const result = await createWithdrawAgentRevision({ store: mysqlAgentWithdrawalStore })({
      ...withdrawalCommand(fixture),
      revisionId: olderRevision.id,
    });

    expect(result.currentRevisionId).toBe(currentRevision.id);
    expect((await getAgentById(fixture.tenantId, fixture.agentId))?.currentRevisionId).toBe(
      currentRevision.id,
    );
  });

  it("两个并发撤回只有一个提交且只有一条 WithdrawalRecord", async () => {
    const fixture = await seedPublishedRevisions();
    const command = withdrawalCommand(fixture);
    const withdrawAgentRevision = createWithdrawAgentRevision({ store: mysqlAgentWithdrawalStore });

    const outcomes = await Promise.allSettled([
      withdrawAgentRevision({ ...command, requestId: "req-withdraw-concurrent-1" }),
      withdrawAgentRevision({ ...command, requestId: "req-withdraw-concurrent-2" }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(
      await getWithdrawalRecordBySubject({
        tenantId: fixture.tenantId,
        subjectType: "agent_revision",
        subjectRevisionId: command.revisionId,
      }),
    ).not.toBeNull();
    expect(
      await listAuditEvents({
        tenantId: fixture.tenantId,
        actionType: "agent.retract",
        targetId: command.revisionId,
      }),
    ).toHaveLength(1);
  });

  it("只有 published 投影但缺少 PublicationRecord 时拒绝撤回", async () => {
    const fixture = await seedPublishedRevisions(1);
    const command = withdrawalCommand(fixture);
    await db
      .delete(publicationRecord)
      .where(eq(publicationRecord.subjectRevisionId, command.revisionId));

    await expect(
      createWithdrawAgentRevision({ store: mysqlAgentWithdrawalStore })(command),
    ).rejects.toBeInstanceOf(AgentRevisionWithdrawalPublicationNotFoundError);
    expect((await getRevisionById(command.revisionId))?.revisionState).toBe("published");
  });

  it("原因码或原因为空时拒绝撤回且不写 WithdrawalRecord", async () => {
    const fixture = await seedPublishedRevisions(1);
    const command = withdrawalCommand(fixture);

    await expect(
      createWithdrawAgentRevision({ store: mysqlAgentWithdrawalStore })({
        ...command,
        reason: " ",
      }),
    ).rejects.toBeInstanceOf(AgentRevisionWithdrawalValidationError);
    expect(
      await getWithdrawalRecordBySubject({
        tenantId: fixture.tenantId,
        subjectType: "agent_revision",
        subjectRevisionId: command.revisionId,
      }),
    ).toBeNull();
  });

  it.each<WithdrawalStep>([
    "appendWithdrawal",
    "markRevisionWithdrawn",
    "setAgentCurrentRevision",
    "appendAudit",
    "appendOutbox",
    "completeIdempotency",
  ])("%s 后失败会回滚撤回事实、投影、指针、Audit、Outbox 和 Idempotency", async (step) => {
    const fixture = await seedPublishedRevisions();
    const command = withdrawalCommand(fixture);
    const idempotency = await insertProcessingRecord({
      tenantId: fixture.tenantId,
      audience: "admin",
      callerType: "user",
      callerId: fixture.ownerId,
      commandScope: `agent.withdraw:${command.revisionId}`,
      idempotencyKey: `withdraw-failure-${step}`,
      requestHash: "f".repeat(64),
    });
    const withdrawAgentRevision = createWithdrawAgentRevision({
      store: failAfterStep(mysqlAgentWithdrawalStore, step),
    });

    await expect(
      withdrawAgentRevision({
        ...command,
        idempotency: {
          recordId: idempotency.id,
          httpStatus: 200,
          responseRef: command.revisionId,
          serializeResponse: (result) => JSON.stringify(result),
        },
      }),
    ).rejects.toThrow(`injected failure after ${step}`);

    expect((await getRevisionById(command.revisionId))?.revisionState).toBe("published");
    expect((await getAgentById(fixture.tenantId, fixture.agentId))?.currentRevisionId).toBe(
      command.revisionId,
    );
    expect(
      await getWithdrawalRecordBySubject({
        tenantId: fixture.tenantId,
        subjectType: "agent_revision",
        subjectRevisionId: command.revisionId,
      }),
    ).toBeNull();
    expect(
      await listAuditEvents({
        tenantId: fixture.tenantId,
        actionType: "agent.retract",
        targetId: command.revisionId,
      }),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(controlPlaneOutboxEvent)
        .where(eq(controlPlaneOutboxEvent.aggregateId, command.revisionId)),
    ).toHaveLength(1);
    expect((await getIdempotencyRecordById(idempotency.id))?.processingState).toBe("processing");
  });
});
