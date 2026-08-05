/**
 * MySQL Projection-based Route Resolution Store。
 *
 * 一次查询 RouteEligibilityProjection 表获取所有 eligible 候选。
 * 不随 Route 数量增加 SQL 往返。
 */

import { db } from "@/lib/db/client";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import type { RouteResolutionCandidate } from "@/lib/routes/domain/route-resolution-policy";
import type { RouteEligibilityResolutionStore, LoadProjectionCandidatesInput } from "./route-eligibility-resolution-store";
import { and, eq } from "drizzle-orm";

export const mysqlRouteEligibilityResolutionStore: RouteEligibilityResolutionStore = {
  loadCandidates: async (input: LoadProjectionCandidatesInput): Promise<RouteResolutionCandidate[]> => {
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
        p.runtimeConfigDigest
          ? {
              agentArtifactDigest: p.agentArtifactDigest,
              runtimeArtifactDigest: p.runtimeArtifactDigest,
              runtimeConfigDigest: p.runtimeConfigDigest,
              capabilityManifestDigest: p.capabilityCompatibilityDigest,
              // Attestation IDs 在 Projection 中不可用（非必要字段）
              // Binding 阶段做最终权威校验时获取
              agentAttestationIds: [],
              runtimeAttestationIds: [],
              agentPublicationRecordId: "",
              runtimePublicationRecordId: "",
              conformanceRunId: "",
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
        /** §4.6: Projection 版本号 — 来自 RouteEligibilityProjection。 */
        projectionVersionNo: p.projectionVersionNo,
      };
    });
  },
};
