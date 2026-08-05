import { randomUUID } from "node:crypto";
import {
  RuntimeConformanceBindingError,
  type RuntimeConformanceReport,
  validateRuntimeConformanceReport,
  verifyRuntimeConformanceReportSignature,
} from "@/lib/runtimes/domain/runtime-conformance-run";
import type {
  RuntimeConformanceCaseResultRecord,
  RuntimeConformanceRunRecord,
} from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import type { RuntimeConformanceRunStore } from "@/lib/runtimes/persistence/runtime-conformance-run-store";

export interface RecordRuntimeConformanceRunCommand {
  tenantId: string;
  runtimeRevisionId: string;
  report: RuntimeConformanceReport;
  signature: string;
  idempotencyKey: string;
  requestId: string;
  actor: { actorType: "user" | "service" | "workload" | "system"; actorId: string };
  idempotency?: {
    recordId: string;
    httpStatus: number;
    responseRef?: string | null;
    serializeResponse: (result: {
      run: RuntimeConformanceRunRecord;
      caseResults: RuntimeConformanceCaseResultRecord[];
      replayed: false;
    }) => string;
  };
}

export function createRecordRuntimeConformanceRun(dependencies: {
  store: RuntimeConformanceRunStore;
  signingSecret: () => string;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;
  return async (command: RecordRuntimeConformanceRunCommand) => {
    if (command.report.runtimeRevisionId !== command.runtimeRevisionId) {
      throw new RuntimeConformanceBindingError("Runner 报告 Revision 与命令不一致");
    }
    verifyRuntimeConformanceReportSignature(
      command.report,
      command.signature,
      dependencies.signingSecret(),
    );
    validateRuntimeConformanceReport(command.report);

    const existing = await dependencies.store.findByIdempotency(command);
    if (existing) {
      if (existing.run.id !== command.report.runId) {
        throw new RuntimeConformanceBindingError("Idempotency-Key 已绑定其他 Conformance Run");
      }
      return { ...existing, replayed: true };
    }

    try {
      return await dependencies.store.transaction(async (session) => {
        const revision = await session.findRevision(command.tenantId, command.runtimeRevisionId);
        if (!revision) throw new RuntimeConformanceBindingError("RuntimeRevision 不存在或跨租户");
        if (revision.revisionState !== "draft") {
          throw new RuntimeConformanceBindingError(
            "只有 draft RuntimeRevision 可创建 Conformance Run",
          );
        }
        if (
          revision.artifactDigest !== command.report.runtimeArtifactDigest ||
          revision.configHash !== command.report.runtimeConfigDigest ||
          revision.protocolContractRevision !== command.report.protocolContractRevision
        ) {
          throw new RuntimeConformanceBindingError(
            "Runner 报告绑定与 RuntimeRevision 当前事实不一致",
          );
        }
        const recordedAt = now();
        const run = await session.appendRun({
          tenantId: command.tenantId,
          report: command.report,
          runnerSignature: command.signature,
          idempotencyKey: command.idempotencyKey,
          requestId: command.requestId,
          recordedAt,
        });
        const caseResults = await session.appendCaseResults(command.report);
        await session.appendAudit({
          id: newId(),
          tenantId: command.tenantId,
          actorType: command.actor.actorType,
          actorId: command.actor.actorId,
          runId: run.id,
          requestId: command.requestId,
          after: {
            runtime_revision_id: command.runtimeRevisionId,
            overall_result: run.overallResult,
            evidence_manifest_digest: run.evidenceManifestDigest,
          },
          occurredAt: recordedAt,
        });
        await session.appendOutbox({
          id: newId(),
          tenantId: command.tenantId,
          eventType: "runtime.conformance.recorded",
          aggregateId: run.id,
          aggregateVersion: 0,
          payload: {
            run_id: run.id,
            runtime_revision_id: command.runtimeRevisionId,
            overall_result: run.overallResult as "passed" | "failed",
          },
          occurredAt: recordedAt,
        });
        const result = { run, caseResults, replayed: false as const };
        if (command.idempotency) {
          const completed = await session.completeIdempotency({
            recordId: command.idempotency.recordId,
            httpStatus: command.idempotency.httpStatus,
            responseRef: command.idempotency.responseRef ?? null,
            responseRedactedJson: command.idempotency.serializeResponse(result),
            completedAt: recordedAt,
          });
          if (!completed) throw new Error("RuntimeConformanceRun 幂等记录无法完成");
        }
        return result;
      });
    } catch (error) {
      // 两个相同命令并发越过预读时，数据库唯一约束选出权威 Run；输家重读返回同一事实。
      const winner = await dependencies.store.findByIdempotency(command);
      if (winner?.run.id === command.report.runId) return { ...winner, replayed: true };
      throw error;
    }
  };
}
