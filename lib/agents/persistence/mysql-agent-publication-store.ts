import { parsePublicAgentContract } from "@/lib/agents/domain/public-agent-contract";
import type { AgentPublicationStore } from "@/lib/agents/persistence/agent-publication-store";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { resolveOutboxAppend } from "@/lib/control-plane/events/outbox-append";
import { seedEventDeliveries } from "@/lib/control-plane/events/seed-event-deliveries";
import { db } from "@/lib/db/client";
import { computeContentHash } from "@/lib/identity/audit";
import {
  agentContractCapabilityTable,
  agentContractInvocationContextTable,
  agentContractSnapshotTable,
  agentRevisionTable,
  agentTable,
} from "@/lib/persistence/schema/agents";
import { auditEvent } from "@/lib/persistence/schema/control-plane";
import { idempotencyRecord } from "@/lib/persistence/schema/control-plane";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import { and, asc, eq } from "drizzle-orm";

export const mysqlAgentPublicationStore: AgentPublicationStore = {
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
        async findContractSnapshot(tenantId, snapshotId) {
          const [row] = await tx
            .select()
            .from(agentContractSnapshotTable)
            .where(
              and(
                eq(agentContractSnapshotTable.tenantId, tenantId),
                eq(agentContractSnapshotTable.id, snapshotId),
              ),
            )
            .limit(1)
            .for("update");
          if (!row) return null;
          const capabilities = await tx
            .select()
            .from(agentContractCapabilityTable)
            .where(eq(agentContractCapabilityTable.snapshotId, row.id))
            .orderBy(asc(agentContractCapabilityTable.position));
          const contexts = await tx
            .select()
            .from(agentContractInvocationContextTable)
            .where(eq(agentContractInvocationContextTable.snapshotId, row.id))
            .orderBy(asc(agentContractInvocationContextTable.position));
          const recomputed = parsePublicAgentContract({
            contract_version: row.contractVersion,
            agent: {
              id: row.publicAgentId,
              version: row.publicAgentVersion,
              name: { "zh-CN": row.agentNameZhCn, en: row.agentNameEn },
            },
            capabilities: capabilities.map((capability) => ({
              key: capability.key,
              name: { "zh-CN": capability.nameZhCn, en: capability.nameEn },
              description: {
                "zh-CN": capability.descriptionZhCn,
                en: capability.descriptionEn,
              },
              tags: capability.tags,
              examples: capability.examples,
              input_modes: capability.inputModes,
              output_modes: capability.outputModes,
            })),
            invocation_context: contexts.map((context) => ({
              key: context.key,
              name: { "zh-CN": context.nameZhCn, en: context.nameEn },
              necessity: context.necessity,
              description: { "zh-CN": context.descriptionZhCn, en: context.descriptionEn },
              applies_to: context.appliesTo,
              trust_requirement: context.trustRequirement,
              // declarationSource 是登记系统 provenance，不属于 request-only 合同 digest。
              declaration_source: null,
            })),
            interaction: {
              streaming_transport: row.streamingTransport,
              incremental_content: row.incrementalContent,
              input_required: row.inputRequired,
              resume: row.resume,
              cancel: row.cancel,
              durable_task_recovery: row.durableTaskRecovery,
              supported_locales: row.supportedLocales,
            },
            result_contract: {
              fields: row.resultFields,
              error_codes: row.errorCodes,
              notes: { "zh-CN": row.resultNotesZhCn, en: row.resultNotesEn },
            },
          });
          return {
            id: row.id,
            agentId: row.agentId,
            contractDigest: row.contractDigest,
            capabilityDigest: row.capabilityDigest,
            contextDigest: row.contextDigest,
            recomputedContractDigest: recomputed.contractDigest,
            recomputedCapabilityDigest: recomputed.capabilityDigest,
            recomputedContextDigest: recomputed.contextDigest,
          };
        },
        async appendPublication(params) {
          await tx.insert(publicationRecord).values({
            id: params.id,
            tenantId: params.tenantId,
            subjectType: "agent_revision",
            subjectRevisionId: params.revisionId,
            evidenceSetDigest: params.evidenceSetDigest,
            attestationIds: [],
            conformanceRunId: null,
            approvals: [],
            agentContractSnapshotId: params.contractEvidence.agentContractSnapshotId,
            agentContractDigest: params.contractEvidence.agentContractDigest,
            agentCapabilityDigest: params.contractEvidence.agentCapabilityDigest,
            agentContextDigest: params.contractEvidence.agentContextDigest,
            publishedByType: params.publishedByType,
            publishedBy: params.publishedBy,
            publishedAt: params.publishedAt,
            idempotencyKey: params.idempotencyKey,
            idempotencyRecordId: params.idempotencyRecordId,
          });
        },
        async markRevisionPublished(revisionId, publishedAt) {
          const result = await tx
            .update(agentRevisionTable)
            .set({ revisionState: "published", publishedAt })
            .where(
              and(
                eq(agentRevisionTable.id, revisionId),
                eq(agentRevisionTable.revisionState, "draft"),
              ),
            );
          return result[0].affectedRows === 1;
        },
        async setAgentCurrentRevision(params) {
          const result = await tx
            .update(agentTable)
            .set({
              currentRevisionId: params.revisionId,
              versionNo: params.expectedVersionNo + 1,
              lifecycleState: params.lifecycleState,
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
            actionType: "agent.publish",
            targetType: "agent_revision",
            targetId: params.revisionId,
            beforeHash: null,
            afterHash: computeContentHash(params.after),
            reason: params.reason,
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
          // §14: 同事务创建 Delivery 行，确保 Relay Worker 能领取
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
