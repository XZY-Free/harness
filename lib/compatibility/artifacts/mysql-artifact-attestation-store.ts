import { controlPlaneOutboxEvent } from "@/lib/agents/persistence/control-plane-outbox";
import type {
  ArtifactAttestationPersistenceStore,
  RevisionArtifactBinding,
} from "@/lib/artifacts/application/record-artifact-attestation";
import type { AttestationRevocationStore } from "@/lib/artifacts/application/revoke-artifact-attestation";
import {
  artifact,
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
import { v11Agent, v11AgentRevision } from "@/lib/v11/schema/agent";
import { auditEvent } from "@/lib/v11/schema/audit";
import { idempotencyRecord } from "@/lib/v11/schema/idempotency";
import { v11Runtime, v11RuntimeRevision } from "@/lib/v11/schema/runtime";
import { and, eq, isNull, or } from "drizzle-orm";

export const mysqlArtifactAttestationPersistenceStore: ArtifactAttestationPersistenceStore = {
  transaction: (operation) =>
    db.transaction(async (tx) =>
      operation({
        async findArtifact(tenantId, digest) {
          const [row] = await tx
            .select()
            .from(artifact)
            .where(and(eq(artifact.tenantId, tenantId), eq(artifact.digest, digest)))
            .limit(1);
          return row ?? null;
        },
        async insertArtifact(params) {
          try {
            await tx.insert(artifact).values({
              ...params,
            });
          } catch (error) {
            if (!isDuplicateEntryError(error)) throw error;
          }
          const [row] = await tx
            .select()
            .from(artifact)
            .where(and(eq(artifact.tenantId, params.tenantId), eq(artifact.digest, params.digest)))
            .limit(1)
            .for("update");
          if (!row) throw new Error(`Artifact 创建后不可见: ${params.digest}`);
          return row;
        },
        async appendAttestation(params) {
          await tx.insert(artifactAttestation).values(params);
          const [row] = await tx
            .select()
            .from(artifactAttestation)
            .where(eq(artifactAttestation.id, params.id as string))
            .limit(1);
          if (!row) throw new Error(`ArtifactAttestation 创建后不可见: ${params.id as string}`);
          return row;
        },
        async findRevisionArtifactBinding(params) {
          if (params.artifactType === "agent_revision") {
            const [row] = await tx
              .select({ revision: v11AgentRevision })
              .from(v11AgentRevision)
              .innerJoin(
                v11Agent,
                and(
                  eq(v11Agent.id, v11AgentRevision.agentId),
                  eq(v11Agent.tenantId, params.tenantId),
                ),
              )
              .where(eq(v11AgentRevision.id, params.revisionId))
              .limit(1)
              .for("update");
            return row
              ? {
                  revisionState: row.revision.revisionState,
                  artifactRef: row.revision.agentArtifactRef,
                  artifactId: row.revision.artifactId,
                  artifactDigest: row.revision.artifactDigest,
                }
              : null;
          }
          if (params.artifactType === "runtime_revision") {
            const [row] = await tx
              .select({ revision: v11RuntimeRevision })
              .from(v11RuntimeRevision)
              .innerJoin(
                v11Runtime,
                and(
                  eq(v11Runtime.id, v11RuntimeRevision.runtimeId),
                  eq(v11Runtime.tenantId, params.tenantId),
                ),
              )
              .where(eq(v11RuntimeRevision.id, params.revisionId))
              .limit(1)
              .for("update");
            return row
              ? {
                  revisionState: row.revision.revisionState,
                  artifactRef: row.revision.runtimeArtifactRef,
                  artifactId: row.revision.artifactId,
                  artifactDigest: row.revision.artifactDigest,
                }
              : null;
          }
          return null;
        },
        async bindRevisionArtifact(params) {
          if (params.artifactType === "agent_revision") {
            const result = await tx
              .update(v11AgentRevision)
              .set({ artifactId: params.artifactId, artifactDigest: params.artifactDigest })
              .where(
                and(
                  eq(v11AgentRevision.id, params.revisionId),
                  eq(v11AgentRevision.revisionState, "draft"),
                  or(
                    isNull(v11AgentRevision.artifactId),
                    eq(v11AgentRevision.artifactId, params.artifactId),
                  ),
                  or(
                    isNull(v11AgentRevision.artifactDigest),
                    eq(v11AgentRevision.artifactDigest, params.artifactDigest),
                  ),
                ),
              );
            return result[0].affectedRows === 1;
          }
          if (params.artifactType === "runtime_revision") {
            const result = await tx
              .update(v11RuntimeRevision)
              .set({ artifactId: params.artifactId, artifactDigest: params.artifactDigest })
              .where(
                and(
                  eq(v11RuntimeRevision.id, params.revisionId),
                  eq(v11RuntimeRevision.revisionState, "draft"),
                  or(
                    isNull(v11RuntimeRevision.artifactId),
                    eq(v11RuntimeRevision.artifactId, params.artifactId),
                  ),
                  or(
                    isNull(v11RuntimeRevision.artifactDigest),
                    eq(v11RuntimeRevision.artifactDigest, params.artifactDigest),
                  ),
                ),
              );
            return result[0].affectedRows === 1;
          }
          return false;
        },
        async appendAudit(params) {
          await tx.insert(auditEvent).values({
            id: params.id,
            tenantId: params.tenantId,
            actorType: params.actorType,
            actorId: params.actorId,
            actionType: "artifact.attestation.verify",
            targetType: "artifact_attestation",
            targetId: params.attestationId,
            beforeHash: null,
            afterHash: params.afterHash,
            reason: params.reason,
            requestId: params.requestId,
            occurredAt: params.occurredAt,
          });
        },
        async appendOutbox(params) {
          await tx.insert(controlPlaneOutboxEvent).values({
            id: params.id,
            tenantId: params.tenantId,
            eventKey: `artifact-attestation-recorded:${params.attestationId}`,
            eventType: "artifact.attestation.recorded",
            aggregateType: "artifact_attestation",
            aggregateId: params.attestationId,
            payloadJson: {
              attestation_id: params.attestationId,
              artifact_id: params.artifactId,
              verification_state: params.verificationState,
            },
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

export const mysqlAttestationRevocationStore: AttestationRevocationStore = {
  transaction: (operation) =>
    db.transaction(async (tx) =>
      operation({
        async findForUpdate(tenantId, attestationId) {
          const [attestation] = await tx
            .select()
            .from(artifactAttestation)
            .where(
              and(
                eq(artifactAttestation.tenantId, tenantId),
                eq(artifactAttestation.id, attestationId),
              ),
            )
            .limit(1)
            .for("update");
          if (!attestation) return null;
          const [revocation] = await tx
            .select()
            .from(attestationRevocationRecord)
            .where(eq(attestationRevocationRecord.attestationId, attestationId))
            .limit(1);
          return { attestation, revocation: revocation ?? null };
        },
        async appendRevocation(params) {
          await tx.insert(attestationRevocationRecord).values(params);
          const [row] = await tx
            .select()
            .from(attestationRevocationRecord)
            .where(eq(attestationRevocationRecord.id, params.id))
            .limit(1);
          if (!row) throw new Error(`AttestationRevocationRecord 创建后不可见: ${params.id}`);
          return row;
        },
        async appendAudit(params) {
          await tx.insert(auditEvent).values({
            id: params.id,
            tenantId: params.tenantId,
            actorType: params.actorType,
            actorId: params.actorId,
            actionType: "artifact.attestation.revoke",
            targetType: "artifact_attestation",
            targetId: params.attestationId,
            beforeHash: params.beforeHash,
            afterHash: params.afterHash,
            reason: params.reason,
            requestId: params.requestId,
            occurredAt: params.occurredAt,
          });
        },
        async appendOutbox(params) {
          await tx.insert(controlPlaneOutboxEvent).values({
            id: params.id,
            tenantId: params.tenantId,
            eventKey: `artifact-attestation-revoked:${params.attestationId}`,
            eventType: "artifact.attestation.revoked",
            aggregateType: "artifact_attestation",
            aggregateId: params.attestationId,
            payloadJson: {
              attestation_id: params.attestationId,
              revoked_at: params.revokedAt.toISOString(),
              reason: params.reason,
            },
            occurredAt: params.revokedAt,
          });
        },
      }),
    ),
};

function isDuplicateEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ER_DUP_ENTRY"
  );
}

export type { RevisionArtifactBinding };
