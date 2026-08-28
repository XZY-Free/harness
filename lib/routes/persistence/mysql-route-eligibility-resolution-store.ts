/**
 * MySQL Projection-based Route Resolution Store。
 *
 * Projection 是运行时唯一的 Route Resolver 数据源。
 * 一次查询 RouteEligibilityProjection 表获取所有 eligible 候选 + 完整执行证据 ID。
 * 不随 Route 数量增加 SQL 往返。
 *
 * 完整证据 ID（runtimeAttestationIds、publicationRecordId、conformanceRunId）
 * 由 build-route-eligibility.ts 在构建投影时从权威事实写入。
 * Binding 仍会对权威事实做 FOR UPDATE 最终校验。
 */

import { db } from "@/lib/db/client";
import type {
  RouteControlPlaneEvidence,
  RouteResolutionCandidate,
} from "@/lib/routes/domain/route-resolution-policy";
import type { RouteEligibilityProjectionRecord } from "@/lib/routes/projection/route-eligibility-projection-record";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { and, eq, isNull } from "drizzle-orm";
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
          // 显式 target：runtime → 基础 Harness Route（targetKind=runtime，agentId IS NULL）；
          // agent → 指定 Agent 的 Route。
          input.target.kind === "agent"
            ? eq(routeEligibilityProjection.agentId, input.target.agentId)
            : isNull(routeEligibilityProjection.agentId),
          eq(routeEligibilityProjection.routeScopeKey, input.routeScopeKey),
          eq(routeEligibilityProjection.eligibilityState, "eligible"),
        ),
      );

    // 将 Projection 记录转换为 RouteResolutionCandidate
    // Projection 只包含 eligible 条目，Resolver 纯内存选择
    return projections.map((p): RouteResolutionCandidate => {
      // 控制面证据恒非空。基础 Harness Route（targetKind=runtime）→ agent 字段为
      // null（Agent Evidence not_applicable，§18）；Runtime 字段始终填充（base route
      // 也有 runtime revision/attestation）。Agent Route → 完整成组（§7.4）。
      const controlPlaneEvidence = buildControlPlaneEvidence(p);

      return {
        deploymentRouteId: p.routeId,
        routeSetId: p.routeSetId,
        routeSetVersionNo: p.routeSetVersionNo,
        routeRevisionId: p.routeRevisionId,
        routeRevisionNo: p.routeRevisionNo,
        routeActivationId: p.routeActivationId,
        routeActivationSequence: p.routeActivationSequence,
        targetKind: p.targetKind,
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
        activationState: p.activationState,
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
        /** Projection 版本号 — 来自 RouteEligibilityProjection。 */
        projectionVersionNo: p.projectionVersionNo,
      };
    });
  },
};

/**
 * 从 eligible Projection 构建完整控制面证据。
 *
 * Runtime 维度字段必填（§12/§10.2，无 Agent Route 也必须满足）；缺失即非法投影。
 * Agent 维度字段直接透传（base route 为 null，§18 Agent Evidence not_applicable，
 * 禁止伪装 passed、禁止空串假证据）。
 */
function buildControlPlaneEvidence(p: RouteEligibilityProjectionRecord): RouteControlPlaneEvidence {
  if (
    !p.runtimeConfigDigest ||
    !p.runtimeTargetDigest ||
    !p.runtimePublicationRecordId ||
    !p.conformanceRunId ||
    !Array.isArray(p.runtimeAttestationIds)
  ) {
    throw new Error("RouteEligibilityProjection 缺少必需的 Runtime 控制面证据");
  }
  // Runtime evidence all-or-nothing（03 §3）：hosted 要求 artifact 全集；external 无 artifact。
  if (
    p.runtimeEvidenceKind === "hosted_artifact" &&
    (!p.runtimeArtifactId || !p.runtimeArtifactDigest)
  ) {
    throw new Error("hosted_artifact 投影缺少 Runtime Artifact 证据");
  }
  return {
    agentRevisionId: p.agentRevisionId,
    runtimeArtifactId: p.runtimeArtifactId,
    runtimeArtifactDigest: p.runtimeArtifactDigest,
    runtimeEvidenceKind: p.runtimeEvidenceKind,
    runtimeConfigDigest: p.runtimeConfigDigest,
    runtimeTargetDigest: p.runtimeTargetDigest,
    capabilityManifestDigest: p.capabilityCompatibilityDigest,
    agentContractSnapshotId: p.agentContractSnapshotId,
    agentContractDigest: p.agentContractDigest,
    agentContextDigest: p.agentContextDigest,
    runtimeAttestationIds: [...p.runtimeAttestationIds],
    agentPublicationRecordId: p.agentPublicationRecordId,
    runtimePublicationRecordId: p.runtimePublicationRecordId,
    conformanceRunId: p.conformanceRunId,
  };
}
