/**
 * MySQL RouteEligibilityProjection Store 实现。
 *
 * : 只做 Projection CRUD，权威事实读取由 SourceReader 完成。
 */

import { db } from "@/lib/db/client";
import { eq, sql } from "drizzle-orm";
import { routeEligibilityProjection } from "./route-eligibility-projection-record";
import type { RouteEligibilityProjectionRecord } from "./route-eligibility-projection-record";
import type { RouteEligibilityStore, UpsertProjectionInput } from "./route-eligibility-store";

export const mysqlRouteEligibilityStore: RouteEligibilityStore = {
 upsertProjection: async (input: UpsertProjectionInput) => {
 const values = {
 routeId: input.routeId,
 tenantId: input.tenantId,
 agentId: input.agentId,
 routeSetId: input.routeSetId,
 routeScopeKey: input.routeScopeKey,
 routeSetVersionNo: input.routeSetVersionNo,
 routeRevisionId: input.routeRevisionId,
 routeRevisionNo: input.routeRevisionNo,
 routeActivationId: input.routeActivationId,
 routeActivationSequence: input.routeActivationSequence,
 routeGroupId: input.routeGroupId,
 selectorDigest: input.selectorDigest,
 eligibilityConditionsJson: input.eligibilityConditionsJson,
 specificity: input.specificity,
 priorityNo: input.priorityNo,
 trafficWeight: input.trafficWeight,
 effectiveFrom: input.effectiveFrom,
 effectiveUntil: input.effectiveUntil,
 agentRevisionId: input.agentRevisionId,
 agentRevisionState: input.agentRevisionState,
 agentLifecycleState: input.agentLifecycleState,
 agentPublicationActive: input.agentPublicationActive,
 agentEvidenceValid: input.agentEvidenceValid,
 runtimeRevisionId: input.runtimeRevisionId,
 runtimeRevisionState: input.runtimeRevisionState,
 runtimeLifecycleState: input.runtimeLifecycleState,
 runtimePublicationActive: input.runtimePublicationActive,
 runtimeEvidenceValid: input.runtimeEvidenceValid,
 runtimeConformanceValid: input.runtimeConformanceValid,
 policyRevisionId: input.policyRevisionId,
 policyRevisionState: input.policyRevisionState,
 capabilityCompatibilityDigest: input.capabilityCompatibilityDigest,
 agentArtifactDigest: input.agentArtifactDigest,
 runtimeArtifactDigest: input.runtimeArtifactDigest,
 runtimeConfigDigest: input.runtimeConfigDigest,
 routeContentDigest: input.routeContentDigest,
 agentPublicationRecordId: input.agentPublicationRecordId,
 runtimePublicationRecordId: input.runtimePublicationRecordId,
 agentAttestationIds: input.agentAttestationIds,
 runtimeAttestationIds: input.runtimeAttestationIds,
 conformanceRunId: input.conformanceRunId,
 agentArtifactId: input.agentArtifactId,
 runtimeArtifactId: input.runtimeArtifactId,
 sourceEventId: input.sourceEventId,
 sourceAggregateVersion: input.sourceAggregateVersion,
 invalidReason: input.invalidReason,
 eligibilityState: input.eligibilityState,
 projectionContentDigest: input.projectionContentDigest,
 projectionVersionNo: input.projectionVersionNo,
 lastRebuiltAt: input.lastRebuiltAt,
 };

 await db
 .insert(routeEligibilityProjection)
 .values(values)
 .onDuplicateKeyUpdate({
 set: {
 tenantId: sql`VALUES(tenantId)`,
 agentId: sql`VALUES(agentId)`,
 routeSetId: sql`VALUES(routeSetId)`,
 routeScopeKey: sql`VALUES(routeScopeKey)`,
 routeSetVersionNo: sql`VALUES(routeSetVersionNo)`,
 routeRevisionId: sql`VALUES(routeRevisionId)`,
 routeRevisionNo: sql`VALUES(routeRevisionNo)`,
 routeActivationId: sql`VALUES(routeActivationId)`,
 routeActivationSequence: sql`VALUES(routeActivationSequence)`,
 routeGroupId: sql`VALUES(routeGroupId)`,
 selectorDigest: sql`VALUES(selectorDigest)`,
 eligibilityConditionsJson: sql`VALUES(eligibilityConditionsJson)`,
 specificity: sql`VALUES(specificity)`,
 priorityNo: sql`VALUES(priorityNo)`,
 trafficWeight: sql`VALUES(trafficWeight)`,
 effectiveFrom: sql`VALUES(effectiveFrom)`,
 effectiveUntil: sql`VALUES(effectiveUntil)`,
 agentRevisionId: sql`VALUES(agentRevisionId)`,
 agentRevisionState: sql`VALUES(agentRevisionState)`,
 agentLifecycleState: sql`VALUES(agentLifecycleState)`,
 agentPublicationActive: sql`VALUES(agentPublicationActive)`,
 agentEvidenceValid: sql`VALUES(agentEvidenceValid)`,
 runtimeRevisionId: sql`VALUES(runtimeRevisionId)`,
 runtimeRevisionState: sql`VALUES(runtimeRevisionState)`,
 runtimeLifecycleState: sql`VALUES(runtimeLifecycleState)`,
 runtimePublicationActive: sql`VALUES(runtimePublicationActive)`,
 runtimeEvidenceValid: sql`VALUES(runtimeEvidenceValid)`,
 runtimeConformanceValid: sql`VALUES(runtimeConformanceValid)`,
 policyRevisionId: sql`VALUES(policyRevisionId)`,
 policyRevisionState: sql`VALUES(policyRevisionState)`,
 capabilityCompatibilityDigest: sql`VALUES(capabilityCompatibilityDigest)`,
 agentArtifactDigest: sql`VALUES(agentArtifactDigest)`,
 runtimeArtifactDigest: sql`VALUES(runtimeArtifactDigest)`,
 runtimeConfigDigest: sql`VALUES(runtimeConfigDigest)`,
 routeContentDigest: sql`VALUES(routeContentDigest)`,
 agentPublicationRecordId: sql`VALUES(agentPublicationRecordId)`,
 runtimePublicationRecordId: sql`VALUES(runtimePublicationRecordId)`,
 agentAttestationIds: sql`VALUES(agentAttestationIds)`,
 runtimeAttestationIds: sql`VALUES(runtimeAttestationIds)`,
 conformanceRunId: sql`VALUES(conformanceRunId)`,
 agentArtifactId: sql`VALUES(agentArtifactId)`,
 runtimeArtifactId: sql`VALUES(runtimeArtifactId)`,
 sourceEventId: sql`VALUES(sourceEventId)`,
 sourceAggregateVersion: sql`VALUES(sourceAggregateVersion)`,
 invalidReason: sql`VALUES(invalidReason)`,
 eligibilityState: sql`VALUES(eligibilityState)`,
 projectionContentDigest: sql`VALUES(projectionContentDigest)`,
 projectionVersionNo: sql`VALUES(projectionVersionNo)`,
 lastRebuiltAt: sql`VALUES(lastRebuiltAt)`,
 },
 });

 const [result] = await db
 .select()
 .from(routeEligibilityProjection)
 .where(eq(routeEligibilityProjection.routeId, input.routeId))
 .limit(1);
 return result!;
 },

 getProjectionByRoute: async (routeId: string) => {
 const [result] = await db
 .select()
 .from(routeEligibilityProjection)
 .where(eq(routeEligibilityProjection.routeId, routeId))
 .limit(1);
 return result ?? null;
 },

 listEligibleProjections: async (input) => {
 return db
 .select()
 .from(routeEligibilityProjection)
 .where(
 sql`${routeEligibilityProjection.tenantId} = ${input.tenantId} AND ${routeEligibilityProjection.agentId} = ${input.agentId} AND ${routeEligibilityProjection.routeScopeKey} = ${input.routeScopeKey} AND ${routeEligibilityProjection.eligibilityState} = 'eligible'`,
 );
 },

 markIneligible: async (routeId: string, _reason: string) => {
 await db
 .update(routeEligibilityProjection)
 .set({
 eligibilityState: "ineligible",
 })
 .where(eq(routeEligibilityProjection.routeId, routeId));
 },

 markPendingRebuild: async (routeId: string) => {
 await db
 .update(routeEligibilityProjection)
 .set({
 eligibilityState: "pending_rebuild",
 })
 .where(eq(routeEligibilityProjection.routeId, routeId));
 },

 deleteProjection: async (routeId: string) => {
 await db
 .delete(routeEligibilityProjection)
 .where(eq(routeEligibilityProjection.routeId, routeId));
 },

 deleteProjectionsByRouteSet: async (routeSetId: string) => {
 await db
 .delete(routeEligibilityProjection)
 .where(eq(routeEligibilityProjection.routeSetId, routeSetId));
 },

 listAllProjectionRouteIds: async () => {
 return db
 .select({ routeId: routeEligibilityProjection.routeId })
 .from(routeEligibilityProjection);
 },

 listProjectionRouteIdsByRouteSet: async (routeSetId: string) => {
 return db
 .select({ routeId: routeEligibilityProjection.routeId })
 .from(routeEligibilityProjection)
 .where(eq(routeEligibilityProjection.routeSetId, routeSetId));
 },
};
