/**
 * RouteSet 整体激活 MySQL Store 实现。
 */
import { randomUUID } from "node:crypto";
import {
 artifact,
 artifactAttestation,
 attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { resolveOutboxAppend } from "@/lib/control-plane/events/outbox-append";
import { seedEventDeliveries } from "@/lib/control-plane/events/seed-event-deliveries";
import { db } from "@/lib/db/client";
import { computeContentHash } from "@/lib/identity/audit";
import { agentRevisionTable } from "@/lib/persistence/schema/agents";
import { auditEvent } from "@/lib/persistence/schema/control-plane";
import { idempotencyRecord } from "@/lib/persistence/schema/control-plane";
import { deploymentRouteSetTable, deploymentRouteTable } from "@/lib/persistence/schema/routes";
import { runtimeRevisionTable } from "@/lib/persistence/schema/runtimes";
import { RouteNotFoundError } from "@/lib/routes/domain/route-revision";
import { computeSelectorDigest, normalizeEligibility } from "@/lib/routes/domain/route-selector";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import type { RouteSetActivationStore } from "@/lib/routes/persistence/route-set-activation-store";
import { and, desc, eq, max } from "drizzle-orm";

function requiredCapabilities(value: unknown): string[] {
 if (!value || typeof value !== "object") return [];
 const required = (value as { required?: unknown }).required;
 return Array.isArray(required)
 ? required.filter((item): item is string => typeof item === "string")
 : [];
}

function runtimeCapabilities(value: unknown): string[] {
 if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
 if (!value || typeof value !== "object") return [];
 const capabilities = (value as { capabilities?: unknown }).capabilities;
 return Array.isArray(capabilities)
 ? capabilities.filter((item): item is string => typeof item === "string")
 : [];
}

export const mysqlRouteSetActivationStore: RouteSetActivationStore = {
 transaction: (operation) =>
 db.transaction(async (tx) =>
 operation({
 /** §04: 事务级 DB 连接 — 所有资格读取必须在同一事务。 */
 getDbOrTx() {
  return tx;
 },

 async lockRouteSet(params) {
 const [row] = await tx
 .select()
 .from(deploymentRouteSetTable)
 .where(
 and(
 eq(deploymentRouteSetTable.id, params.routeSetId),
 eq(deploymentRouteSetTable.tenantId, params.tenantId),
 ),
 )
 .limit(1)
 .for("update");
 return row ?? null;
 },

 async listRoutesBySet(routeSetId) {
 return tx
 .select()
 .from(deploymentRouteTable)
 .where(eq(deploymentRouteTable.routeSetId, routeSetId))
 .orderBy(desc(deploymentRouteTable.createdAt));
 },

 // : findRevisionById — 通过 ID 查询 RouteRevisionRecord
 async findRevisionById(id) {
 const [row] = await tx
 .select()
 .from(routeRevision)
 .where(eq(routeRevision.id, id))
 .limit(1);
 return row ?? null;
 },

 async findAgentRevision(id) {
 const [row] = await tx
 .select()
 .from(agentRevisionTable)
 .where(eq(agentRevisionTable.id, id))
 .limit(1)
 .for("share");
 return row
 ? {
 id: row.id,
 agentId: row.agentId,
 revisionState: row.revisionState,
 requiredCapabilities: requiredCapabilities(row.agentInterfaceRequirementsJson),
 }
 : null;
 },

 async findRuntimeRevision(id) {
 const [row] = await tx
 .select()
 .from(runtimeRevisionTable)
 .where(eq(runtimeRevisionTable.id, id))
 .limit(1)
 .for("share");
 return row
 ? {
 id: row.id,
 revisionState: row.revisionState,
 capabilities: runtimeCapabilities(row.runtimeCapabilitiesJson),
 }
 : null;
 },

 async findLatestActivation(routeId) {
 const [row] = await tx
 .select()
 .from(routeActivation)
 .where(eq(routeActivation.routeId, routeId))
 .orderBy(desc(routeActivation.activationSequence))
 .limit(1);
 return row ?? null;
 },

 async resolveOrCreateRouteIdentity(params) {
 // : 使用 routeKey 查找 Route 身份，不再用 agentRevisionId+runtimeRevisionId
 const conditions = params.routeId
 ? and(
 eq(deploymentRouteTable.id, params.routeId),
 eq(deploymentRouteTable.routeSetId, params.routeSetId),
 )
 : and(
 eq(deploymentRouteTable.routeSetId, params.routeSetId),
 eq(deploymentRouteTable.routeKey, params.routeKey),
 );
 const [existing] = await tx
 .select()
 .from(deploymentRouteTable)
 .where(conditions)
 .limit(1)
 .for("update");
 if (existing) return existing;
 if (params.routeId) {
 throw new RouteNotFoundError(params.routeId);
 }
 const id = randomUUID();
 await tx.insert(deploymentRouteTable).values({
 id,
 routeSetId: params.routeSetId,
 routeKey: params.routeKey ?? `route-${id}`,
 agentRevisionId: params.content.agentRevisionId,
 runtimeRevisionId: params.content.runtimeRevisionId,
 trafficWeight: params.content.trafficWeight,
 priorityNo: params.content.priorityNo,
 routeState: "enabled",
 effectiveFrom: params.content.effectiveFrom,
 effectiveUntil: params.content.effectiveUntil,
 activeRouteRevisionId: null,
 createdAt: params.now,
 updatedAt: params.now,
 });
 const [created] = await tx
 .select()
 .from(deploymentRouteTable)
 .where(eq(deploymentRouteTable.id, id))
 .limit(1);
 if (!created) throw new Error(`DeploymentRoute 稳定身份创建失败: ${id}`);
 return created;
 },

 async findRevisionByContent(routeId, contentDigest) {
 const [row] = await tx
 .select()
 .from(routeRevision)
 .where(
 and(
 eq(routeRevision.routeId, routeId),
 eq(routeRevision.contentDigest, contentDigest),
 ),
 )
 .limit(1);
 return row ?? null;
 },

 async nextRevisionNo(routeId) {
 const [row] = await tx
 .select({ value: max(routeRevision.revisionNo) })
 .from(routeRevision)
 .where(eq(routeRevision.routeId, routeId));
 return (row?.value ?? 0) + 1;
 },

 async appendRevision(params) {
 const normalized = normalizeEligibility(params.content.eligibilityConditions);
 await tx.insert(routeRevision).values({
 id: params.id,
 tenantId: params.tenantId,
 routeId: params.routeId,
 routeSetId: params.routeSetId,
 routeKey: params.routeKey ?? `route-${params.routeId}`,
 revisionNo: params.revisionNo,
 agentRevisionId: params.content.agentRevisionId,
 runtimeRevisionId: params.content.runtimeRevisionId,
 policyRevisionId: params.content.policyRevisionId,
 modelPolicyRevisionId: params.content.modelPolicyRevisionId,
 toolsetRevisionId: params.content.toolsetRevisionId,
 trafficAllocationJson: {
 weightBasisPoints: params.content.trafficWeight,
 ...(params.content.routeGroupId ? { groupId: params.content.routeGroupId } : {}),
 },
 routeGroupId: params.content.routeGroupId,
 selectorDigest:
 params.selectorDigest ?? (normalized ? computeSelectorDigest(normalized) : ""),
 trafficWeight: params.content.trafficWeight,
 priorityNo: params.content.priorityNo,
 effectiveFrom: params.content.effectiveFrom,
 effectiveUntil: params.content.effectiveUntil,
 eligibilityConditionsJson: params.content.eligibilityConditions,
 contentDigest: params.contentDigest,
 createdByType: params.actorType,
 createdBy: params.actorId,
 validatedAt: params.now,
 createdAt: params.now,
 });
 const [row] = await tx
 .select()
 .from(routeRevision)
 .where(eq(routeRevision.id, params.id))
 .limit(1);
 if (!row) throw new Error(`RouteRevision 写入失败: ${params.id}`);
 return row;
 },

 async nextActivationSequence(routeId) {
 const [row] = await tx
 .select({ value: max(routeActivation.activationSequence) })
 .from(routeActivation)
 .where(eq(routeActivation.routeId, routeId));
 return (row?.value ?? 0) + 1;
 },

 async appendActivation(params) {
 await tx.insert(routeActivation).values({
 id: params.id,
 tenantId: params.tenantId,
 routeId: params.routeId,
 routeRevisionId: params.routeRevisionId,
 routeSetId: params.routeSetId,
 activationSequence: params.activationSequence,
 activationState: params.activationState,
 previousRouteRevisionId: params.previousRouteRevisionId,
 previousRouteActivationId: params.previousRouteActivationId,
 routeSetVersionNo: params.routeSetVersionNo,
 activatedByType: params.actorType,
 activatedBy: params.actorId,
 reason: params.reason,
 requestId: params.requestId,
 idempotencyKey: params.idempotencyKey,
 activatedAt: params.now,
 });
 const [row] = await tx
 .select()
 .from(routeActivation)
 .where(eq(routeActivation.id, params.id))
 .limit(1);
 if (!row) throw new Error(`RouteActivation 写入失败: ${params.id}`);
 return row;
 },

 async updateRouteProjection(params) {
 await tx
 .update(deploymentRouteTable)
 .set({
 routeKey: params.revision.routeKey,
 agentRevisionId: params.revision.agentRevisionId,
 runtimeRevisionId: params.revision.runtimeRevisionId,
 trafficWeight: params.revision.trafficWeight,
 priorityNo: params.revision.priorityNo,
 routeState: params.routeState,
 effectiveFrom: params.revision.effectiveFrom,
 effectiveUntil: params.revision.effectiveUntil,
 activeRouteRevisionId: params.revision.id,
 updatedAt: params.now,
 })
 .where(eq(deploymentRouteTable.id, params.routeId));
 const [row] = await tx
 .select()
 .from(deploymentRouteTable)
 .where(eq(deploymentRouteTable.id, params.routeId))
 .limit(1);
 if (!row) throw new Error(`DeploymentRoute 投影更新失败: ${params.routeId}`);
 return row;
 },

 async advanceRouteSetVersion(params) {
 const result = await tx
 .update(deploymentRouteSetTable)
 .set({ versionNo: params.expectedVersionNo + 1, updatedAt: params.now })
 .where(
 and(
 eq(deploymentRouteSetTable.id, params.routeSetId),
 eq(deploymentRouteSetTable.versionNo, params.expectedVersionNo),
 ),
 );
 if (result[0].affectedRows !== 1) return null;
 const [row] = await tx
 .select()
 .from(deploymentRouteSetTable)
 .where(eq(deploymentRouteSetTable.id, params.routeSetId))
 .limit(1);
 return row ?? null;
 },

 async appendAudit(params) {
 await tx.insert(auditEvent).values({
 id: params.id,
 tenantId: params.tenantId,
 actorType: params.actorType,
 actorId: params.actorId,
 actionType: params.actionType,
 targetType: "deployment_route",
 targetId: params.routeId,
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
 eq(idempotencyRecord.tenantId, params.tenantId),
 eq(idempotencyRecord.commandScope, params.commandScope),
 eq(idempotencyRecord.processingState, "processing"),
 ),
 );
 return result[0].affectedRows === 1;
 },
 }),
 ),
};
