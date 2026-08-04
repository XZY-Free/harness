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
import {
  ALL_CONFORMANCE_CASES,
  type ConformanceCaseId,
} from "@/lib/runtimes/domain/runtime-conformance-contract";
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
            .select({
              revision: runtimeRevisionTable,
              tenantId: runtimeTable.tenantId,
            })
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
          if (!row) return null;
          return { ...row.revision, tenantId: row.tenantId };
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
        /**
         * FOR UPDATE 读取 Attestation 证据快照。
         *
         * 返回完整 EvidenceSnapshot（含 artifactType、artifactRevisionId、
         * verificationState、revokedAt、revocationRecordId），
         * 由 ArtifactEvidencePolicy 统一验证发布资格。
         */
        async findVerifiedAttestation(params) {
          const [row] = await tx
            .select({
              attestation: artifactAttestation,
              artifact: artifact,
              revocation: attestationRevocationRecord,
            })
            .from(artifactAttestation)
            .innerJoin(artifact, eq(artifact.id, artifactAttestation.artifactId))
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
                isNull(artifactAttestation.revokedAt),
                isNull(attestationRevocationRecord.id),
              ),
            )
            .limit(1)
            .for("update");
          if (!row || !row.attestation.artifactId) return null;
          return {
            id: row.attestation.id,
            tenantId: row.attestation.tenantId,
            artifactType: row.attestation.artifactType,
            artifactRevisionId: row.attestation.artifactRevisionId,
            artifactId: row.attestation.artifactId,
            artifactDigest: row.attestation.artifactDigest,
            verificationState: row.attestation.verificationState,
            revokedAt: row.attestation.revokedAt,
            revocationRecordId: row.revocation?.id ?? null,
          };
        },
        /**
         * FOR UPDATE 读取 Passed ConformanceRun 完整结果。
         *
         * 返回包含绑定校验字段（runtimeArtifactDigest、runtimeConfigDigest、
         * protocolContractRevision）的完整 Run，由应用服务校验与 Revision 一致。
         * Case 完整性由 validateCompleteConformanceResult 统一判断。
         */
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
          const rows = await tx
            .select()
            .from(runtimeConformanceCaseResult)
            .where(eq(runtimeConformanceCaseResult.runId, run.id))
            .orderBy(asc(runtimeConformanceCaseResult.caseId));
          return {
            id: run.id,
            runtimeArtifactDigest: run.runtimeArtifactDigest,
            runtimeConfigDigest: run.runtimeConfigDigest,
            protocolContractRevision: run.protocolContractRevision,
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
