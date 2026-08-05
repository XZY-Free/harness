/**
 * Route Resolver — Projection 作为唯一运行时解析数据源。
 *
 * §4.6: 切换完成 — Projection 是唯一的运行时 Route Resolver。
 * Authority Store 不再参与运行时解析（仅由 build-route-eligibility.ts 构建投影时使用）。
 *
 * Shadow 对比模式保留为可选诊断工具：
 * - 默认：仅查询 Projection（性能最优）
 * - 诊断：同时查询 Authority 并记录差异（enabled=true 且 authorityStore 提供）
 *
 * 不记录敏感 Prompt 或用户数据。
 *
 * 参见：SnowHarness专题01全局统一与最终收敛方案 §4.6
 */

import { logger } from "@/lib/logger";
import type {
  ResolveRouteCandidatesInput,
  RouteControlPlaneEvidence,
  RouteResolutionOutcome,
} from "@/lib/routes/domain/route-resolution-policy";
import { resolveRouteCandidates } from "@/lib/routes/domain/route-resolution-policy";
import type { RouteEligibilityResolutionStore } from "@/lib/routes/persistence/route-eligibility-resolution-store";
import type { RouteResolutionStore } from "@/lib/routes/persistence/route-resolution-store";

export interface ShadowResolutionResult {
  /** 实际使用的结果（Projection）。 */
  outcome: RouteResolutionOutcome;
  /** Shadow 差异记录（仅诊断模式启用时）。 */
  shadow?: ShadowDiff;
}

export interface ShadowDiff {
  /** Authority 是否 resolved。 */
  authorityResolved: boolean;
  /** Projection 是否 resolved。 */
  projectionResolved: boolean;
  /** Authority 选择的 RouteRevisionId。 */
  authorityRouteRevisionId: string | null;
  /** Projection 选择的 RouteRevisionId。 */
  projectionRouteRevisionId: string | null;
  /** 结果是否一致。 */
  consistent: boolean;
  /** 差异原因（不一致时）。 */
  diffReason?: string;
  /** Authority 查询耗时（ms）。 */
  authorityMs: number;
  /** Projection 查询耗时（ms）。 */
  projectionMs: number;
  /** Authority 候选数。 */
  authorityCandidateCount: number;
  /** Projection 候选数。 */
  projectionCandidateCount: number;
  /** §4.6: Authority 证据 ID 集合（Agent/Runtime Attestation + Publication + Conformance）。 */
  authorityEvidenceIds?: {
    attestationIds: string[];
    publicationRecordIds: string[];
    conformanceRunIds: string[];
  };
  /** §4.6: Projection 证据 ID 集合。 */
  projectionEvidenceIds?: {
    attestationIds: string[];
    publicationRecordIds: string[];
    conformanceRunIds: string[];
  };
}

export interface ShadowResolverConfig {
  /**
   * 是否启用 Shadow 对比诊断（默认 false）。
   *
   * 启用时需提供 authorityStore，同时查询 Authority 与 Projection 并记录差异。
   * 不启用时仅查询 Projection（生产默认）。
   */
  enabled: boolean;
}

const DEFAULT_CONFIG: ShadowResolverConfig = {
  enabled: false,
};

export interface CreateShadowRouteResolverDeps {
  /** Projection Store — 运行时解析的唯一数据源。 */
  projectionStore: RouteEligibilityResolutionStore;
  /** Authority Store — 仅诊断模式启用时使用。 */
  authorityStore?: RouteResolutionStore;
  config?: Partial<ShadowResolverConfig>;
}

/**
 * 创建 Route Resolver。
 *
 * §4.6: Projection 是唯一运行时解析数据源。
 * Shadow 对比为可选诊断模式，不参与实际选择。
 */
export function createShadowRouteResolver(deps: CreateShadowRouteResolverDeps) {
  const config: ShadowResolverConfig = { ...DEFAULT_CONFIG, ...deps.config };

  if (config.enabled && !deps.authorityStore) {
    throw new Error(
      "Shadow 对比模式启用时必须提供 authorityStore。" +
        "若不需要诊断对比，请保持 enabled=false（默认）。",
    );
  }

  return async function shadowResolveRoute(
    input: Omit<ResolveRouteCandidatesInput, "candidates"> & {
      tenantId: string;
      agentId: string;
      routeScopeKey: string;
    },
  ): Promise<ShadowResolutionResult> {
    // 默认路径：仅查询 Projection
    if (!config.enabled || !deps.authorityStore) {
      const projectionStart = Date.now();
      const candidates = await deps.projectionStore.loadCandidates({
        tenantId: input.tenantId,
        agentId: input.agentId,
        routeScopeKey: input.routeScopeKey,
      });
      const projectionMs = Date.now() - projectionStart;
      const outcome = resolveRouteCandidates({ ...input, candidates });
      return { outcome };
    }

    // 诊断路径：并行查询 Authority + Projection，记录差异
    const authorityStart = Date.now();
    const authorityCandidatesP = deps.authorityStore.loadCandidates({
      tenantId: input.tenantId,
      agentId: input.agentId,
      routeScopeKey: input.routeScopeKey,
    });
    const projectionStart = Date.now();
    const projectionCandidatesP = deps.projectionStore.loadCandidates({
      tenantId: input.tenantId,
      agentId: input.agentId,
      routeScopeKey: input.routeScopeKey,
    });

    const [authorityCandidates, projectionCandidates] = await Promise.all([
      authorityCandidatesP,
      projectionCandidatesP,
    ]);

    const authorityMs = Date.now() - authorityStart;
    const projectionMs = Date.now() - projectionStart;

    const authorityOutcome = resolveRouteCandidates({ ...input, candidates: authorityCandidates });
    const projectionOutcome = resolveRouteCandidates({
      ...input,
      candidates: projectionCandidates,
    });

    const authorityResolved = authorityOutcome.status === "resolved";
    const projectionResolved = projectionOutcome.status === "resolved";
    const authorityRouteRevisionId = authorityResolved
      ? authorityOutcome.resolution.routeRevisionId
      : null;
    const projectionRouteRevisionId = projectionResolved
      ? projectionOutcome.resolution.routeRevisionId
      : null;

    const consistent = authorityRouteRevisionId === projectionRouteRevisionId;
    const diffReason = computeDiffReason(authorityOutcome, projectionOutcome);

    const shadow: ShadowDiff = {
      authorityResolved,
      projectionResolved,
      authorityRouteRevisionId,
      projectionRouteRevisionId,
      consistent,
      diffReason: consistent ? undefined : diffReason,
      authorityMs,
      projectionMs,
      authorityCandidateCount: authorityCandidates.length,
      projectionCandidateCount: projectionCandidates.length,
      authorityEvidenceIds: authorityResolved
        ? extractEvidenceIds(authorityOutcome.resolution.controlPlaneEvidence)
        : undefined,
      projectionEvidenceIds: projectionResolved
        ? extractEvidenceIds(projectionOutcome.resolution.controlPlaneEvidence)
        : undefined,
    };

    if (!consistent) {
      logger.warn("[shadow-resolver] Authority 与 Projection 结果不一致", {
        tenantId: input.tenantId,
        agentId: input.agentId,
        routeScopeKey: input.routeScopeKey,
        authorityRouteRevisionId,
        projectionRouteRevisionId,
        diffReason,
        authorityMs,
        projectionMs,
      });
    } else {
      logger.info("[shadow-resolver] 一致", {
        tenantId: input.tenantId,
        authorityMs,
        projectionMs,
      });
    }

    // §4.6: 始终使用 Projection 结果（Authority 仅诊断）
    return { outcome: projectionOutcome, shadow };
  };
}

function computeDiffReason(
  authority: RouteResolutionOutcome,
  projection: RouteResolutionOutcome,
): string {
  if (authority.status !== projection.status) {
    return `status_mismatch: authority=${authority.status} projection=${projection.status}`;
  }
  if (authority.status === "resolved" && projection.status === "resolved") {
    if (authority.resolution.routeRevisionId !== projection.resolution.routeRevisionId) {
      return "different_route_revision_selected";
    }
    if (
      authority.resolution.controlPlaneEvidence.agentArtifactDigest !==
      projection.resolution.controlPlaneEvidence.agentArtifactDigest
    ) {
      return "evidence_digest_mismatch";
    }
  }
  if (authority.status === "unresolved" && projection.status === "unresolved") {
    if (authority.reason !== projection.reason) {
      return `unresolved_reason_mismatch: authority=${authority.reason} projection=${projection.reason}`;
    }
  }
  return "unknown";
}

/** §4.6: 从 controlPlaneEvidence 提取证据 ID 集合。 */
function extractEvidenceIds(evidence: RouteControlPlaneEvidence): {
  attestationIds: string[];
  publicationRecordIds: string[];
  conformanceRunIds: string[];
} {
  const attestationIds: string[] = [];
  const publicationRecordIds: string[] = [];
  const conformanceRunIds: string[] = [];

  const agentAttIds = evidence.agentAttestationIds;
  if (Array.isArray(agentAttIds))
    attestationIds.push(...agentAttIds.filter((id): id is string => typeof id === "string"));
  const runtimeAttIds = evidence.runtimeAttestationIds;
  if (Array.isArray(runtimeAttIds))
    attestationIds.push(...runtimeAttIds.filter((id): id is string => typeof id === "string"));
  if (typeof evidence.agentPublicationRecordId === "string" && evidence.agentPublicationRecordId)
    publicationRecordIds.push(evidence.agentPublicationRecordId);
  if (
    typeof evidence.runtimePublicationRecordId === "string" &&
    evidence.runtimePublicationRecordId
  )
    publicationRecordIds.push(evidence.runtimePublicationRecordId);
  if (typeof evidence.conformanceRunId === "string" && evidence.conformanceRunId)
    conformanceRunIds.push(evidence.conformanceRunId);

  return { attestationIds, publicationRecordIds, conformanceRunIds };
}
