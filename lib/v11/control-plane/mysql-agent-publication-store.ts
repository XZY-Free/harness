import type { AgentPublicationStore } from "@/lib/agents/persistence/agent-publication-store";
import { controlPlaneOutboxEvent } from "@/lib/agents/persistence/control-plane-outbox";
import {
  artifact,
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import { computeContentHash } from "@/lib/v11/identity/audit";
import { v11Agent, v11AgentRevision } from "@/lib/v11/schema/agent";
import { auditEvent } from "@/lib/v11/schema/audit";
import { idempotencyRecord } from "@/lib/v11/schema/idempotency";
import { and, eq, isNull } from "drizzle-orm";

export const mysqlAgentPublicationStore: AgentPublicationStore = {
  transaction: (operation) =>
    db.transaction(async (tx) =>
      operation({
        async findRevision(tenantId, revisionId) {
          const [row] = await tx
            .select({ revision: v11AgentRevision })
            .from(v11AgentRevision)
            .innerJoin(
              v11Agent,
              and(eq(v11Agent.id, v11AgentRevision.agentId), eq(v11Agent.tenantId, tenantId)),
            )
            .where(eq(v11AgentRevision.id, revisionId))
            .limit(1)
            .for("update");
          return row?.revision ?? null;
        },
        async findAgent(tenantId, agentId) {
          const [agent] = await tx
            .select()
            .from(v11Agent)
            .where(and(eq(v11Agent.tenantId, tenantId), eq(v11Agent.id, agentId)))
            .limit(1);
          return agent ?? null;
        },
        async findVerifiedAttestation(params) {
          const [attestation] = await tx
            .select({ attestation: artifactAttestation })
            .from(artifactAttestation)
            .innerJoin(artifact, eq(artifact.id, artifactAttestation.artifactId))
            .innerJoin(v11AgentRevision, eq(v11AgentRevision.id, params.revisionId))
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
                eq(v11AgentRevision.artifactId, artifact.id),
                eq(v11AgentRevision.artifactDigest, artifact.digest),
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
            .update(v11AgentRevision)
            .set({ revisionState: "published", publishedAt })
            .where(
              and(eq(v11AgentRevision.id, revisionId), eq(v11AgentRevision.revisionState, "draft")),
            );
          return result[0].affectedRows === 1;
        },
        async setAgentCurrentRevision(params) {
          const result = await tx
            .update(v11Agent)
            .set({
              currentRevisionId: params.revisionId,
              versionNo: params.expectedVersionNo + 1,
              updatedAt: params.updatedAt,
            })
            .where(
              and(
                eq(v11Agent.tenantId, params.tenantId),
                eq(v11Agent.id, params.agentId),
                eq(v11Agent.versionNo, params.expectedVersionNo),
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
          await tx.insert(controlPlaneOutboxEvent).values({
            id: params.id,
            tenantId: params.tenantId,
            eventKey: params.eventKey,
            eventType: params.eventType,
            aggregateType: params.aggregateType,
            aggregateId: params.aggregateId,
            payloadJson: params.payload,
            occurredAt: params.occurredAt,
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
