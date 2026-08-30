/**
 * MySQL Projection-based Route Resolution Store。
 *
 * Projection 是运行时唯一的 Route Resolver 数据源。
 * 一次查询 RouteEligibilityProjection 表获取所有 eligible 候选 + 完整执行证据 ID。
 * 不随 Route 数量增加 SQL 往返。
 *
 * Agent 与 Runtime Authority 分离（D）：
 * - 查询必须按显式 (tenantId,targetKind,targetIdentity,routeScopeKey,eligibilityState) 过滤；
 *   runtime 用 targetIdentity='runtime'，agent 用 targetIdentity=agentId。
 *   绝不使用 agentId IS NULL 代替 target，也绝不可只按 agentId 过滤而不验 targetKind/identity。
 * - 逐行按 p.targetKind 构造判别候选：agent 候选只含 Agent target 事实与 Agent 证据，
 *   runtime 候选只含 Runtime target 事实与 Runtime 证据；彼此不含对方字段。
 * - 任一投影 group 不完整/混合/不匹配 target 必须 fail-closed（抛明确错误），不得默认/补齐。
 *
 * 完整证据 ID（runtimeAttestationIds、publicationRecordId、conformanceRunId）
 * 由 build-route-eligibility.ts 在构建投影时从权威事实写入。
 * Binding 仍会对权威事实做 FOR UPDATE 最终校验。
 */

import { db } from "@/lib/db/client";
import type {
  RouteEvidence,
  RouteResolutionCandidate,
} from "@/lib/routes/domain/route-resolution-policy";
import type { RouteEligibilityProjectionRecord } from "@/lib/routes/projection/route-eligibility-projection-record";
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
    // 显式 target 谓词：runtime → targetKind='runtime' + targetIdentity='runtime'；
    // agent → targetKind='agent' + targetIdentity=agentId。绝不退化到 agentId IS NULL。
    const targetIdentity = input.target.kind === "agent" ? input.target.agentId : "runtime";
    const projections = await db
      .select()
      .from(routeEligibilityProjection)
      .where(
        and(
          eq(routeEligibilityProjection.tenantId, input.tenantId),
          eq(routeEligibilityProjection.targetKind, input.target.kind),
          eq(routeEligibilityProjection.targetIdentity, targetIdentity),
          eq(routeEligibilityProjection.routeScopeKey, input.routeScopeKey),
          eq(routeEligibilityProjection.eligibilityState, "eligible"),
        ),
      );

    // 逐行按 targetKind 构造判别候选；投影 group 不完整/混合一律 fail-closed。
    return projections.map((p) => buildCandidate(p));
  },
};

/**
 * 按投影 targetKind 分派构造判别候选。
 * - agent：只构造 Agent target 事实与 Agent 证据。
 * - runtime：只构造 Runtime target 事实与 Runtime 证据。
 * 未知 targetKind 视为非法投影，fail-closed。
 */
function buildCandidate(p: RouteEligibilityProjectionRecord): RouteResolutionCandidate {
  if (p.targetKind === "agent") return buildAgentCandidate(p);
  if (p.targetKind === "runtime") return buildRuntimeCandidate(p);
  throw new Error(`RouteEligibilityProjection 非法 targetKind: ${String(p.targetKind)}`);
}

/**
 * 构造 Agent 判别候选。
 *
 * Agent target 必须携带完整 Agent 生产调用事实（endpoint/identity/credential/network），
 * 且 runtime 组必须全 NULL（group 互斥）。任一缺失/混合即非法投影，fail-closed。
 * 证据只含 AgentContract/Publication 事实，绝不含 Runtime 字段或占位符。
 */
function buildAgentCandidate(p: RouteEligibilityProjectionRecord): RouteResolutionCandidate {
  const agentRevisionId = p.agentRevisionId;
  const agentEndpointRef = p.agentEndpointRef;
  const agentNetworkZone = p.agentNetworkZone;
  const identityMode = p.agentIdentityMode;
  if (
    !agentRevisionId ||
    agentRevisionId.trim() === "" ||
    !agentEndpointRef ||
    agentEndpointRef.trim() === "" ||
    !agentNetworkZone ||
    agentNetworkZone.trim() === "" ||
    (identityMode !== "none" && identityMode !== "bearer") ||
    (identityMode === "bearer" &&
      (!p.agentCredentialRefId || p.agentCredentialRefId.trim() === "")) ||
    !p.agentLifecycleState ||
    !p.agentRevisionState
  ) {
    throw new Error("RouteEligibilityProjection agent target 生产调用事实/资格不完整");
  }
  // group 互斥：agent target 不得携带任何 Runtime 事实（schema CHECK 之外防御）。
  assertAgentGroupIsolated(p);

  const common = buildCandidateCommon(p);
  return {
    ...common,
    target: {
      kind: "agent",
      agentRevisionId,
      agentEndpointRef,
      agentIdentityMode: identityMode,
      agentCredentialRefId: p.agentCredentialRefId,
      agentNetworkZone,
    },
    agentLifecycleState: p.agentLifecycleState,
    agentRevisionState: p.agentRevisionState,
    agentPublicationActive: p.agentPublicationActive === 1,
    agentEvidenceValid: p.agentEvidenceValid === 1,
    controlPlaneEvidence: buildAgentEvidence(p),
  };
}

/**
 * 构造 Runtime 判别候选。
 *
 * Runtime target 必须携带完整 Runtime 证据（config/target/publication/conformance/attestation），
 * hosted 要求 Artifact 全集；且 agent 组必须全 NULL（group 互斥）。任一缺失/混合即非法投影，
 * fail-closed。证据只含 Runtime 事实，绝不含 Agent 字段。
 */
function buildRuntimeCandidate(p: RouteEligibilityProjectionRecord): RouteResolutionCandidate {
  if (!p.runtimeRevisionId || !p.runtimeLifecycleState || !p.runtimeRevisionState) {
    throw new Error("RouteEligibilityProjection runtime target 资格不完整");
  }
  // group 互斥：runtime target 不得携带任何 Agent 事实。
  assertRuntimeGroupIsolated(p);
  // Runtime 证据 all-or-nothing：缺失即非法投影。
  const evidence = buildRuntimeEvidence(p);

  const common = buildCandidateCommon(p);
  return {
    ...common,
    target: {
      kind: "runtime",
      runtimeRevisionId: p.runtimeRevisionId,
    },
    runtimeLifecycleState: p.runtimeLifecycleState,
    runtimeRevisionState: p.runtimeRevisionState,
    runtimePublicationActive: p.runtimePublicationActive === 1,
    runtimeEvidenceValid: p.runtimeEvidenceValid === 1,
    runtimeConformanceValid: p.runtimeConformanceValid === 1,
    controlPlaneEvidence: evidence,
  };
}

/** 候选公共字段（target 无关部分）。 */
function buildCandidateCommon(p: RouteEligibilityProjectionRecord) {
  return {
    deploymentRouteId: p.routeId,
    routeSetId: p.routeSetId,
    routeSetVersionNo: p.routeSetVersionNo,
    routeRevisionId: p.routeRevisionId,
    routeRevisionNo: p.routeRevisionNo,
    routeActivationId: p.routeActivationId,
    routeActivationSequence: p.routeActivationSequence,
    policyRevisionId: p.policyRevisionId,
    contentDigest: p.routeContentDigest,
    trafficWeight: p.trafficWeight,
    routeGroupId: p.routeGroupId,
    priorityNo: p.priorityNo,
    effectiveFrom: p.effectiveFrom,
    effectiveUntil: p.effectiveUntil,
    eligibilityConditions: p.eligibilityConditionsJson,
    activationState: p.activationState,
    policyRevisionState: p.policyRevisionState,
    /** Projection 版本号 — 来自 RouteEligibilityProjection，原样保留给 policy 判读。 */
    projectionVersionNo: p.projectionVersionNo,
  };
}

/**
 * Agent 控制面证据 — 只含 AgentContract/Publication 事实。
 * 缺失任一即非法投影，fail-closed；绝不含 Runtime 字段或占位符。
 */
function buildAgentEvidence(
  p: RouteEligibilityProjectionRecord,
): Extract<RouteEvidence, { kind: "agent" }> {
  if (
    !p.agentContractSnapshotId ||
    !p.agentContractDigest ||
    !p.agentContextDigest ||
    !p.agentPublicationRecordId
  ) {
    throw new Error("RouteEligibilityProjection 缺少必需的 Agent 控制面证据");
  }
  return {
    kind: "agent",
    agentContractSnapshotId: p.agentContractSnapshotId,
    agentContractDigest: p.agentContractDigest,
    agentContextDigest: p.agentContextDigest,
    agentPublicationRecordId: p.agentPublicationRecordId,
  };
}

/**
 * Runtime 控制面证据 — 只含 Runtime artifact/config/target/publication/conformance/attestation
 * 事实，绝不含 Agent 字段。保留原有 all-or-nothing 完整性校验。
 */
function buildRuntimeEvidence(
  p: RouteEligibilityProjectionRecord,
): Extract<RouteEvidence, { kind: "runtime" }> {
  if (
    !p.runtimeConfigDigest ||
    !p.runtimeTargetDigest ||
    !p.runtimePublicationRecordId ||
    !p.conformanceRunId ||
    !Array.isArray(p.runtimeAttestationIds) ||
    (p.runtimeEvidenceKind !== "hosted_artifact" &&
      p.runtimeEvidenceKind !== "external_endpoint") ||
    // capabilityCompatibilityDigest 是 runtime projection 的必需字段（§6），
    // 缺失/空白即非法投影；禁止 "" 等 placeholder fallback。
    !p.capabilityCompatibilityDigest ||
    p.capabilityCompatibilityDigest.trim() === ""
  ) {
    throw new Error("RouteEligibilityProjection 缺少必需的 Runtime 控制面证据");
  }
  // Runtime evidence all-or-nothing：hosted 要求 artifact 全集；external 无 artifact。
  if (
    p.runtimeEvidenceKind === "hosted_artifact" &&
    (!p.runtimeArtifactId || !p.runtimeArtifactDigest)
  ) {
    throw new Error("hosted_artifact 投影缺少 Runtime Artifact 证据");
  }
  return {
    kind: "runtime",
    runtimeArtifactId: p.runtimeArtifactId,
    runtimeArtifactDigest: p.runtimeArtifactDigest,
    runtimeEvidenceKind: p.runtimeEvidenceKind,
    runtimeConfigDigest: p.runtimeConfigDigest,
    runtimeTargetDigest: p.runtimeTargetDigest,
    capabilityManifestDigest: p.capabilityCompatibilityDigest,
    runtimeAttestationIds: [...p.runtimeAttestationIds],
    runtimePublicationRecordId: p.runtimePublicationRecordId,
    conformanceRunId: p.conformanceRunId,
  };
}

/** group 互斥：agent target 不得携带任何 Runtime 事实（缺一即非法投影）。 */
function assertAgentGroupIsolated(p: RouteEligibilityProjectionRecord): void {
  if (
    p.runtimeRevisionId !== null ||
    p.runtimeRevisionState !== null ||
    p.runtimeLifecycleState !== null ||
    p.runtimePublicationActive !== null ||
    p.runtimeEvidenceValid !== null ||
    p.runtimeConformanceValid !== null ||
    p.runtimeEvidenceKind !== null ||
    p.runtimeArtifactDigest !== null ||
    p.runtimeConfigDigest !== null ||
    p.runtimeTargetDigest !== null ||
    p.runtimePublicationRecordId !== null ||
    p.runtimeAttestationIds !== null ||
    p.conformanceRunId !== null ||
    p.runtimeArtifactId !== null ||
    p.capabilityCompatibilityDigest !== null
  ) {
    throw new Error("RouteEligibilityProjection agent target 不得携带 Runtime 事实（混合投影）");
  }
}

/** group 互斥：runtime target 不得携带任何 Agent 事实（缺一即非法投影）。 */
function assertRuntimeGroupIsolated(p: RouteEligibilityProjectionRecord): void {
  if (
    p.agentRevisionId !== null ||
    p.agentEndpointRef !== null ||
    p.agentIdentityMode !== null ||
    p.agentCredentialRefId !== null ||
    p.agentNetworkZone !== null ||
    p.agentRevisionState !== null ||
    p.agentLifecycleState !== null ||
    p.agentPublicationActive !== null ||
    p.agentEvidenceValid !== null ||
    p.agentPublicationRecordId !== null ||
    p.agentContractSnapshotId !== null ||
    p.agentContractDigest !== null ||
    p.agentContextDigest !== null
  ) {
    throw new Error("RouteEligibilityProjection runtime target 不得携带 Agent 事实（混合投影）");
  }
}
