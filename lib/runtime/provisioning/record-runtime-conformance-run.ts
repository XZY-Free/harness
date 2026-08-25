import { createHash, randomUUID } from "node:crypto";
import type { RuntimeConformanceVerifier } from "@/lib/runtime/conformance/runtime-conformance-verifier";
import {
  RuntimeConformanceBindingError,
  type RuntimeConformanceReport,
  validateRuntimeConformanceReport,
} from "@/lib/runtime/domain/runtime-conformance-run";
import type {
  RuntimeConformanceCaseResultRecord,
  RuntimeConformanceRunRecord,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import type { RuntimeConformanceRunStore } from "@/lib/runtime/persistence/runtime-conformance-run-store";

export interface RecordRuntimeConformanceRunCommand {
  tenantId: string;
  runtimeRevisionId: string;
  /** 原始 DSSE Envelope JSON 字符串。 */
  dsseEnvelope: string;
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

export class RuntimeConformanceIdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConformanceIdempotencyConflictError";
  }
}

export function createRecordRuntimeConformanceRun(dependencies: {
  store: RuntimeConformanceRunStore;
  /**
   * : Conformance 验证器 — 替代 signingSecret。
   * 使用 DSSE Verifier 验证 Ed25519 签名的 Envelope。
   */
  verifier: RuntimeConformanceVerifier;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;
  return async (command: RecordRuntimeConformanceRunCommand) => {
    const envelopeBytes = Buffer.from(command.dsseEnvelope, "utf-8");
    const envelopeDigest = `sha256:${createHash("sha256").update(envelopeBytes).digest("hex")}`;

    // 步骤 2-4: 幂等检查 — 比较 envelopeDigest
    const existing = await dependencies.store.findByIdempotency({
      tenantId: command.tenantId,
      runtimeRevisionId: command.runtimeRevisionId,
      idempotencyKey: command.idempotencyKey,
    });
    if (existing) {
      if (existing.run.envelopeDigest !== envelopeDigest) {
        throw new RuntimeConformanceIdempotencyConflictError(
          "Idempotency-Key 已绑定不同的 DSSE Envelope",
        );
      }
      return { ...existing, replayed: true };
    }

    // 步骤 5-6: 验证 Envelope（绑定校验由事务内 findRevision 后执行）
    const verifyResult = await dependencies.verifier.verify({
      dsseEnvelopeBytes: envelopeBytes,
      expectedRuntimeRevisionId: command.runtimeRevisionId,
      tenantId: command.tenantId,
    });
    if (!verifyResult.verified) {
      throw new RuntimeConformanceBindingError(
        `Conformance 验证失败: ${verifyResult.failureReason ?? "unknown"}`,
      );
    }

    const claims = verifyResult.claims;
    const report = claims.report;

    // 步骤 11: 校验 Report 完整性
    validateRuntimeConformanceReport(report);

    try {
      return await dependencies.store.transaction(async (session) => {
        // 步骤 8-9: 锁 Revision + 校验仍为 draft
        const revision = await session.findRevision(command.tenantId, command.runtimeRevisionId);
        if (!revision) throw new RuntimeConformanceBindingError("RuntimeRevision 不存在或跨租户");
        if (revision.revisionState !== "draft") {
          throw new RuntimeConformanceBindingError(
            "只有 draft RuntimeRevision 可创建 Conformance Run",
          );
        }
        // 步骤 10: 校验 Verified Claims 与 Revision 一致
        if (
          revision.runtimeTargetDigest !== report.runtimeTargetDigest ||
          revision.configHash !== report.runtimeConfigDigest ||
          revision.protocolContractRevision !== report.protocolContractRevision
        ) {
          throw new RuntimeConformanceBindingError(
            "Runner 报告绑定与 RuntimeRevision 当前事实不一致",
          );
        }
        const recordedAt = now();
        const verifiedAt = now();
        const run = await session.appendRun({
          tenantId: command.tenantId,
          report,
          verification: {
            envelopeDigest,
            envelopeJson: command.dsseEnvelope,
            payloadDigest: claims.payloadDigest,
            signingKeyId: claims.signingKeyId,
            runnerIdentity: claims.runnerIdentity,
            verificationEngine: claims.verificationEngine,
            verificationEngineVersion: claims.verificationEngineVersion,
            predicateType: claims.predicateType,
            verifiedAt,
          },
          idempotencyKey: command.idempotencyKey,
          requestId: command.requestId,
          recordedAt,
        });
        const caseResults = await session.appendCaseResults(report);
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
            envelope_digest: run.envelopeDigest,
          },
          occurredAt: recordedAt,
        });
        await session.appendOutbox({
          id: newId(),
          tenantId: command.tenantId,
          eventKey: `runtime-conformance-recorded:${run.id}`,
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
      const winner = await dependencies.store.findByIdempotency({
        tenantId: command.tenantId,
        runtimeRevisionId: command.runtimeRevisionId,
        idempotencyKey: command.idempotencyKey,
      });
      if (winner && winner.run.envelopeDigest === envelopeDigest) {
        return { ...winner, replayed: true };
      }
      throw error;
    }
  };
}
