/**
 * PublishAgentRevision — AgentContractSnapshot 发布权威先行冻结（预期 RED）。
 *
 * 冻结不变量（AgentContractSnapshot 权威切片）：
 * - 发布证据从绑定的结构化 AgentContractSnapshot 冻结：snapshot id + contractDigest +
 *   capabilityDigest + contextDigest；不再从 AgentDescriptorSnapshot 或远端发现结果取值。
 * - 快照缺失 / 跨 Agent / 跨租户 → 发布整体失败（事务回滚）：Revision 保持 draft，
 *   无 PublicationRecord、无 AuditEvent、无 Outbox 事件。
 * - Audit `after` 与 Outbox payload 只含 snapshot id / digest 级事实，
 *   不含原始合同 JSON、URL、secret、employee_id、corp_id。
 *
 * 发布权威已切换为 AgentContractSnapshot：Revision 通过正式 createDraftRevision
 * 绑定真实快照行（seedAgentContractSnapshot），发布走正式 mysqlAgentPublicationStore；
 * store seam 仅用于记录 appendPublication/appendAudit/appendOutbox 参数（证据一致性断言），
 * 不 mock 预计算 digest。
 */
import { createPublishAgentRevision } from "@/lib/agents/application/publish-agent-revision";
import { AgentPublicationContractSnapshotMissingError } from "@/lib/agents/domain/agent-revision-publication-policy";
import type {
  AgentPublicationSession,
  AgentPublicationStore,
} from "@/lib/agents/persistence/agent-publication-store";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import {
  createDraftRevision,
  getRevisionById,
} from "@/lib/agents/persistence/agent-revision-queries";
import { mysqlAgentPublicationStore } from "@/lib/agents/persistence/mysql-agent-publication-store";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { agentRevisionTable } from "@/lib/persistence/schema/agents";
import { auditEvent } from "@/lib/persistence/schema/audit";
import { getPublicationRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

/** 直接写 Revision 的合同快照绑定（模拟脏数据/跨 Agent 引用，仅供失败用例）。 */
async function bindRevisionContractSnapshot(revisionId: string, snapshotId: string | null) {
  await db
    .update(agentRevisionTable)
    .set({ agentContractSnapshotId: snapshotId })
    .where(eq(agentRevisionTable.id, revisionId));
}

interface RecordedPublicationCalls {
  appendPublication: Array<Record<string, unknown>>;
  appendAudit: Array<Record<string, unknown>>;
  appendOutbox: Array<Record<string, unknown>>;
}

async function seedContractPublishFixture() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "contract-publish-owner",
    email: "contract-publish-owner@example.com",
    displayName: "Contract Publish Owner",
  });
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: "contract-publish-agent",
    displayName: "Contract Publish Agent",
    ownerUserId: identity.id,
  });
  const revision = await createDraftRevision({
    tenantId: tenant.id,
    agentId: agent.id,
    sourceType: "agent_yaml",
    sourceRevision: "git:contract-publish-v1",
    instructionHash: "sha256:contract-publish-instruction",
    agentArtifactRef: "oci://registry/agent@sha256:contract-publish",
    agentContractSnapshotId: null,
    modelPolicyJson: { model: "doubao-pro" },
    permissionRequirementsJson: {},
    delegationPolicyJson: {},
    agentInterfaceRequirementsJson: { required: [], optional: [] },
    createdBy: identity.id,
  });
  return { tenantId: tenant.id, ownerId: identity.id, agent, revision };
}

/**
 * store seam：在正式 AgentPublicationStore 之上记录
 * appendPublication / appendAudit / appendOutbox 的参数（供证据一致性断言）。
 */
function withPublicationRecording(): {
  store: AgentPublicationStore;
  recorded: RecordedPublicationCalls;
} {
  const recorded: RecordedPublicationCalls = {
    appendPublication: [],
    appendAudit: [],
    appendOutbox: [],
  };
  const store: AgentPublicationStore = {
    transaction: (operation) =>
      mysqlAgentPublicationStore.transaction((session) => {
        const seam: AgentPublicationSession = {
          ...session,
          appendPublication(params) {
            recorded.appendPublication.push(params as unknown as Record<string, unknown>);
            return session.appendPublication(params);
          },
          appendAudit(params) {
            recorded.appendAudit.push(params as unknown as Record<string, unknown>);
            return session.appendAudit(params);
          },
          appendOutbox(params) {
            recorded.appendOutbox.push(params as unknown as Record<string, unknown>);
            return session.appendOutbox(params);
          },
        };
        return operation(seam);
      }),
  };
  return { store, recorded };
}

function publishCommand(fixture: {
  tenantId: string;
  ownerId: string;
  revision: { id: string };
  agent: { versionNo: number };
}) {
  return {
    tenantId: fixture.tenantId,
    revisionId: fixture.revision.id,
    agentExpectedVersionNo: fixture.agent.versionNo,
    attestationId: null,
    actor: {
      tenantId: fixture.tenantId,
      actorType: "user" as const,
      actorId: fixture.ownerId,
    },
    requestId: "req-contract-publish",
    idempotencyKey: "publish-contract-revision",
  };
}

async function assertNothingPublished(tenantId: string, revisionId: string) {
  const revision = await getRevisionById(revisionId);
  expect(revision?.revisionState).toBe("draft");
  expect(
    await getPublicationRecordBySubject({
      tenantId,
      subjectType: "agent_revision",
      subjectRevisionId: revisionId,
    }),
  ).toBeNull();
  const audits = await db
    .select({ id: auditEvent.id })
    .from(auditEvent)
    .where(and(eq(auditEvent.tenantId, tenantId), eq(auditEvent.targetId, revisionId)));
  expect(audits).toHaveLength(0);
  const outbox = await db
    .select({ id: controlPlaneOutboxEvent.id })
    .from(controlPlaneOutboxEvent)
    .where(eq(controlPlaneOutboxEvent.aggregateId, revisionId));
  expect(outbox).toHaveLength(0);
}

describe("PublishAgentRevision（AgentContractSnapshot 发布权威）", () => {
  it("从绑定的结构化合同快照冻结发布证据：snapshot id + contract/capability/context digest", async () => {
    const tenant = await ensureDefaultTenant();
    const owner = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "contract-owner",
      email: "contract-owner@example.com",
      displayName: "Contract Owner",
    });
    const agent = await createAgent({
      tenantId: tenant.id,
      agentKey: "hr-publish-agent",
      displayName: "HR Publish Agent",
      ownerUserId: owner.id,
    });
    const snapshot = await seedAgentContractSnapshot({
      tenantId: tenant.id,
      agentId: agent.id,
      createdBy: owner.id,
    });
    const revision = await createDraftRevision({
      tenantId: tenant.id,
      agentId: agent.id,
      sourceType: "agent_yaml",
      sourceRevision: "git:hr-publish-v1",
      instructionHash: "sha256:hr-publish-instruction",
      agentArtifactRef: "oci://registry/agent@sha256:hr-publish",
      agentContractSnapshotId: snapshot.id,
      modelPolicyJson: { model: "doubao-pro" },
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: owner.id,
    });

    const { store, recorded } = withPublicationRecording();
    const publishAgentRevision = createPublishAgentRevision({ store });

    const result = await publishAgentRevision({
      tenantId: tenant.id,
      revisionId: revision.id,
      agentExpectedVersionNo: agent.versionNo,
      attestationId: null,
      actor: { tenantId: tenant.id, actorType: "user", actorId: owner.id },
      requestId: "req-contract-publish-happy",
      idempotencyKey: "publish-contract-revision-happy",
    });

    // 发布成功：Revision published + PublicationRecord/audit/outbox 落库
    expect(result.revision.revisionState).toBe("published");
    expect((await getRevisionById(revision.id))?.revisionState).toBe("published");
    expect(
      await getPublicationRecordBySubject({
        tenantId: tenant.id,
        subjectType: "agent_revision",
        subjectRevisionId: revision.id,
      }),
    ).not.toBeNull();

    // 证据一致性：发布证据 digest 等于结构化快照 header 字段
    expect(recorded.appendPublication).toHaveLength(1);
    const publicationJson = JSON.stringify(recorded.appendPublication[0]);
    expect(publicationJson).toContain(snapshot.id);
    expect(publicationJson).toContain(snapshot.contractDigest);
    expect(publicationJson).toContain(snapshot.capabilityDigest);
    expect(publicationJson).toContain(snapshot.contextDigest);

    // Audit after：只含 snapshot id / digest 级事实
    expect(recorded.appendAudit).toHaveLength(1);
    const auditAfter = recorded.appendAudit[0]!.after as Record<string, unknown>;
    expect(auditAfter.agent_contract_snapshot_id).toBe(snapshot.id);
    expect(auditAfter.contract_digest).toBe(snapshot.contractDigest);
    expect(auditAfter.capability_digest).toBe(snapshot.capabilityDigest);
    expect(auditAfter.context_digest).toBe(snapshot.contextDigest);
    const auditJson = JSON.stringify(auditAfter);
    expect(auditJson).not.toMatch(/https?:\/\//);
    expect(auditJson).not.toContain("employee_id");
    expect(auditJson).not.toContain("corp_id");
    expect(auditJson).not.toContain("authorization");
    expect(auditJson).not.toContain("canonicalProviderDescriptor");

    // Outbox payload：只含 snapshot id 级事实
    expect(recorded.appendOutbox).toHaveLength(1);
    const outboxPayload = recorded.appendOutbox[0]!.payload as Record<string, unknown>;
    expect(outboxPayload.agent_contract_snapshot_id).toBe(snapshot.id);
    const outboxJson = JSON.stringify(outboxPayload);
    expect(outboxJson).not.toMatch(/https?:\/\//);
    expect(outboxJson).not.toContain("employee_id");
    expect(outboxJson).not.toContain("corp_id");
  });

  it("绑定的合同快照不存在 → 发布失败并整体回滚：Revision 保持 draft，无 PublicationRecord/Audit/Outbox", async () => {
    const fixture = await seedContractPublishFixture();
    await bindRevisionContractSnapshot(fixture.revision.id, "not-a-real-snapshot");
    const publishAgentRevision = createPublishAgentRevision({
      store: mysqlAgentPublicationStore,
    });

    await expect(publishAgentRevision(publishCommand(fixture))).rejects.toBeInstanceOf(
      AgentPublicationContractSnapshotMissingError,
    );
    await assertNothingPublished(fixture.tenantId, fixture.revision.id);
  });

  it("绑定的合同快照属于其他 Agent → 发布失败并整体回滚", async () => {
    const fixture = await seedContractPublishFixture();
    // 同租户另一个 Agent 的真实快照（存在但不属于 Revision 的 Agent）
    const otherAgent = await createAgent({
      tenantId: fixture.tenantId,
      agentKey: "other-contract-agent",
      displayName: "Other Contract Agent",
      ownerUserId: fixture.ownerId,
    });
    const otherSnapshot = await seedAgentContractSnapshot({
      tenantId: fixture.tenantId,
      agentId: otherAgent.id,
      createdBy: fixture.ownerId,
    });
    await bindRevisionContractSnapshot(fixture.revision.id, otherSnapshot.id);
    const publishAgentRevision = createPublishAgentRevision({
      store: mysqlAgentPublicationStore,
    });

    await expect(publishAgentRevision(publishCommand(fixture))).rejects.toBeInstanceOf(
      AgentPublicationContractSnapshotMissingError,
    );
    await assertNothingPublished(fixture.tenantId, fixture.revision.id);
  });
});
