/**
 * Shadow Route Resolver — 同时执行 Authority 和 Projection Resolver，记录差异。
 *
 * 第一阶段：Authority 结果用于实际执行，Projection 结果仅对比。
 * 切换条件满足后：Projection 用于选择，Binding 做最终权威校验。
 *
 * 不记录敏感 Prompt 或用户数据。
 *
 * ⚠️ useProjectionForExecution 冻结为 false：Projection 当前不足以支撑
 * ExecutionBinding 的完整执行证据，在正式切换前禁止打开。
 * 参见：SnowHarness专题01全局统一与最终收敛方案 §0.4
 */

import type {
  RouteControlPlaneEvidence,
  RouteResolutionCandidate,
  RouteResolutionOutcome,
  ResolveRouteCandidatesInput,
} from "@/lib/routes/domain/route-resolution-policy";
import { resolveRouteCandidates } from "@/lib/routes/domain/route-resolution-policy";
import type { RouteResolutionStore } from "@/lib/routes/persistence/route-resolution-store";
import type { RouteEligibilityResolutionStore } from "@/lib/routes/persistence/route-eligibility-resolution-store";
import { logger } from "@/lib/logger";

export interface ShadowResolutionResult {
  /** 实际使用的结果（Authority 阶段为 authority，切换后为 projection）。 */
  outcome: RouteResolutionOutcome;
  /** Shadow 差异记录。 */
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
  authorityEvidenceIds?: { attestationIds: string[]; publicationRecordIds: string[]; conformanceRunIds: string[] };
  /** §4.6: Projection 证据 ID 集合。 */
  projectionEvidenceIds?: { attestationIds: string[]; publicationRecordIds: string[]; conformanceRunIds: string[] };
  /** §4.6: Authority DB 查询次数。 */
  authorityQueryCount?: number;
  /** §4.6: Projection DB 查询次数。 */
  projectionQueryCount?: number;
}

export interface ShadowResolverConfig {
  /** 是否启用 Shadow 对比（默认 true）。 */
  enabled: boolean;
  /**
   * 是否已切换到 Projection（默认 false — Authority 阶段）。
   *
   * ⚠️ 冻结：当前 Projection 证据不完整，不足以支撑 ExecutionBinding。
   * 生产环境启动时如果设为 true，直接启动失败。
   */
  useProjectionForExecution: boolean;
}

const DEFAULT_CONFIG: ShadowResolverConfig = {
  enabled: true,
  useProjectionForExecution: false,
};

export interface CreateShadowRouteResolverDeps {
  authorityStore: RouteResolutionStore;
  projectionStore: RouteEligibilityResolutionStore;
  config?: Partial<ShadowResolverConfig>;
}

/**
 * 创建 Shadow Route Resolver。
 *
 * 生产启动断言：useProjectionForExecution=true 时直接抛错，
 * 防止误打开导致不完整证据进入执行链。
 */
export function createShadowRouteResolver(deps: CreateShadowRouteResolverDeps) {
  const config = { ...DEFAULT_CONFIG, ...deps.config };

  // 生产启动断言：Projection 不能用于正式执行
  if (config.useProjectionForExecution) {
    throw new Error(
      "FROZEN: useProjectionForExecution=true 不允许。" +
      "Projection 当前证据不完整（缺少完整 Publication/Attestation/Conformance ID），" +
      "不足以支撑 ExecutionBinding。参见专题01 §0.4。",
    );
  }

  return async function shadowResolveRoute(
    input: Omit<ResolveRouteCandidatesInput, "candidates"> & {
      tenantId: string;
      agentId: string;
      routeScopeKey: string;
    },
  ): Promise<ShadowResolutionResult> {
    if (!config.enabled) {
      // Shadow 未启用 — 只用 Authority
      const candidates = await deps.authorityStore.loadCandidates({
        tenantId: input.tenantId,
        agentId: input.agentId,
        routeScopeKey: input.routeScopeKey,
      });
      const outcome = resolveRouteCandidates({ ...input, candidates });
      return { outcome };
    }

    // 并行执行两个 Store 查询
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
    const projectionOutcome = resolveRouteCandidates({ ...input, candidates: projectionCandidates });

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
      // §4.6: 证据 ID 集合 — 用于差异诊断
      authorityEvidenceIds: authorityResolved
        ? extractEvidenceIds(authorityOutcome.resolution.controlPlaneEvidence)
        : undefined,
      projectionEvidenceIds: projectionResolved
        ? extractEvidenceIds(projectionOutcome.resolution.controlPlaneEvidence)
        : undefined,
    };

    // 记录差异日志（不记录敏感数据）
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

    // 决定使用哪个结果
    const outcome = config.useProjectionForExecution
      ? projectionOutcome
      : authorityOutcome;

    return { outcome, shadow };
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
    if (authority.resolution.controlPlaneEvidence.agentArtifactDigest !==
        projection.resolution.controlPlaneEvidence.agentArtifactDigest) {
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
function extractEvidenceIds(
  evidence: RouteControlPlaneEvidence,
): { attestationIds: string[]; publicationRecordIds: string[]; conformanceRunIds: string[] } {
  const attestationIds: string[] = [];
  const publicationRecordIds: string[] = [];
  const conformanceRunIds: string[] = [];

  // Agent Attestation IDs
  const agentAttIds = evidence.agentAttestationIds;
  if (Array.isArray(agentAttIds)) attestationIds.push(...agentAttIds.filter((id): id is string => typeof id === "string"));
  // Runtime Attestation IDs
  const runtimeAttIds = evidence.runtimeAttestationIds;
  if (Array.isArray(runtimeAttIds)) attestationIds.push(...runtimeAttIds.filter((id): id is string => typeof id === "string"));
  // Publication Record IDs
  if (typeof evidence.agentPublicationRecordId === "string" && evidence.agentPublicationRecordId) publicationRecordIds.push(evidence.agentPublicationRecordId);
  if (typeof evidence.runtimePublicationRecordId === "string" && evidence.runtimePublicationRecordId) publicationRecordIds.push(evidence.runtimePublicationRecordId);
  // Conformance Run IDs
  if (typeof evidence.conformanceRunId === "string" && evidence.conformanceRunId) conformanceRunIds.push(evidence.conformanceRunId);

  return { attestationIds, publicationRecordIds, conformanceRunIds };
}
