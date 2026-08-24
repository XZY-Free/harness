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
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import {
  type ControlPlaneOutboxAppendParams,
  resolveOutboxAppend,
} from "@/lib/control-plane/events/outbox-append";
import { seedEventDeliveries } from "@/lib/control-plane/events/seed-event-deliveries";
import { db } from "@/lib/db/client";
import { isMysqlDuplicateEntryError } from "@/lib/db/mysql-error";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/control-plane";
import { auditEvent } from "@/lib/persistence/schema/control-plane";
import { idempotencyRecord } from "@/lib/persistence/schema/control-plane";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/control-plane";
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
            if (!isMysqlDuplicateEntryError(error)) throw error;
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
              .select({ revision: agentRevisionTable })
              .from(agentRevisionTable)
              .innerJoin(
                agentTable,
                and(
                  eq(agentTable.id, agentRevisionTable.agentId),
                  eq(agentTable.tenantId, params.tenantId),
                ),
              )
              .where(eq(agentRevisionTable.id, params.revisionId))
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
              .select({ revision: runtimeRevisionTable })
              .from(runtimeRevisionTable)
              .innerJoin(
                runtimeTable,
                and(
                  eq(runtimeTable.id, runtimeRevisionTable.runtimeId),
                  eq(runtimeTable.tenantId, params.tenantId),
                ),
              )
              .where(eq(runtimeRevisionTable.id, params.revisionId))
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
              .update(agentRevisionTable)
              .set({ artifactId: params.artifactId, artifactDigest: params.artifactDigest })
              .where(
                and(
                  eq(agentRevisionTable.id, params.revisionId),
                  eq(agentRevisionTable.revisionState, "draft"),
                  or(
                    isNull(agentRevisionTable.artifactId),
                    eq(agentRevisionTable.artifactId, params.artifactId),
                  ),
                  or(
                    isNull(agentRevisionTable.artifactDigest),
                    eq(agentRevisionTable.artifactDigest, params.artifactDigest),
                  ),
                ),
              );
            return result[0].affectedRows === 1;
          }
          if (params.artifactType === "runtime_revision") {
            const result = await tx
              .update(runtimeRevisionTable)
              .set({ artifactId: params.artifactId, artifactDigest: params.artifactDigest })
              .where(
                and(
                  eq(runtimeRevisionTable.id, params.revisionId),
                  eq(runtimeRevisionTable.revisionState, "draft"),
                  or(
                    isNull(runtimeRevisionTable.artifactId),
                    eq(runtimeRevisionTable.artifactId, params.artifactId),
                  ),
                  or(
                    isNull(runtimeRevisionTable.artifactDigest),
                    eq(runtimeRevisionTable.artifactDigest, params.artifactDigest),
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
        async appendOutbox(params: ControlPlaneOutboxAppendParams) {
          const resolved = resolveOutboxAppend(params);
          await tx.insert(controlPlaneOutboxEvent).values({
            id: resolved.id,
            tenantId: resolved.tenantId,
            schemaVersion: "1.0",
            eventKey: `artifact-attestation-recorded:${resolved.aggregateId}`,
            eventType: resolved.eventType,
            aggregateType: resolved.aggregateType,
            aggregateId: resolved.aggregateId,
            aggregateVersion: resolved.aggregateVersion,
            payloadJson: resolved.payloadJson,
            occurredAt: params.occurredAt,
          });
          // §14: 同事务创建 Delivery 行，确保 Relay Worker 能领取
          await seedEventDeliveries(tx, resolved.id, resolved.eventType, resolved.occurredAt);
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
        async appendOutbox(params: ControlPlaneOutboxAppendParams) {
          const resolved = resolveOutboxAppend(params);
          await tx.insert(controlPlaneOutboxEvent).values({
            id: resolved.id,
            tenantId: resolved.tenantId,
            schemaVersion: "1.0",
            eventKey: `artifact-attestation-revoked:${resolved.aggregateId}`,
            eventType: resolved.eventType,
            aggregateType: resolved.aggregateType,
            aggregateId: resolved.aggregateId,
            aggregateVersion: resolved.aggregateVersion,
            payloadJson: resolved.payloadJson,
            occurredAt: resolved.occurredAt,
          });
          // §14: 同事务创建 Delivery 行，确保 Relay Worker 能领取
          await seedEventDeliveries(tx, resolved.id, resolved.eventType, resolved.occurredAt);
        },
      }),
    ),
};

export type { RevisionArtifactBinding };
