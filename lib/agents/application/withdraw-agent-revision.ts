import { randomUUID } from "node:crypto";
import {
  AgentRevisionWithdrawalNotFoundError,
  AgentRevisionWithdrawalPublicationNotFoundError,
  AgentRevisionWithdrawalStateError,
  AgentWithdrawalIdempotencyCompletionError,
  AgentWithdrawalVersionConflictError,
  assertAgentRevisionWithdrawable,
} from "@/lib/agents/domain/agent-revision-withdrawal-policy";
import type {
  AgentWithdrawalRevision,
  AgentWithdrawalStore,
} from "@/lib/agents/persistence/agent-withdrawal-store";
import type { PublicationActorType } from "@/lib/publications/domain/publication-record";

export interface WithdrawAgentRevisionResult {
  revision: AgentWithdrawalRevision;
  currentRevisionId: string | null;
  withdrawalRecordId: string;
  auditEventId: string;
  outboxEventId: string;
}

export interface WithdrawAgentRevisionCommand {
  tenantId: string;
  revisionId: string;
  agentExpectedVersionNo: number;
  actor: {
    tenantId: string;
    actorType: PublicationActorType;
    actorId: string;
  };
  reasonCode: string;
  reason: string;
  requestId: string;
  idempotency?: {
    recordId: string;
    httpStatus: number;
    responseRef?: string | null;
    serializeResponse: (result: WithdrawAgentRevisionResult) => string;
  };
}

export function createWithdrawAgentRevision(dependencies: {
  store: AgentWithdrawalStore;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;

  return async function withdrawAgentRevision(
    command: WithdrawAgentRevisionCommand,
  ): Promise<WithdrawAgentRevisionResult> {
    if (command.actor.tenantId !== command.tenantId) {
      throw new Error("AgentRevision 撤回 actor tenant 与命令 tenant 不一致");
    }

    return dependencies.store.transaction(async (session) => {
      const revision = await session.findRevision(command.tenantId, command.revisionId);
      if (!revision) throw new AgentRevisionWithdrawalNotFoundError(command.revisionId);
      assertAgentRevisionWithdrawable({
        revisionId: revision.id,
        revisionState: revision.revisionState,
        reasonCode: command.reasonCode,
        reason: command.reason,
      });

      const agent = await session.findAgent(command.tenantId, revision.agentId);
      if (!agent || agent.versionNo !== command.agentExpectedVersionNo) {
        throw new AgentWithdrawalVersionConflictError(
          revision.agentId,
          command.agentExpectedVersionNo,
        );
      }
      const publication = await session.findPublication(command.tenantId, revision.id);
      if (!publication) {
        throw new AgentRevisionWithdrawalPublicationNotFoundError(revision.id);
      }

      const withdrawnAt = now();
      const currentRevisionId = await session.findLatestPublishedRevisionId({
        tenantId: command.tenantId,
        agentId: revision.agentId,
        excludingRevisionId: revision.id,
      });
      const withdrawalRecordId = newId();
      await session.appendWithdrawal({
        id: withdrawalRecordId,
        tenantId: command.tenantId,
        publicationRecordId: publication.id,
        revisionId: revision.id,
        reasonCode: command.reasonCode.trim(),
        reason: command.reason.trim(),
        withdrawnByType: command.actor.actorType,
        withdrawnBy: command.actor.actorId,
        withdrawnAt,
      });
      if (!(await session.markRevisionWithdrawn(revision.id))) {
        throw new AgentRevisionWithdrawalStateError(revision.id, revision.revisionState);
      }
      if (
        !(await session.setAgentCurrentRevision({
          tenantId: command.tenantId,
          agentId: revision.agentId,
          currentRevisionId,
          expectedVersionNo: command.agentExpectedVersionNo,
          updatedAt: withdrawnAt,
        }))
      ) {
        throw new AgentWithdrawalVersionConflictError(
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
        reasonCode: command.reasonCode.trim(),
        reason: command.reason.trim(),
        after: {
          agent_id: revision.agentId,
          revision_no: revision.revisionNo,
          revision_state: "withdrawn",
          publication_record_id: publication.id,
          withdrawal_record_id: withdrawalRecordId,
          current_revision_id: currentRevisionId,
        },
        requestId: command.requestId,
        occurredAt: withdrawnAt,
      });

      const outboxEventId = newId();
      await session.appendOutbox({
        id: outboxEventId,
        tenantId: command.tenantId,
        eventKey: `agent-revision-withdrawn:${revision.id}`,
        eventType: "agent.revision.withdrawn",
        aggregateId: revision.id,
        aggregateVersion: revision.revisionNo,
        payload: {
          agent_id: revision.agentId,
          revision_id: revision.id,
          publication_record_id: publication.id,
          withdrawal_record_id: withdrawalRecordId,
          current_revision_id: currentRevisionId,
          audit_event_id: auditEventId,
        },
        occurredAt: withdrawnAt,
      });

      const result: WithdrawAgentRevisionResult = {
        revision: { ...revision, revisionState: "withdrawn" },
        currentRevisionId,
        withdrawalRecordId,
        auditEventId,
        outboxEventId,
      };
      if (command.idempotency) {
        const completed = await session.completeIdempotency({
          recordId: command.idempotency.recordId,
          httpStatus: command.idempotency.httpStatus,
          responseRef: command.idempotency.responseRef ?? null,
          responseRedactedJson: command.idempotency.serializeResponse(result),
          completedAt: withdrawnAt,
        });
        if (!completed) {
          throw new AgentWithdrawalIdempotencyCompletionError(command.idempotency.recordId);
        }
      }
      return result;
    });
  };
}
