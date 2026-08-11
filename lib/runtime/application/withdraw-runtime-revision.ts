import { randomUUID } from "node:crypto";
import type { PublicationActorType } from "@/lib/publications/domain/publication-record";
import type {
  RuntimeWithdrawalRevision,
  RuntimeWithdrawalStore,
} from "@/lib/runtime/persistence/runtime-withdrawal-store";

export class RuntimeWithdrawalNotFoundError extends Error {}
export class RuntimeWithdrawalStateError extends Error {}
export class RuntimeWithdrawalPublicationNotFoundError extends Error {}
export class RuntimeWithdrawalVersionConflictError extends Error {}
export class RuntimeWithdrawalValidationError extends Error {}
export class RuntimeWithdrawalIdempotencyCompletionError extends Error {}

export interface WithdrawRuntimeRevisionResult {
  revision: RuntimeWithdrawalRevision;
  currentRevisionId: string | null;
  withdrawalRecordId: string;
  auditEventId: string;
  outboxEventId: string;
}

export interface WithdrawRuntimeRevisionCommand {
  tenantId: string;
  revisionId: string;
  runtimeExpectedVersionNo: number;
  actor: { tenantId: string; actorType: PublicationActorType; actorId: string };
  reasonCode: string;
  reason: string;
  requestId: string;
  idempotency?: {
    recordId: string;
    httpStatus: number;
    responseRef?: string | null;
    serializeResponse: (result: WithdrawRuntimeRevisionResult) => string;
  };
}

export function createWithdrawRuntimeRevision(dependencies: {
  store: RuntimeWithdrawalStore;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;
  return async function withdrawRuntimeRevision(
    command: WithdrawRuntimeRevisionCommand,
  ): Promise<WithdrawRuntimeRevisionResult> {
    if (command.actor.tenantId !== command.tenantId) {
      throw new Error("RuntimeRevision 撤回 actor tenant 与命令 tenant 不一致");
    }
    if (!command.reasonCode.trim() || !command.reason.trim()) {
      throw new RuntimeWithdrawalValidationError("reason_code 和 reason 必须为非空字符串");
    }
    return dependencies.store.transaction(async (session) => {
      const revision = await session.findRevision(command.tenantId, command.revisionId);
      if (!revision) throw new RuntimeWithdrawalNotFoundError(command.revisionId);
      if (revision.revisionState !== "published") {
        throw new RuntimeWithdrawalStateError(
          `RuntimeRevision ${revision.id} 状态为 ${revision.revisionState}，不能撤回`,
        );
      }
      const runtime = await session.findRuntime(command.tenantId, revision.runtimeId);
      if (!runtime || runtime.versionNo !== command.runtimeExpectedVersionNo) {
        throw new RuntimeWithdrawalVersionConflictError(
          `Runtime ${revision.runtimeId} 版本与 ${command.runtimeExpectedVersionNo} 不一致`,
        );
      }
      const publication = await session.findPublication(command.tenantId, revision.id);
      if (!publication) throw new RuntimeWithdrawalPublicationNotFoundError(revision.id);

      const withdrawnAt = now();
      const currentRevisionId = await session.findLatestPublishedRevisionId({
        tenantId: command.tenantId,
        runtimeId: revision.runtimeId,
        excludingRevisionId: revision.id,
      });
      const withdrawalRecordId = newId();
      await session.appendWithdrawal({
        id: withdrawalRecordId,
        tenantId: command.tenantId,
        publicationRecordId: publication.id,
        revisionId: revision.id,
        reasonCode: command.reasonCode.trim(),
        reason: command.reason.trim(),
        withdrawnByType: command.actor.actorType,
        withdrawnBy: command.actor.actorId,
        withdrawnAt,
      });
      if (!(await session.markRevisionWithdrawn(revision.id))) {
        throw new RuntimeWithdrawalStateError(`RuntimeRevision ${revision.id} 已被并发修改`);
      }
      if (
        !(await session.setRuntimeCurrentRevision({
          tenantId: command.tenantId,
          runtimeId: revision.runtimeId,
          currentRevisionId,
          expectedVersionNo: command.runtimeExpectedVersionNo,
          updatedAt: withdrawnAt,
        }))
      ) {
        throw new RuntimeWithdrawalVersionConflictError(`Runtime ${revision.runtimeId} 版本冲突`);
      }

      const auditEventId = newId();
      await session.appendAudit({
        id: auditEventId,
        tenantId: command.tenantId,
        actorType: command.actor.actorType,
        actorId: command.actor.actorId,
        revisionId: revision.id,
        reasonCode: command.reasonCode.trim(),
        reason: command.reason.trim(),
        after: {
          runtime_id: revision.runtimeId,
          revision_no: revision.revisionNo,
          revision_state: "withdrawn",
          publication_record_id: publication.id,
          withdrawal_record_id: withdrawalRecordId,
          current_revision_id: currentRevisionId,
        },
        requestId: command.requestId,
        occurredAt: withdrawnAt,
      });
      const outboxEventId = newId();
      await session.appendOutbox({
        id: outboxEventId,
        tenantId: command.tenantId,
        eventKey: `runtime-revision-withdrawn:${revision.id}`,
        eventType: "runtime.revision.withdrawn",
        aggregateId: revision.id,
        aggregateVersion: revision.revisionNo,
        payload: {
          runtime_id: revision.runtimeId,
          revision_id: revision.id,
          publication_record_id: publication.id,
          withdrawal_record_id: withdrawalRecordId,
          current_revision_id: currentRevisionId,
          audit_event_id: auditEventId,
        },
        occurredAt: withdrawnAt,
      });
      const result: WithdrawRuntimeRevisionResult = {
        revision: { ...revision, revisionState: "withdrawn" },
        currentRevisionId,
        withdrawalRecordId,
        auditEventId,
        outboxEventId,
      };
      if (command.idempotency) {
        const completed = await session.completeIdempotency({
          recordId: command.idempotency.recordId,
          httpStatus: command.idempotency.httpStatus,
          responseRef: command.idempotency.responseRef ?? null,
          responseRedactedJson: command.idempotency.serializeResponse(result),
          completedAt: withdrawnAt,
        });
        if (!completed) {
          throw new RuntimeWithdrawalIdempotencyCompletionError(command.idempotency.recordId);
        }
      }
      return result;
    });
  };
}
