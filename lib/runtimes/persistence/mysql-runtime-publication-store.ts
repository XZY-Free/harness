import { controlPlaneOutboxEvent } from "@/lib/agents/persistence/control-plane-outbox";
import {
  artifact,
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
import { computeContentHash } from "@/lib/identity/audit";
import { auditEvent } from "@/lib/persistence/schema/control-plane";
import { idempotencyRecord } from "@/lib/persistence/schema/control-plane";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/control-plane";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import type { ConformanceCaseId } from "@/lib/runtimes/domain/runtime-revision-publication-policy";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import type { RuntimePublicationStore } from "@/lib/runtimes/persistence/runtime-publication-store";
import { and, asc, eq, isNull } from "drizzle-orm";

export const mysqlRuntimePublicationStore: RuntimePublicationStore = {
  transaction: (operation) =>
    db.transaction(async (tx) =>
      operation({
        async findRevision(tenantId, revisionId) {
          const [row] = await tx
            .select({ revision: runtimeRevisionTable })
            .from(runtimeRevisionTable)
            .innerJoin(
              runtimeTable,
              and(
                eq(runtimeTable.id, runtimeRevisionTable.runtimeId),
                eq(runtimeTable.tenantId, tenantId),
              ),
            )
            .where(eq(runtimeRevisionTable.id, revisionId))
            .limit(1)
            .for("update");
          return row?.revision ?? null;
        },
        async findRuntime(tenantId, runtimeId) {
          const [runtime] = await tx
            .select()
            .from(runtimeTable)
            .where(and(eq(runtimeTable.tenantId, tenantId), eq(runtimeTable.id, runtimeId)))
            .limit(1)
            .for("update");
          return runtime ?? null;
        },
        async findVerifiedAttestation(params) {
          const [attestation] = await tx
            .select({ attestation: artifactAttestation })
            .from(artifactAttestation)
            .innerJoin(artifact, eq(artifact.id, artifactAttestation.artifactId))
            .innerJoin(runtimeRevisionTable, eq(runtimeRevisionTable.id, params.revisionId))
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
                eq(runtimeRevisionTable.artifactId, artifact.id),
                eq(runtimeRevisionTable.artifactDigest, artifact.digest),
                isNull(attestationRevocationRecord.id),
                isNull(artifactAttestation.revokedAt),
              ),
            )
            .limit(1)
            .for("update");
          return attestation?.attestation ?? null;
        },
        async findPassedConformanceRun(params) {
          const [run] = await tx
            .select()
            .from(runtimeConformanceRun)
            .where(
              and(
                eq(runtimeConformanceRun.id, params.conformanceRunId),
                eq(runtimeConformanceRun.tenantId, params.tenantId),
                eq(runtimeConformanceRun.runtimeRevisionId, params.revisionId),
                eq(runtimeConformanceRun.overallResult, "passed"),
              ),
            )
            .limit(1)
            .for("update");
          if (!run) return null;
          const [revision] = await tx
            .select()
            .from(runtimeRevisionTable)
            .where(eq(runtimeRevisionTable.id, params.revisionId))
            .limit(1);
          if (
            !revision ||
            revision.artifactDigest !== run.runtimeArtifactDigest ||
            revision.configHash !== run.runtimeConfigDigest ||
            revision.protocolContractRevision !== run.protocolContractRevision
          ) {
            return null;
          }
          const rows = await tx
            .select()
            .from(runtimeConformanceCaseResult)
            .where(eq(runtimeConformanceCaseResult.runId, run.id))
            .orderBy(asc(runtimeConformanceCaseResult.caseId));
          if (rows.length !== 16 || rows.some((row) => !row.passed)) return null;
          return {
            id: run.id,
            evidenceManifestDigest: run.evidenceManifestDigest,
            results: rows.map((row) => ({
              caseId: row.caseId as ConformanceCaseId,
              passed: row.passed,
              reason: row.reason,
              adapterDigest: run.runnerArtifactDigest,
              testEnvironment: run.testEnvironmentRevision,
              evidenceRef: row.evidenceDigest,
              testedAt: run.completedAt,
            })),
          };
        },
        async persistConformanceResults() {
          throw new Error(
            "旧式可覆盖 ConformanceResult 写入已停用；必须记录不可变 Conformance Run",
          );
        },
        async appendPublication(params) {
          await tx.insert(publicationRecord).values({
            id: params.id,
            tenantId: params.tenantId,
            subjectType: "runtime_revision",
            subjectRevisionId: params.revisionId,
            evidenceSetDigest: params.evidenceSetDigest,
            attestationIds: params.attestationIds,
            conformanceRunId: params.conformanceRunId,
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
            .update(runtimeRevisionTable)
            .set({ revisionState: "published", publishedAt })
            .where(
              and(
                eq(runtimeRevisionTable.id, revisionId),
                eq(runtimeRevisionTable.revisionState, "draft"),
              ),
            );
          return result[0].affectedRows === 1;
        },
        async setRuntimeCurrentRevision(params) {
          const result = await tx
            .update(runtimeTable)
            .set({
              currentRevisionId: params.revisionId,
              versionNo: params.expectedVersionNo + 1,
              updatedAt: params.updatedAt,
            })
            .where(
              and(
                eq(runtimeTable.tenantId, params.tenantId),
                eq(runtimeTable.id, params.runtimeId),
                eq(runtimeTable.versionNo, params.expectedVersionNo),
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
