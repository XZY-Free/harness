/**
 * MySQL Projection-based Route Resolution Store。
 *
 * : Projection 是运行时唯一的 Route Resolver 数据源。
 * 一次查询 RouteEligibilityProjection 表获取所有 eligible 候选 + 完整执行证据 ID。
 * 不随 Route 数量增加 SQL 往返。
 *
 * 完整证据 ID（agentAttestationIds、runtimeAttestationIds、publicationRecordId、conformanceRunId）
 * 由 build-route-eligibility.ts 在构建投影时从权威事实写入。
 * Binding 仍会对权威事实做 FOR UPDATE 最终校验。
 */

import { db } from "@/lib/db/client";
import type { RouteResolutionCandidate } from "@/lib/routes/domain/route-resolution-policy";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { and, eq } from "drizzle-orm";
import type {
 LoadProjectionCandidatesInput,
 RouteEligibilityResolutionStore,
} from "./route-eligibility-resolution-store";

export const mysqlRouteEligibilityResolutionStore: RouteEligibilityResolutionStore = {
 loadCandidates: async (
 input: LoadProjectionCandidatesInput,
 ): Promise<RouteResolutionCandidate[]> => {
 const projections = await db
 .select()
 .from(routeEligibilityProjection)
 .where(
 and(
 eq(routeEligibilityProjection.tenantId, input.tenantId),
 eq(routeEligibilityProjection.agentId, input.agentId),
 eq(routeEligibilityProjection.routeScopeKey, input.routeScopeKey),
 eq(routeEligibilityProjection.eligibilityState, "eligible"),
 ),
 );

 // 将 Projection 记录转换为 RouteResolutionCandidate
 // Projection 只包含 eligible 条目，Resolver 纯内存选择
 return projections.map((p): RouteResolutionCandidate => {
 const controlPlaneEvidence =
 p.agentArtifactDigest &&
 p.runtimeArtifactDigest &&
 p.runtimeConfigDigest &&
 p.agentPublicationRecordId &&
 p.runtimePublicationRecordId &&
 p.conformanceRunId &&
 Array.isArray(p.agentAttestationIds) &&
 Array.isArray(p.runtimeAttestationIds)
 ? {
 agentArtifactDigest: p.agentArtifactDigest,
 runtimeArtifactDigest: p.runtimeArtifactDigest,
 runtimeConfigDigest: p.runtimeConfigDigest,
 capabilityManifestDigest: p.capabilityCompatibilityDigest,
 // : 完整证据 ID 直接从 Projection 读取（不再 stub）
 agentAttestationIds: [...p.agentAttestationIds],
 runtimeAttestationIds: [...p.runtimeAttestationIds],
 agentPublicationRecordId: p.agentPublicationRecordId,
 runtimePublicationRecordId: p.runtimePublicationRecordId,
 conformanceRunId: p.conformanceRunId,
 }
 : null;

 return {
 deploymentRouteId: p.routeId,
 routeSetId: p.routeSetId,
 routeSetVersionNo: p.routeSetVersionNo,
 routeRevisionId: p.routeRevisionId,
 routeRevisionNo: p.routeRevisionNo,
 routeActivationId: p.routeActivationId,
 routeActivationSequence: p.routeActivationSequence,
 agentRevisionId: p.agentRevisionId,
 runtimeRevisionId: p.runtimeRevisionId,
 policyRevisionId: p.policyRevisionId,
 contentDigest: p.routeContentDigest,
 trafficWeight: p.trafficWeight,
 routeGroupId: p.routeGroupId,
 priorityNo: p.priorityNo,
 effectiveFrom: p.effectiveFrom,
 effectiveUntil: p.effectiveUntil,
 eligibilityConditions: p.eligibilityConditionsJson,
 activationState: "active", // eligible 投影必然 active
 agentLifecycleState: p.agentLifecycleState,
 agentRevisionState: p.agentRevisionState,
 agentPublicationActive: p.agentPublicationActive === 1,
 agentEvidenceValid: p.agentEvidenceValid === 1,
 runtimeLifecycleState: p.runtimeLifecycleState,
 runtimeRevisionState: p.runtimeRevisionState,
 runtimePublicationActive: p.runtimePublicationActive === 1,
 runtimeEvidenceValid: p.runtimeEvidenceValid === 1,
 runtimeConformanceValid: p.runtimeConformanceValid === 1,
 policyRevisionState: p.policyRevisionState,
 controlPlaneEvidence,
 /** : Projection 版本号 — 来自 RouteEligibilityProjection。 */
 projectionVersionNo: p.projectionVersionNo,
 };
 });
 },
};
