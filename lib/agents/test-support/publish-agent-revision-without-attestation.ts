import { randomUUID } from "node:crypto";
import {
  AgentPublicationVersionConflictError,
  AgentRevisionPublicationNotFoundError,
  AgentRevisionPublicationStateError,
  assertAgentRevisionPublishable,
} from "@/lib/agents/domain/agent-revision-publication-policy";
import type {
  AgentPublicationRevision,
  AgentPublicationStore,
} from "@/lib/agents/persistence/agent-publication-store";
import {
  AgentVersionConflictError,
  RevisionNotFoundError,
  RevisionStateError,
  getRevisionById,
} from "@/lib/agents/persistence/agent-revision-queries";
import { mysqlAgentPublicationStore } from "@/lib/agents/persistence/mysql-agent-publication-store";
import { computePublicationEvidenceSetDigest } from "@/lib/publications/domain/publication-record";
import { ensureAgentContractSnapshotBoundForRevision } from "@/lib/test-support/ensure-agent-contract-snapshot";

export interface PublishAgentRevisionWithoutAttestationResult {
  revision: AgentPublicationRevision;
  publicationRecordId: string;
  auditEventId: string;
  outboxEventId: string;
}

export function createPublishAgentRevisionWithoutAttestation(dependencies: {
  store: AgentPublicationStore;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;

  return async function publishAgentRevisionWithoutAttestation(command: {
    tenantId: string;
    revisionId: string;
    agentExpectedVersionNo: number;
    requestId: string;
  }): Promise<PublishAgentRevisionWithoutAttestationResult> {
    // 发布权威 = 绑定 AgentContractSnapshot（无源码 Artifact 强前置）。
    // 在事务外先幂等地绑定 Snapshot（不可变），避免在 db.transaction 内再开嵌套
    // db.transaction（ensure helper 内部）导致 MySQL 连接/锁死锁。
    // 缺失 Revision 走与事务路径一致的 AgentRevisionPublicationNotFoundError（publishRevision 包装映射为 RevisionNotFoundError）。
    const found = await getRevisionById(command.revisionId);
    if (!found) {
      throw new AgentRevisionPublicationNotFoundError(command.revisionId);
    }
    const contractSnapshot = await ensureAgentContractSnapshotBoundForRevision(
      command.revisionId,
      command.tenantId,
    );
    const contractEvidence = {
      agentContractSnapshotId: contractSnapshot.id,
      agentContractDigest: contractSnapshot.contractDigest,
      agentCapabilityDigest: contractSnapshot.capabilityDigest,
      agentContextDigest: contractSnapshot.contextDigest,
    };

    return dependencies.store.transaction(async (session) => {
      const revision = await session.findRevision(command.tenantId, command.revisionId);
      if (!revision) {
        throw new AgentRevisionPublicationNotFoundError(command.revisionId);
      }
      assertAgentRevisionPublishable({
        revisionId: revision.id,
        revisionState: revision.revisionState,
      });

      const agent = await session.findAgent(command.tenantId, revision.agentId);
      if (!agent || agent.versionNo !== command.agentExpectedVersionNo) {
        throw new AgentPublicationVersionConflictError(
          revision.agentId,
          command.agentExpectedVersionNo,
        );
      }

      const publishedAt = now();
      const publicationRecordId = newId();
      await session.appendPublication({
        id: publicationRecordId,
        tenantId: command.tenantId,
        revisionId: revision.id,
        evidenceSetDigest: computePublicationEvidenceSetDigest({
          attestationIds: [],
          conformanceRunId: null,
          approvals: [],
          additionalEvidence: {
            agent_contract_snapshot: {
              id: contractSnapshot.id,
              contract_digest: contractSnapshot.contractDigest,
              capability_digest: contractSnapshot.capabilityDigest,
              context_digest: contractSnapshot.contextDigest,
            },
          },
        }),
        contractEvidence,
        publishedByType: "system",
        publishedBy: "test-support",
        publishedAt,
        idempotencyKey: `test:publish-without-attestation:${revision.id}`,
        idempotencyRecordId: null,
      });
      if (!(await session.markRevisionPublished(revision.id, publishedAt))) {
        throw new AgentRevisionPublicationStateError(
          revision.id,
          revision.revisionState,
          "Revision 已被并发发布或状态已变化",
        );
      }
      if (
        !(await session.setAgentCurrentRevision({
          tenantId: command.tenantId,
          agentId: revision.agentId,
          revisionId: revision.id,
          expectedVersionNo: command.agentExpectedVersionNo,
          // 与正式发布一致的生命周期不变量：draft→enabled，其余保持原状
          lifecycleState: agent.lifecycleState === "draft" ? "enabled" : agent.lifecycleState,
          updatedAt: publishedAt,
        }))
      ) {
        throw new AgentPublicationVersionConflictError(
          revision.agentId,
          command.agentExpectedVersionNo,
        );
      }

      const auditEventId = newId();
      await session.appendAudit({
        id: auditEventId,
        tenantId: command.tenantId,
        actorType: "system",
        actorId: "test-support",
        revisionId: revision.id,
        after: {
          agent_id: revision.agentId,
          revision_no: revision.revisionNo,
          revision_state: "published",
          publication_record_id: publicationRecordId,
        },
        reason: "测试夹具发布 AgentRevision；未声明 Attestation",
        requestId: command.requestId,
        occurredAt: publishedAt,
      });

      const outboxEventId = newId();
      await session.appendOutbox({
        id: outboxEventId,
        tenantId: command.tenantId,
        eventKey: `agent-revision-published:${revision.id}`,
        eventType: "agent.revision.published",
        aggregateId: revision.id,
        aggregateVersion: revision.revisionNo,
        payload: {
          agent_id: revision.agentId,
          revision_id: revision.id,
          revision_no: revision.revisionNo,
          publication_record_id: publicationRecordId,
          audit_event_id: auditEventId,
          test_support_source: "publish-agent-revision-without-attestation",
        },
        occurredAt: publishedAt,
      });

      return {
        revision: { ...revision, revisionState: "published", publishedAt },
        publicationRecordId,
        auditEventId,
        outboxEventId,
      };
    });
  };
}

const publishAgentRevisionWithoutAttestation = createPublishAgentRevisionWithoutAttestation({
  store: mysqlAgentPublicationStore,
});

/** 仅供旧集成测试构造已发布 Revision；生产代码不得调用。 */
export async function publishRevision(
  tenantId: string,
  revisionId: string,
  agentExpectedVersionNo: number,
): Promise<AgentPublicationRevision> {
  try {
    await publishAgentRevisionWithoutAttestation({
      tenantId,
      revisionId,
      agentExpectedVersionNo,
      requestId: randomUUID(),
    });
    const published = await getRevisionById(revisionId);
    if (!published) throw new RevisionNotFoundError(revisionId);
    return published;
  } catch (error) {
    if (error instanceof AgentRevisionPublicationNotFoundError) {
      throw new RevisionNotFoundError(error.revisionId);
    }
    if (error instanceof AgentRevisionPublicationStateError) {
      throw new RevisionStateError(error.revisionId, error.fromState, "published", error.message);
    }
    if (error instanceof AgentPublicationVersionConflictError) {
      throw new AgentVersionConflictError(error.agentId, error.expectedVersionNo);
    }
    throw error;
  }
}
