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
import type {
  RuntimeConformanceRunSession,
  RuntimeConformanceRunStore,
} from "@/lib/runtime/persistence/runtime-conformance-run-store";

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

/** prepare 产物内部数据 — 只存放在模块私有 WeakMap 中，调用方不可构造。 */
interface PreparedRuntimeConformanceRunData {
  tenantId: string;
  runtimeRevisionId: string;
  envelopeDigest: string;
  envelopeJson: string;
  idempotencyKey: string;
  requestId: string;
  actor: { actorType: "user" | "service" | "workload" | "system"; actorId: string };
  report: RuntimeConformanceReport;
  claims: {
    payloadDigest: string;
    signingKeyId: string;
    runnerIdentity: string;
    verificationEngine: string;
    verificationEngineVersion: string;
    predicateType: string;
  };
  /** 可选幂等描述符绑定：presence + recordId/httpStatus/responseRef/serializeResponse 身份。 */
  idempotency: {
    recordId: string;
    httpStatus: number;
    responseRef: string | null;
    serializeResponse: (result: {
      run: RuntimeConformanceRunRecord;
      caseResults: RuntimeConformanceCaseResultRecord[];
      replayed: false;
    }) => string;
  } | null;
}

/** 不透明 prepare 句柄：字段为空，真实数据经 WeakMap 绑定，防止调用方伪造/篡改。 */
export interface PreparedRuntimeConformanceRun {
  readonly PreparedRuntimeConformanceRun: unique symbol;
}

const preparedRuntimeConformanceRuns = new WeakMap<
  PreparedRuntimeConformanceRun,
  PreparedRuntimeConformanceRunData
>();

function computeEnvelopeDigest(dsseEnvelope: string) {
  const envelopeBytes = Buffer.from(dsseEnvelope, "utf-8");
  return `sha256:${createHash("sha256").update(envelopeBytes).digest("hex")}`;
}

/**
 * 验证 DSSE Envelope 并生成不可变 prepared 证据（无 DB 写入）。
 *
 * 与权威 recorder 使用同一 RuntimeConformanceVerifier 与报告校验；
 * 产物只能在 appendRuntimeConformanceRun 中按原命令绑定消费，不可改绑。
 */
export async function prepareRuntimeConformanceRun(dependencies: {
  verifier: RuntimeConformanceVerifier;
  command: RecordRuntimeConformanceRunCommand;
}): Promise<PreparedRuntimeConformanceRun> {
  const command = dependencies.command;
  const envelopeDigest = computeEnvelopeDigest(command.dsseEnvelope);

  // 步骤 5-6: 验证 Envelope（绑定校验由事务内 findRevision 后执行）
  const verifyResult = await dependencies.verifier.verify({
    dsseEnvelopeBytes: Buffer.from(command.dsseEnvelope, "utf-8"),
    expectedRuntimeRevisionId: command.runtimeRevisionId,
    tenantId: command.tenantId,
  });
  if (!verifyResult.verified) {
    throw new RuntimeConformanceBindingError(
      `Conformance 验证失败: ${verifyResult.failureReason ?? "unknown"}`,
    );
  }
  const claims = verifyResult.claims;

  // 步骤 11: 校验 Report 完整性
  validateRuntimeConformanceReport(claims.report);

  const handle = Object.freeze({}) as PreparedRuntimeConformanceRun;
  preparedRuntimeConformanceRuns.set(
    handle,
    Object.freeze({
      tenantId: command.tenantId,
      runtimeRevisionId: command.runtimeRevisionId,
      envelopeDigest,
      envelopeJson: command.dsseEnvelope,
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      actor: Object.freeze({ ...command.actor }),
      report: claims.report,
      claims: {
        payloadDigest: claims.payloadDigest,
        signingKeyId: claims.signingKeyId,
        runnerIdentity: claims.runnerIdentity,
        verificationEngine: claims.verificationEngine,
        verificationEngineVersion: claims.verificationEngineVersion,
        predicateType: claims.predicateType,
      },
      // prepare 阶段不调用 serializer，只冻结其函数身份与描述符字段。
      idempotency: command.idempotency
        ? Object.freeze({
            recordId: command.idempotency.recordId,
            httpStatus: command.idempotency.httpStatus,
            responseRef: command.idempotency.responseRef ?? null,
            serializeResponse: command.idempotency.serializeResponse,
          })
        : null,
    }),
  );
  return handle;
}

/** 读取并绑定校验 prepared 证据；伪造或改绑一律 RuntimeConformanceBindingError。 */
function resolvePrepared(
  prepared: PreparedRuntimeConformanceRun,
  command: RecordRuntimeConformanceRunCommand,
): PreparedRuntimeConformanceRunData {
  const data = preparedRuntimeConformanceRuns.get(prepared);
  if (!data) {
    throw new RuntimeConformanceBindingError(
      "prepared 证据无效：非 prepareRuntimeConformanceRun 产物",
    );
  }
  const commandDigest = computeEnvelopeDigest(command.dsseEnvelope);
  const actorMatches =
    data.actor.actorType === command.actor.actorType &&
    data.actor.actorId === command.actor.actorId;
  const commandIdempotency = command.idempotency ?? null;
  const idempotencyMatches =
    (data.idempotency === null) === (commandIdempotency === null) &&
    (data.idempotency === null ||
      (commandIdempotency !== null &&
        data.idempotency.recordId === commandIdempotency.recordId &&
        data.idempotency.httpStatus === commandIdempotency.httpStatus &&
        data.idempotency.responseRef === (commandIdempotency.responseRef ?? null) &&
        data.idempotency.serializeResponse === commandIdempotency.serializeResponse));
  if (
    data.tenantId !== command.tenantId ||
    data.runtimeRevisionId !== command.runtimeRevisionId ||
    data.envelopeDigest !== commandDigest ||
    data.idempotencyKey !== command.idempotencyKey ||
    data.requestId !== command.requestId ||
    !actorMatches ||
    !idempotencyMatches
  ) {
    throw new RuntimeConformanceBindingError("prepared 证据与命令绑定不一致，禁止改绑到其他命令");
  }
  return data;
}

/**
 * 经调用方事务 Session 追加 prepared Conformance Run。
 *
 * 执行与权威 recorder 完全相同的 Revision 租户/draft/绑定校验、
 * run/case/audit/outbox 写入与可选幂等完成；事务归属调用方。
 */
export async function appendRuntimeConformanceRun(dependencies: {
  session: RuntimeConformanceRunSession;
  prepared: PreparedRuntimeConformanceRun;
  command: RecordRuntimeConformanceRunCommand;
  now?: () => Date;
  newId?: () => string;
}) {
  const command = dependencies.command;
  const data = resolvePrepared(dependencies.prepared, command);
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;
  const session = dependencies.session;
  const report = data.report;

  // 步骤 8-9: 锁 Revision + 校验仍为 draft
  const revision = await session.findRevision(command.tenantId, command.runtimeRevisionId);
  if (!revision) throw new RuntimeConformanceBindingError("RuntimeRevision 不存在或跨租户");
  if (revision.revisionState !== "draft") {
    throw new RuntimeConformanceBindingError("只有 draft RuntimeRevision 可创建 Conformance Run");
  }
  // 步骤 10: 校验 Verified Claims 与 Revision 一致
  if (
    revision.runtimeTargetDigest !== report.runtimeTargetDigest ||
    revision.configHash !== report.runtimeConfigDigest ||
    revision.protocolContractRevision !== report.protocolContractRevision
  ) {
    throw new RuntimeConformanceBindingError("Runner 报告绑定与 RuntimeRevision 当前事实不一致");
  }
  const recordedAt = now();
  const verifiedAt = now();
  const run = await session.appendRun({
    tenantId: command.tenantId,
    report,
    verification: {
      envelopeDigest: data.envelopeDigest,
      envelopeJson: data.envelopeJson,
      payloadDigest: data.claims.payloadDigest,
      signingKeyId: data.claims.signingKeyId,
      runnerIdentity: data.claims.runnerIdentity,
      verificationEngine: data.claims.verificationEngine,
      verificationEngineVersion: data.claims.verificationEngineVersion,
      predicateType: data.claims.predicateType,
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
  if (data.idempotency) {
    const completed = await session.completeIdempotency({
      recordId: data.idempotency.recordId,
      httpStatus: data.idempotency.httpStatus,
      responseRef: data.idempotency.responseRef,
      responseRedactedJson: data.idempotency.serializeResponse(result),
      completedAt: recordedAt,
    });
    if (!completed) throw new Error("RuntimeConformanceRun 幂等记录无法完成");
  }
  return result;
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
    const envelopeDigest = computeEnvelopeDigest(command.dsseEnvelope);

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

    // 步骤 5-11: 验签 + 报告校验（与共享 prepare 一致，无 DB 写入）
    const prepared = await prepareRuntimeConformanceRun({
      verifier: dependencies.verifier,
      command,
    });

    try {
      return await dependencies.store.transaction((session) =>
        appendRuntimeConformanceRun({ session, prepared, command, now, newId }),
      );
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
