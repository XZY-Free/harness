import { randomUUID } from "node:crypto";
import { controlPlaneOutboxEvent } from "@/lib/agents/persistence/control-plane-outbox";
import { db } from "@/lib/db/client";
import { computeContentHash } from "@/lib/identity/audit";
import { auditEvent } from "@/lib/persistence/schema/control-plane";
import { idempotencyRecord } from "@/lib/persistence/schema/control-plane";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/control-plane";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import type { RuntimeConformanceRunStore } from "@/lib/runtimes/persistence/runtime-conformance-run-store";
import { and, asc, eq } from "drizzle-orm";

async function findByIdempotency(params: {
  tenantId: string;
  runtimeRevisionId: string;
  idempotencyKey: string;
}) {
  const [run] = await db
    .select()
    .from(runtimeConformanceRun)
    .where(
      and(
        eq(runtimeConformanceRun.tenantId, params.tenantId),
        eq(runtimeConformanceRun.runtimeRevisionId, params.runtimeRevisionId),
        eq(runtimeConformanceRun.idempotencyKey, params.idempotencyKey),
      ),
    )
    .limit(1);
  if (!run) return null;
  const caseResults = await db
    .select()
    .from(runtimeConformanceCaseResult)
    .where(eq(runtimeConformanceCaseResult.runId, run.id))
    .orderBy(asc(runtimeConformanceCaseResult.caseId));
  return { run, caseResults };
}

export const mysqlRuntimeConformanceRunStore: RuntimeConformanceRunStore = {
  findByIdempotency,
  transaction: (operation) =>
    db.transaction(async (tx) =>
      operation({
        async findRevision(tenantId, runtimeRevisionId) {
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
            .where(eq(runtimeRevisionTable.id, runtimeRevisionId))
            .limit(1)
            .for("update");
          return row?.revision ?? null;
        },
        async appendRun(params) {
          const { report } = params;
          await tx.insert(runtimeConformanceRun).values({
            id: report.runId,
            tenantId: params.tenantId,
            runtimeRevisionId: report.runtimeRevisionId,
            runtimeArtifactDigest: report.runtimeArtifactDigest,
            runtimeConfigDigest: report.runtimeConfigDigest,
            protocolContractRevision: report.protocolContractRevision,
            suiteRevision: report.suiteRevision,
            runnerArtifactDigest: report.runnerArtifactDigest,
            runnerIdentity: report.runnerIdentity,
            testEnvironmentRevision: report.testEnvironmentRevision,
            startedAt: new Date(report.startedAt),
            completedAt: new Date(report.completedAt),
            overallResult: report.overallResult,
            evidenceManifestDigest: report.evidenceManifestDigest,
            runnerSignature: params.runnerSignature,
            idempotencyKey: params.idempotencyKey,
            requestId: params.requestId,
            recordedAt: params.recordedAt,
          });
          const [run] = await tx
            .select()
            .from(runtimeConformanceRun)
            .where(eq(runtimeConformanceRun.id, report.runId))
            .limit(1);
          if (!run) throw new Error("RuntimeConformanceRun 写入失败");
          return run;
        },
        async appendCaseResults(report) {
          await tx.insert(runtimeConformanceCaseResult).values(
            report.caseResults.map((result) => ({
              id: randomUUID(),
              runId: report.runId,
              caseId: result.caseId,
              passed: result.passed,
              reason: result.reason,
              evidenceDigest: result.evidenceDigest,
            })),
          );
          return tx
            .select()
            .from(runtimeConformanceCaseResult)
            .where(eq(runtimeConformanceCaseResult.runId, report.runId))
            .orderBy(asc(runtimeConformanceCaseResult.caseId));
        },
        async appendAudit(params) {
          await tx.insert(auditEvent).values({
            id: params.id,
            tenantId: params.tenantId,
            actorType: params.actorType,
            actorId: params.actorId,
            actionType: "runtime.conformance.run.record",
            targetType: "runtime_conformance_run",
            targetId: params.runId,
            beforeHash: null,
            afterHash: computeContentHash(params.after),
            reason: "记录可信 Runtime Conformance Run",
            requestId: params.requestId,
            occurredAt: params.occurredAt,
          });
        },
        async appendOutbox(params) {
          await tx.insert(controlPlaneOutboxEvent).values({
            id: params.id,
            tenantId: params.tenantId,
            eventKey: `runtime-conformance-run-completed:${params.runId}`,
            eventType: "runtime.conformance.run.completed",
            aggregateType: "runtime_conformance_run",
            aggregateId: params.runId,
            payloadJson: {
              run_id: params.runId,
              runtime_revision_id: params.runtimeRevisionId,
              overall_result: params.overallResult,
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
