import { randomUUID } from "node:crypto";
import {
  AgentPublicationContractSnapshotIntegrityError,
  AgentPublicationContractSnapshotMissingError,
  AgentPublicationIdempotencyCompletionError,
  AgentPublicationVersionConflictError,
  AgentRevisionPublicationNotFoundError,
  AgentRevisionPublicationStateError,
  assertAgentRevisionPublishable,
} from "@/lib/agents/domain/agent-revision-publication-policy";
import type {
  AgentPublicationActorType,
  AgentPublicationContractSnapshot,
  AgentPublicationRevision,
  AgentPublicationStore,
} from "@/lib/agents/persistence/agent-publication-store";
import { computePublicationEvidenceSetDigest } from "@/lib/publications/domain/publication-record";

export interface PublishAgentRevisionResult {
  revision: AgentPublicationRevision;
  auditEventId: string;
  outboxEventId: string;
  publicationRecordId: string;
}

export interface PublishAgentRevisionCommand {
  tenantId: string;
  revisionId: string;
  agentExpectedVersionNo: number;
  actor: {
    tenantId: string;
    actorType: AgentPublicationActorType;
    actorId: string;
  };
  requestId: string;
  idempotencyKey: string;
  idempotency?: {
    recordId: string;
    httpStatus: number;
    responseRef?: string | null;
    serializeResponse: (result: PublishAgentRevisionResult) => string;
  };
}

/** 从绑定的 AgentContractSnapshot 构造附加证据（权威外部合同）。 */
function contractAdditionalEvidence(snapshot: AgentPublicationContractSnapshot): unknown {
  return {
    agent_contract_snapshot: {
      id: snapshot.id,
      contract_digest: snapshot.contractDigest,
      capability_digest: snapshot.capabilityDigest,
      context_digest: snapshot.contextDigest,
    },
  };
}

export function createPublishAgentRevision(dependencies: {
  store: AgentPublicationStore;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;

  return async function publishAgentRevision(
    command: PublishAgentRevisionCommand,
  ): Promise<PublishAgentRevisionResult> {
    if (command.actor.tenantId !== command.tenantId) {
      throw new Error("AgentRevision 发布 actor tenant 与命令 tenant 不一致");
    }

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

      // 发布权威 = 绑定的 AgentContractSnapshot（无源码 Artifact/Attestation 强前置）。
      // §5 门禁：Snapshot 必须存在且属于相同 tenant/Agent；digest 从不可变 Snapshot 冻结。
      const snapshot = revision.agentContractSnapshotId
        ? await session.findContractSnapshot(command.tenantId, revision.agentContractSnapshotId)
        : null;
      if (!snapshot || snapshot.agentId !== revision.agentId) {
        throw new AgentPublicationContractSnapshotMissingError(revision.id);
      }
      if (
        snapshot.contractDigest !== snapshot.recomputedContractDigest ||
        snapshot.capabilityDigest !== snapshot.recomputedCapabilityDigest ||
        snapshot.contextDigest !== snapshot.recomputedContextDigest
      ) {
        throw new AgentPublicationContractSnapshotIntegrityError(revision.id);
      }

      const contractEvidence = {
        agentContractSnapshotId: snapshot.id,
        agentContractDigest: snapshot.contractDigest,
        agentCapabilityDigest: snapshot.capabilityDigest,
        agentContextDigest: snapshot.contextDigest,
      };

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
          additionalEvidence: contractAdditionalEvidence(snapshot),
        }),
        contractEvidence,
        publishedByType: command.actor.actorType,
        publishedBy: command.actor.actorId,
        publishedAt,
        idempotencyKey: command.idempotencyKey,
        idempotencyRecordId: command.idempotency?.recordId ?? null,
      });
      if (!(await session.markRevisionPublished(revision.id, publishedAt))) {
        throw new AgentRevisionPublicationStateError(
          revision.id,
          revision.revisionState,
          "Revision 已被并发发布或状态已变化",
        );
      }
      // 生命周期不变量：首个正式发布把 draft 原子迁移为 enabled（同一事务、同一次 update）；
      // enabled/disabled 保持原状，发布绝不偷偷重新启用。
      const nextLifecycleState =
        agent.lifecycleState === "draft" ? "enabled" : agent.lifecycleState;
      if (
        !(await session.setAgentCurrentRevision({
          tenantId: command.tenantId,
          agentId: revision.agentId,
          revisionId: revision.id,
          expectedVersionNo: command.agentExpectedVersionNo,
          lifecycleState: nextLifecycleState,
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
        actorType: command.actor.actorType,
        actorId: command.actor.actorId,
        revisionId: revision.id,
        after: {
          agent_id: revision.agentId,
          revision_no: revision.revisionNo,
          revision_state: "published",
          agent_contract_snapshot_id: snapshot.id,
          contract_digest: snapshot.contractDigest,
          capability_digest: snapshot.capabilityDigest,
          context_digest: snapshot.contextDigest,
          publication_record_id: publicationRecordId,
        },
        reason: "AgentRevision 发布（AgentContractSnapshot 证据冻结）",
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
          agent_contract_snapshot_id: snapshot.id,
          audit_event_id: auditEventId,
          publication_record_id: publicationRecordId,
        },
        occurredAt: publishedAt,
      });

      const result: PublishAgentRevisionResult = {
        revision: { ...revision, revisionState: "published", publishedAt },
        auditEventId,
        outboxEventId,
        publicationRecordId,
      };

      if (command.idempotency) {
        const completed = await session.completeIdempotency({
          recordId: command.idempotency.recordId,
          httpStatus: command.idempotency.httpStatus,
          responseRef: command.idempotency.responseRef ?? null,
          responseRedactedJson: command.idempotency.serializeResponse(result),
          completedAt: publishedAt,
        });
        if (!completed) {
          throw new AgentPublicationIdempotencyCompletionError(command.idempotency.recordId);
        }
      }

      return result;
    });
  };
}
