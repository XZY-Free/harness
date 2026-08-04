import { randomUUID } from "node:crypto";
import { computePublicationEvidenceSetDigest } from "@/lib/publications/domain/publication-record";
import {
  ConformanceGateError,
  MANDATORY_GATE_CASES,
  RuntimePublicationIdempotencyCompletionError,
  RuntimePublicationPrerequisiteError,
  RuntimeRevisionNotFoundError,
  RuntimeRevisionStateError,
  RuntimeVersionConflictError,
} from "@/lib/runtimes/domain/runtime-revision-publication-policy";
import type {
  RuntimePublicationActorType,
  RuntimePublicationAttestation,
  RuntimePublicationRevision,
  RuntimePublicationStore,
  StoredRuntimeConformanceResult,
} from "@/lib/runtimes/persistence/runtime-publication-store";

export interface PublishRuntimeRevisionResult {
  revision: RuntimePublicationRevision;
  attestation: RuntimePublicationAttestation | null;
  conformanceResults: StoredRuntimeConformanceResult[];
  publicationRecordId: string;
  auditEventId: string;
  outboxEventId: string;
}

export interface PublishRuntimeRevisionCommand {
  tenantId: string;
  revisionId: string;
  runtimeExpectedVersionNo: number;
  /** 必须显式选择已完成且与 Revision 绑定一致的 Passed Run。 */
  conformanceRunId?: string;
  attestationId?: string;
  actor: {
    tenantId: string;
    actorType: RuntimePublicationActorType;
    actorId: string;
  };
  requestId: string;
  idempotencyKey: string;
  idempotency?: {
    recordId: string;
    httpStatus: number;
    responseRef?: string | null;
    serializeResponse: (result: PublishRuntimeRevisionResult) => string;
  };
}

export function createPublishRuntimeRevision(dependencies: {
  store: RuntimePublicationStore;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;

  return async function publishRuntimeRevision(
    command: PublishRuntimeRevisionCommand,
  ): Promise<PublishRuntimeRevisionResult> {
    if (command.actor.tenantId !== command.tenantId) {
      throw new Error("RuntimeRevision 发布 actor tenant 与命令 tenant 不一致");
    }

    const conformanceRunId = command.conformanceRunId;
    if (!conformanceRunId) {
      throw new ConformanceGateError([...MANDATORY_GATE_CASES]);
    }

    return dependencies.store.transaction(async (session) => {
      const revision = await session.findRevision(command.tenantId, command.revisionId);
      if (!revision) throw new RuntimeRevisionNotFoundError(command.revisionId);
      if (revision.revisionState !== "draft") {
        throw new RuntimeRevisionStateError(
          revision.id,
          revision.revisionState,
          "published",
          "只有 draft 状态可发布",
        );
      }

      const runtime = await session.findRuntime(command.tenantId, revision.runtimeId);
      if (!runtime || runtime.versionNo !== command.runtimeExpectedVersionNo) {
        throw new RuntimeVersionConflictError(revision.runtimeId, command.runtimeExpectedVersionNo);
      }

      let attestation: RuntimePublicationAttestation | null = null;
      if (command.attestationId) {
        attestation = await session.findVerifiedAttestation({
          tenantId: command.tenantId,
          revisionId: revision.id,
          attestationId: command.attestationId,
        });
        if (!attestation) {
          throw new RuntimePublicationPrerequisiteError(revision.id, command.attestationId);
        }
      }

      const conformanceRun = await session.findPassedConformanceRun({
        tenantId: command.tenantId,
        revisionId: revision.id,
        conformanceRunId,
      });
      if (!conformanceRun) throw new ConformanceGateError([...MANDATORY_GATE_CASES]);
      const publishedAt = now();
      const conformanceResults = conformanceRun.results;

      const publicationRecordId = newId();
      const attestationIds = attestation ? [attestation.id] : [];
      await session.appendPublication({
        id: publicationRecordId,
        tenantId: command.tenantId,
        revisionId: revision.id,
        evidenceSetDigest: computePublicationEvidenceSetDigest({
          attestationIds,
          conformanceRunId: conformanceRun.id,
          approvals: [],
          additionalEvidence: { evidenceManifestDigest: conformanceRun.evidenceManifestDigest },
        }),
        attestationIds,
        publishedByType: command.actor.actorType,
        publishedBy: command.actor.actorId,
        publishedAt,
        idempotencyKey: command.idempotencyKey,
        idempotencyRecordId: command.idempotency?.recordId ?? null,
        conformanceRunId: conformanceRun.id,
      });

      if (!(await session.markRevisionPublished(revision.id, publishedAt))) {
        throw new RuntimeRevisionStateError(
          revision.id,
          revision.revisionState,
          "published",
          "Revision 已被并发发布或状态已变化",
        );
      }
      if (
        !(await session.setRuntimeCurrentRevision({
          tenantId: command.tenantId,
          runtimeId: revision.runtimeId,
          revisionId: revision.id,
          expectedVersionNo: command.runtimeExpectedVersionNo,
          updatedAt: publishedAt,
        }))
      ) {
        throw new RuntimeVersionConflictError(revision.runtimeId, command.runtimeExpectedVersionNo);
      }

      const auditEventId = newId();
      await session.appendAudit({
        id: auditEventId,
        tenantId: command.tenantId,
        actorType: command.actor.actorType,
        actorId: command.actor.actorId,
        revisionId: revision.id,
        after: {
          runtime_id: revision.runtimeId,
          revision_no: revision.revisionNo,
          revision_state: "published",
          attestation_id: attestation?.id ?? null,
          artifact_digest: attestation?.artifactDigest ?? null,
          publication_record_id: publicationRecordId,
          conformance_run_id: conformanceRun.id,
        },
        reason: "RuntimeRevision 发布（conformance 门禁通过）",
        requestId: command.requestId,
        occurredAt: publishedAt,
      });

      const outboxEventId = newId();
      await session.appendOutbox({
        id: outboxEventId,
        tenantId: command.tenantId,
        eventKey: `runtime-revision-published:${revision.id}`,
        eventType: "runtime.revision.published",
        aggregateType: "runtime_revision",
        aggregateId: revision.id,
        payload: {
          runtime_id: revision.runtimeId,
          revision_id: revision.id,
          revision_no: revision.revisionNo,
          attestation_id: attestation?.id ?? null,
          audit_event_id: auditEventId,
          publication_record_id: publicationRecordId,
          conformance_run_id: conformanceRun.id,
        },
        occurredAt: publishedAt,
      });

      const result: PublishRuntimeRevisionResult = {
        revision: { ...revision, revisionState: "published", publishedAt },
        attestation,
        conformanceResults,
        publicationRecordId,
        auditEventId,
        outboxEventId,
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
          throw new RuntimePublicationIdempotencyCompletionError(command.idempotency.recordId);
        }
      }

      return result;
    });
  };
}
