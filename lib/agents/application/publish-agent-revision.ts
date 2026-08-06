import { randomUUID } from "node:crypto";
import {
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
 AgentPublicationRevision,
 AgentPublicationStore,
} from "@/lib/agents/persistence/agent-publication-store";
import { computePublicationEvidenceSetDigest } from "@/lib/publications/domain/publication-record";

export interface PublishAgentRevisionResult {
 revision: AgentPublicationRevision;
 attestation: AgentPublicationAttestation;
 auditEventId: string;
 outboxEventId: string;
 publicationRecordId: string;
}

export interface PublishAgentRevisionCommand {
 tenantId: string;
 revisionId: string;
 agentExpectedVersionNo: number;
 attestationId: string;
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

 const attestation = await session.findVerifiedAttestation({
 tenantId: command.tenantId,
 revisionId: revision.id,
 attestationId: command.attestationId,
 });
 if (!attestation) {
 throw new AgentPublicationPrerequisiteError(revision.id, command.attestationId);
 }

 const publishedAt = now();
 const publicationRecordId = newId();
 const attestationIds = [attestation.id];
 await session.appendPublication({
 id: publicationRecordId,
 tenantId: command.tenantId,
 revisionId: revision.id,
 evidenceSetDigest: computePublicationEvidenceSetDigest({
 attestationIds,
 conformanceRunId: null,
 approvals: [],
 }),
 attestationIds,
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
 attestation_id: attestation.id,
 artifact_digest: attestation.artifactDigest,
 publication_record_id: publicationRecordId,
 },
 reason: "AgentRevision 发布（attestation 门禁通过）",
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
 attestation_id: attestation.id,
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
