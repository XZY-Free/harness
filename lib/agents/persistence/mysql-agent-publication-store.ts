import type { AgentPublicationStore } from "@/lib/agents/persistence/agent-publication-store";
import {
  artifact,
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { resolveOutboxAppend } from "@/lib/control-plane/events/outbox-append";
import { db } from "@/lib/db/client";
import { computeContentHash } from "@/lib/identity/audit";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { auditEvent } from "@/lib/persistence/schema/control-plane";
import { idempotencyRecord } from "@/lib/persistence/schema/control-plane";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import { and, eq, isNull } from "drizzle-orm";

export const mysqlAgentPublicationStore: AgentPublicationStore = {
  transaction: (operation) =>
    db.transaction(async (tx) =>
      operation({
        async findRevision(tenantId, revisionId) {
          const [row] = await tx
            .select({ revision: agentRevisionTable })
            .from(agentRevisionTable)
            .innerJoin(
              agentTable,
              and(eq(agentTable.id, agentRevisionTable.agentId), eq(agentTable.tenantId, tenantId)),
            )
            .where(eq(agentRevisionTable.id, revisionId))
            .limit(1)
            .for("update");
          return row?.revision ?? null;
        },
        async findAgent(tenantId, agentId) {
          const [agent] = await tx
            .select()
            .from(agentTable)
            .where(and(eq(agentTable.tenantId, tenantId), eq(agentTable.id, agentId)))
            .limit(1);
          return agent ?? null;
        },
        async findVerifiedAttestation(params) {
          const [attestation] = await tx
            .select({ attestation: artifactAttestation })
            .from(artifactAttestation)
            .innerJoin(artifact, eq(artifact.id, artifactAttestation.artifactId))
            .innerJoin(agentRevisionTable, eq(agentRevisionTable.id, params.revisionId))
            .leftJoin(
              attestationRevocationRecord,
              eq(attestationRevocationRecord.attestationId, artifactAttestation.id),
            )
            .where(
              and(
                eq(artifactAttestation.id, params.attestationId),
                eq(artifactAttestation.tenantId, params.tenantId),
                eq(artifactAttestation.artifactType, "agent_revision"),
                eq(artifactAttestation.artifactRevisionId, params.revisionId),
                eq(artifactAttestation.verificationState, "verified"),
                eq(artifact.tenantId, params.tenantId),
                eq(artifact.digest, artifactAttestation.artifactDigest),
                eq(agentRevisionTable.artifactId, artifact.id),
                eq(agentRevisionTable.artifactDigest, artifact.digest),
                isNull(attestationRevocationRecord.id),
                isNull(artifactAttestation.revokedAt),
              ),
            )
            .limit(1)
            .for("update");
          return attestation?.attestation ?? null;
        },
        async appendPublication(params) {
          await tx.insert(publicationRecord).values({
            id: params.id,
            tenantId: params.tenantId,
            subjectType: "agent_revision",
            subjectRevisionId: params.revisionId,
            evidenceSetDigest: params.evidenceSetDigest,
            attestationIds: params.attestationIds,
            conformanceRunId: null,
            approvals: [],
            publishedByType: params.publishedByType,
            publishedBy: params.publishedBy,
            publishedAt: params.publishedAt,
            idempotencyKey: params.idempotencyKey,
            idempotencyRecordId: params.idempotencyRecordId,
          });
        },
        async markRevisionPublished(revisionId, publishedAt) {
          const result = await tx
            .update(agentRevisionTable)
            .set({ revisionState: "published", publishedAt })
            .where(
              and(
                eq(agentRevisionTable.id, revisionId),
                eq(agentRevisionTable.revisionState, "draft"),
              ),
            );
          return result[0].affectedRows === 1;
        },
        async setAgentCurrentRevision(params) {
          const result = await tx
            .update(agentTable)
            .set({
              currentRevisionId: params.revisionId,
              versionNo: params.expectedVersionNo + 1,
              updatedAt: params.updatedAt,
            })
            .where(
              and(
                eq(agentTable.tenantId, params.tenantId),
                eq(agentTable.id, params.agentId),
                eq(agentTable.versionNo, params.expectedVersionNo),
              ),
            );
          return result[0].affectedRows === 1;
        },
        async appendAudit(params) {
          await tx.insert(auditEvent).values({
            id: params.id,
            tenantId: params.tenantId,
            actorType: params.actorType,
            actorId: params.actorId,
            actionType: "agent.publish",
            targetType: "agent_revision",
            targetId: params.revisionId,
            beforeHash: null,
            afterHash: computeContentHash(params.after),
            reason: params.reason,
            requestId: params.requestId,
            occurredAt: params.occurredAt,
          });
        },
        async appendOutbox(params) {
          const resolved = resolveOutboxAppend(params);
          await tx.insert(controlPlaneOutboxEvent).values({
            id: resolved.id,
            tenantId: resolved.tenantId,
            schemaVersion: "1.0",
            eventKey: resolved.eventKey,
            eventType: resolved.eventType,
            aggregateType: resolved.aggregateType,
            aggregateId: resolved.aggregateId,
            aggregateVersion: resolved.aggregateVersion,
            payloadJson: resolved.payloadJson,
            occurredAt: resolved.occurredAt,
          });
        },
        async completeIdempotency(params) {
          const result = await tx
            .update(idempotencyRecord)
            .set({
              processingState: "completed",
              httpStatus: params.httpStatus,
              responseRef: params.responseRef,
              responseRedactedJson: params.responseRedactedJson,
              completedAt: params.completedAt,
            })
            .where(
              and(
                eq(idempotencyRecord.id, params.recordId),
                eq(idempotencyRecord.processingState, "processing"),
              ),
            );
          return result[0].affectedRows === 1;
        },
      }),
    ),
};
