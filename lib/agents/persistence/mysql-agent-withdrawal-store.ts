import type { AgentWithdrawalStore } from "@/lib/agents/persistence/agent-withdrawal-store";
import { controlPlaneOutboxEvent } from "@/lib/agents/persistence/control-plane-outbox";
import { db } from "@/lib/db/client";
import { computeContentHash } from "@/lib/identity/audit";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/control-plane";
import { auditEvent } from "@/lib/persistence/schema/control-plane";
import { idempotencyRecord } from "@/lib/persistence/schema/control-plane";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import { and, desc, eq, isNull, ne } from "drizzle-orm";

export const mysqlAgentWithdrawalStore: AgentWithdrawalStore = {
  transaction: (operation) =>
    db.transaction(async (tx) =>
      operation({
        async findRevision(tenantId, revisionId) {
          const [row] = await tx
            .select({ revision: agentRevisionTable })
            .from(agentRevisionTable)
            .innerJoin(
              agentTable,
              and(eq(agentTable.id, agentRevisionTable.agentId), eq(agentTable.tenantId, tenantId)),
            )
            .where(eq(agentRevisionTable.id, revisionId))
            .limit(1)
            .for("update");
          return row?.revision ?? null;
        },
        async findAgent(tenantId, agentId) {
          const [agent] = await tx
            .select()
            .from(agentTable)
            .where(and(eq(agentTable.tenantId, tenantId), eq(agentTable.id, agentId)))
            .limit(1)
            .for("update");
          return agent ?? null;
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
                eq(publicationRecord.subjectType, "agent_revision"),
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
            .select({ revisionId: agentRevisionTable.id })
            .from(publicationRecord)
            .innerJoin(
              agentRevisionTable,
              eq(agentRevisionTable.id, publicationRecord.subjectRevisionId),
            )
            .leftJoin(
              withdrawalRecord,
              eq(withdrawalRecord.publicationRecordId, publicationRecord.id),
            )
            .where(
              and(
                eq(publicationRecord.tenantId, params.tenantId),
                eq(publicationRecord.subjectType, "agent_revision"),
                eq(agentRevisionTable.agentId, params.agentId),
                eq(agentRevisionTable.revisionState, "published"),
                ne(agentRevisionTable.id, params.excludingRevisionId),
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
            subjectType: "agent_revision",
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
            .update(agentRevisionTable)
            .set({ revisionState: "withdrawn" })
            .where(
              and(
                eq(agentRevisionTable.id, revisionId),
                eq(agentRevisionTable.revisionState, "published"),
              ),
            );
          return result[0].affectedRows === 1;
        },
        async setAgentCurrentRevision(params) {
          const result = await tx
            .update(agentTable)
            .set({
              currentRevisionId: params.currentRevisionId,
              versionNo: params.expectedVersionNo + 1,
              updatedAt: params.updatedAt,
            })
            .where(
              and(
                eq(agentTable.tenantId, params.tenantId),
                eq(agentTable.id, params.agentId),
                eq(agentTable.versionNo, params.expectedVersionNo),
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
            actionType: "agent.retract",
            targetType: "agent_revision",
            targetId: params.revisionId,
            beforeHash: null,
            afterHash: computeContentHash(params.after),
            reason: `${params.reasonCode}: ${params.reason}`,
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
