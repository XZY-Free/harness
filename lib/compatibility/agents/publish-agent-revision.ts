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
import { computePublicationEvidenceSetDigest } from "@/lib/publications/domain/publication-record";

export interface PublishLegacyAgentRevisionResult {
  revision: AgentPublicationRevision;
  publicationRecordId: string;
  auditEventId: string;
  outboxEventId: string;
}

export function createPublishLegacyAgentRevision(dependencies: {
  store: AgentPublicationStore;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;

  return async function publishLegacyAgentRevision(command: {
    tenantId: string;
    revisionId: string;
    agentExpectedVersionNo: number;
    requestId: string;
  }): Promise<PublishLegacyAgentRevisionResult> {
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
        }),
        attestationIds: [],
        publishedByType: "system",
        publishedBy: "legacy-agent-revision-queries",
        publishedAt,
        idempotencyKey: `compat:publish:${revision.id}`,
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
        actorId: "legacy-agent-revision-queries",
        revisionId: revision.id,
        after: {
          agent_id: revision.agentId,
          revision_no: revision.revisionNo,
          revision_state: "published",
          publication_record_id: publicationRecordId,
        },
        reason: "AgentRevision 由兼容入口发布；未声明 Attestation",
        requestId: command.requestId,
        occurredAt: publishedAt,
      });

      const outboxEventId = newId();
      await session.appendOutbox({
        id: outboxEventId,
        tenantId: command.tenantId,
        eventKey: `agent-revision-published:${revision.id}`,
        eventType: "agent.revision.published",
        aggregateType: "agent_revision",
        aggregateId: revision.id,
        payload: {
          agent_id: revision.agentId,
          revision_id: revision.id,
          revision_no: revision.revisionNo,
          publication_record_id: publicationRecordId,
          audit_event_id: auditEventId,
          compatibility_source: "legacy-agent-revision-queries",
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
