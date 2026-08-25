import { randomUUID } from "node:crypto";
import {
  AgentPublicationDescriptorSnapshotMissingError,
  AgentPublicationIdempotencyCompletionError,
  AgentPublicationPrerequisiteError,
  AgentPublicationVersionConflictError,
  AgentRevisionPublicationNotFoundError,
  AgentRevisionPublicationStateError,
  assertAgentRevisionPublishable,
} from "@/lib/agents/domain/agent-revision-publication-policy";
import type {
  AgentPublicationActorType,
  AgentPublicationAttestation,
  AgentPublicationDescriptorSnapshot,
  AgentPublicationRevision,
  AgentPublicationStore,
} from "@/lib/agents/persistence/agent-publication-store";
import { computePublicationEvidenceSetDigest } from "@/lib/publications/domain/publication-record";

export interface PublishAgentRevisionResult {
  revision: AgentPublicationRevision;
  /** 可选 source Attestation；Batch 2 起发布权威是 DescriptorSnapshot，无 Attestation 时为 null。 */
  attestation: AgentPublicationAttestation | null;
  auditEventId: string;
  outboxEventId: string;
  publicationRecordId: string;
}

export interface PublishAgentRevisionCommand {
  tenantId: string;
  revisionId: string;
  agentExpectedVersionNo: number;
  /** 可选 source Attestation id（Batch 2 不再强制；传了但未验证则拒绝）。 */
  attestationId?: string | null;
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

/** 从绑定的 DescriptorSnapshot 构造附加证据（Batch 2 权威外部合同）。 */
function descriptorAdditionalEvidence(snapshot: AgentPublicationDescriptorSnapshot): unknown {
  return {
    agent_descriptor_snapshot: {
      id: snapshot.id,
      provider_descriptor_digest: snapshot.providerDescriptorDigest,
      capability_manifest_digest: snapshot.capabilityManifestDigest,
      invocation_context_contract_digest: snapshot.invocationContextContractDigest,
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

      // 发布权威 = 绑定的 AgentDescriptorSnapshot（Batch 2：无源码 Artifact/Attestation 强前置）。
      // §5 门禁：Snapshot 必须存在且属于相同 tenant/Agent；digest 从不可变 Snapshot 冻结。
      const snapshot = revision.agentDescriptorSnapshotId
        ? await session.findDescriptorSnapshot(command.tenantId, revision.agentDescriptorSnapshotId)
        : null;
      if (!snapshot || snapshot.agentId !== revision.agentId) {
        throw new AgentPublicationDescriptorSnapshotMissingError(revision.id);
      }

      // 可选 source Attestation：未提供则仅凭 Descriptor 证据发布；提供了但未验证则拒绝。
      let attestation: AgentPublicationAttestation | null = null;
      let attestationIds: string[] = [];
      if (command.attestationId) {
        attestation = await session.findVerifiedAttestation({
          tenantId: command.tenantId,
          revisionId: revision.id,
          attestationId: command.attestationId,
        });
        if (!attestation) {
          throw new AgentPublicationPrerequisiteError(revision.id, command.attestationId);
        }
        attestationIds = [attestation.id];
      }

      const descriptorEvidence = {
        agentDescriptorSnapshotId: snapshot.id,
        agentProviderDescriptorDigest: snapshot.providerDescriptorDigest,
        agentCapabilityManifestDigest: snapshot.capabilityManifestDigest,
        agentInvocationContextContractDigest: snapshot.invocationContextContractDigest,
      };

      const publishedAt = now();
      const publicationRecordId = newId();
      await session.appendPublication({
        id: publicationRecordId,
        tenantId: command.tenantId,
        revisionId: revision.id,
        evidenceSetDigest: computePublicationEvidenceSetDigest({
          attestationIds,
          conformanceRunId: null,
          approvals: [],
          additionalEvidence: descriptorAdditionalEvidence(snapshot),
        }),
        attestationIds,
        descriptorEvidence,
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
        actorType: command.actor.actorType,
        actorId: command.actor.actorId,
        revisionId: revision.id,
        after: {
          agent_id: revision.agentId,
          revision_no: revision.revisionNo,
          revision_state: "published",
          agent_descriptor_snapshot_id: snapshot.id,
          capability_manifest_digest: snapshot.capabilityManifestDigest,
          invocation_context_contract_digest: snapshot.invocationContextContractDigest,
          attestation_id: attestation?.id ?? null,
          artifact_digest: attestation?.artifactDigest ?? null,
          publication_record_id: publicationRecordId,
        },
        reason: "AgentRevision 发布（DescriptorSnapshot 证据冻结）",
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
          agent_descriptor_snapshot_id: snapshot.id,
          attestation_id: attestation?.id ?? null,
          audit_event_id: auditEventId,
          publication_record_id: publicationRecordId,
        },
        occurredAt: publishedAt,
      });

      const result: PublishAgentRevisionResult = {
        revision: { ...revision, revisionState: "published", publishedAt },
        attestation,
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
