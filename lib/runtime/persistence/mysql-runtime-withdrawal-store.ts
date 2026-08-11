import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { resolveOutboxAppend } from "@/lib/control-plane/events/outbox-append";
import { seedEventDeliveries } from "@/lib/control-plane/events/seed-event-deliveries";
import { db } from "@/lib/db/client";
import { computeContentHash } from "@/lib/identity/audit";
import { auditEvent, idempotencyRecord } from "@/lib/persistence/schema/control-plane";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import type { RuntimeWithdrawalStore } from "@/lib/runtime/persistence/runtime-withdrawal-store";
import { and, desc, eq, isNull, ne } from "drizzle-orm";

export const mysqlRuntimeWithdrawalStore: RuntimeWithdrawalStore = {
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
            .select({ id: runtimeTable.id, versionNo: runtimeTable.versionNo })
            .from(runtimeTable)
            .where(and(eq(runtimeTable.tenantId, tenantId), eq(runtimeTable.id, runtimeId)))
            .limit(1)
            .for("update");
          return runtime ?? null;
        },
        async findPublication(tenantId, revisionId) {
          const [record] = await tx
            .select({ id: publicationRecord.id })
            .from(publicationRecord)
            .leftJoin(
              withdrawalRecord,
              eq(withdrawalRecord.publicationRecordId, publicationRecord.id),
            )
            .where(
              and(
                eq(publicationRecord.tenantId, tenantId),
                eq(publicationRecord.subjectType, "runtime_revision"),
                eq(publicationRecord.subjectRevisionId, revisionId),
                isNull(withdrawalRecord.id),
              ),
            )
            .limit(1)
            .for("update");
          return record ?? null;
        },
        async findLatestPublishedRevisionId(params) {
          const [record] = await tx
            .select({ revisionId: runtimeRevisionTable.id })
            .from(publicationRecord)
            .innerJoin(
              runtimeRevisionTable,
              eq(runtimeRevisionTable.id, publicationRecord.subjectRevisionId),
            )
            .leftJoin(
              withdrawalRecord,
              eq(withdrawalRecord.publicationRecordId, publicationRecord.id),
            )
            .where(
              and(
                eq(publicationRecord.tenantId, params.tenantId),
                eq(publicationRecord.subjectType, "runtime_revision"),
                eq(runtimeRevisionTable.runtimeId, params.runtimeId),
                eq(runtimeRevisionTable.revisionState, "published"),
                ne(runtimeRevisionTable.id, params.excludingRevisionId),
                isNull(withdrawalRecord.id),
              ),
            )
            .orderBy(desc(publicationRecord.publicationSequence))
            .limit(1);
          return record?.revisionId ?? null;
        },
        async appendWithdrawal(params) {
          await tx.insert(withdrawalRecord).values({
            id: params.id,
            tenantId: params.tenantId,
            publicationRecordId: params.publicationRecordId,
            subjectType: "runtime_revision",
            subjectRevisionId: params.revisionId,
            reasonCode: params.reasonCode,
            reason: params.reason,
            withdrawnByType: params.withdrawnByType,
            withdrawnBy: params.withdrawnBy,
            withdrawnAt: params.withdrawnAt,
          });
        },
        async markRevisionWithdrawn(revisionId) {
          const result = await tx
            .update(runtimeRevisionTable)
            .set({ revisionState: "withdrawn" })
            .where(
              and(
                eq(runtimeRevisionTable.id, revisionId),
                eq(runtimeRevisionTable.revisionState, "published"),
              ),
            );
          return result[0].affectedRows === 1;
        },
        async setRuntimeCurrentRevision(params) {
          const result = await tx
            .update(runtimeTable)
            .set({
              currentRevisionId: params.currentRevisionId,
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
            actionType: "runtime.retract",
            targetType: "runtime_revision",
            targetId: params.revisionId,
            beforeHash: null,
            afterHash: computeContentHash(params.after),
            reason: `${params.reasonCode}: ${params.reason}`,
            requestId: params.requestId,
            occurredAt: params.occurredAt,
          });
        },
        async appendOutbox(params) {
          const resolved = resolveOutboxAppend(params);
          await tx.insert(controlPlaneOutboxEvent).values({
            id: resolved.id,
            tenantId: resolved.tenantId,
            schemaVersion: "1.0",
            eventKey: resolved.eventKey,
            eventType: resolved.eventType,
            aggregateType: resolved.aggregateType,
            aggregateId: resolved.aggregateId,
            aggregateVersion: resolved.aggregateVersion,
            payloadJson: resolved.payloadJson,
            occurredAt: resolved.occurredAt,
          });
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
