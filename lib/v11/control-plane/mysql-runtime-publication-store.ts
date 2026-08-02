import { randomUUID } from "node:crypto";
import { controlPlaneOutboxEvent } from "@/lib/agents/persistence/control-plane-outbox";
import {
  artifact,
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import type { ConformanceCaseId } from "@/lib/runtimes/domain/runtime-revision-publication-policy";
import type { RuntimePublicationStore } from "@/lib/runtimes/persistence/runtime-publication-store";
import { computeContentHash } from "@/lib/v11/identity/audit";
import { auditEvent } from "@/lib/v11/schema/audit";
import { idempotencyRecord } from "@/lib/v11/schema/idempotency";
import {
  v11Runtime,
  v11RuntimeConformanceResult,
  v11RuntimeRevision,
} from "@/lib/v11/schema/runtime";
import { and, asc, eq, isNull } from "drizzle-orm";

export const mysqlRuntimePublicationStore: RuntimePublicationStore = {
  transaction: (operation) =>
    db.transaction(async (tx) =>
      operation({
        async findRevision(tenantId, revisionId) {
          const [row] = await tx
            .select({ revision: v11RuntimeRevision })
            .from(v11RuntimeRevision)
            .innerJoin(
              v11Runtime,
              and(
                eq(v11Runtime.id, v11RuntimeRevision.runtimeId),
                eq(v11Runtime.tenantId, tenantId),
              ),
            )
            .where(eq(v11RuntimeRevision.id, revisionId))
            .limit(1)
            .for("update");
          return row?.revision ?? null;
        },
        async findRuntime(tenantId, runtimeId) {
          const [runtime] = await tx
            .select()
            .from(v11Runtime)
            .where(and(eq(v11Runtime.tenantId, tenantId), eq(v11Runtime.id, runtimeId)))
            .limit(1)
            .for("update");
          return runtime ?? null;
        },
        async findVerifiedAttestation(params) {
          const [attestation] = await tx
            .select({ attestation: artifactAttestation })
            .from(artifactAttestation)
            .innerJoin(artifact, eq(artifact.id, artifactAttestation.artifactId))
            .innerJoin(v11RuntimeRevision, eq(v11RuntimeRevision.id, params.revisionId))
            .leftJoin(
              attestationRevocationRecord,
              eq(attestationRevocationRecord.attestationId, artifactAttestation.id),
            )
            .where(
              and(
                eq(artifactAttestation.id, params.attestationId),
                eq(artifactAttestation.tenantId, params.tenantId),
                eq(artifactAttestation.artifactType, "runtime_revision"),
                eq(artifactAttestation.artifactRevisionId, params.revisionId),
                eq(artifactAttestation.verificationState, "verified"),
                eq(artifact.tenantId, params.tenantId),
                eq(artifact.digest, artifactAttestation.artifactDigest),
                eq(v11RuntimeRevision.artifactId, artifact.id),
                eq(v11RuntimeRevision.artifactDigest, artifact.digest),
                isNull(attestationRevocationRecord.id),
                isNull(artifactAttestation.revokedAt),
              ),
            )
            .limit(1)
            .for("update");
          return attestation?.attestation ?? null;
        },
        async persistConformanceResults(params) {
          for (const result of params.results) {
            await tx
              .insert(v11RuntimeConformanceResult)
              .values({
                id: randomUUID(),
                runtimeRevisionId: params.revisionId,
                tenantId: params.tenantId,
                caseId: result.caseId,
                passed: result.passed,
                reason: result.reason ?? null,
                adapterDigest: params.options.adapterDigest,
                testEnvironment: params.options.testEnvironment,
                evidenceRef: params.options.evidenceRef,
                testedAt: params.testedAt,
              })
              .onDuplicateKeyUpdate({
                set: {
                  passed: result.passed,
                  reason: result.reason ?? null,
                  adapterDigest: params.options.adapterDigest,
                  testEnvironment: params.options.testEnvironment,
                  evidenceRef: params.options.evidenceRef,
                  testedAt: params.testedAt,
                  updatedAt: params.testedAt,
                },
              });
          }

          const rows = await tx
            .select()
            .from(v11RuntimeConformanceResult)
            .where(eq(v11RuntimeConformanceResult.runtimeRevisionId, params.revisionId))
            .orderBy(asc(v11RuntimeConformanceResult.caseId));
          return rows.map((row) => ({
            caseId: row.caseId as ConformanceCaseId,
            passed: row.passed,
            reason: row.reason,
            adapterDigest: row.adapterDigest,
            testEnvironment: row.testEnvironment,
            evidenceRef: row.evidenceRef,
            testedAt: row.testedAt,
          }));
        },
        async appendPublication(params) {
          await tx.insert(publicationRecord).values({
            id: params.id,
            tenantId: params.tenantId,
            subjectType: "runtime_revision",
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
            .update(v11RuntimeRevision)
            .set({ revisionState: "published", publishedAt })
            .where(
              and(
                eq(v11RuntimeRevision.id, revisionId),
                eq(v11RuntimeRevision.revisionState, "draft"),
              ),
            );
          return result[0].affectedRows === 1;
        },
        async setRuntimeCurrentRevision(params) {
          const result = await tx
            .update(v11Runtime)
            .set({
              currentRevisionId: params.revisionId,
              versionNo: params.expectedVersionNo + 1,
              updatedAt: params.updatedAt,
            })
            .where(
              and(
                eq(v11Runtime.tenantId, params.tenantId),
                eq(v11Runtime.id, params.runtimeId),
                eq(v11Runtime.versionNo, params.expectedVersionNo),
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
            actionType: "runtime.publish",
            targetType: "runtime_revision",
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
