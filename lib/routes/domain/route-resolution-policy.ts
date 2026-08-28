import { createHash } from "node:crypto";
import { computeResolutionInputDigest } from "@/lib/routes/domain/resolution-input-digest";
import {
  type NormalizedEligibility,
  computeSpecificity,
  isOverlapping,
  isTimeWindowOverlapping,
  normalizeEligibility,
} from "@/lib/routes/domain/route-selector";

export const ROUTE_TRAFFIC_WEIGHT_TOTAL = 10_000;

export type RouteResolutionAttribute = string | number | boolean;

/**
 * Route 解析目标 — 显式判别，禁止再用 agentConstraint?: string|null 隐式表达。
 * - { kind: "runtime" }：解析基础 Harness Runtime Route（顶层执行目标）。
 * - { kind: "agent", agentId }：解析指定 Agent 能力 Route（Harness 调用 Agent）。
 * 仍只有一套 Route Authority；target 只区分解析目标。
 */
export type RouteTarget = { kind: "runtime" } | { kind: "agent"; agentId: string };

/** 从显式 target 提取解析用的 agent 约束 ID（runtime 为 null）。 */
export function targetToAgentId(target: RouteTarget): string | null {
  return target.kind === "agent" ? target.agentId : null;
}

export interface RouteControlPlaneEvidence {
  /** null = 基础 Harness Route（无 Agent 资产约束，Agent Evidence not_applicable，§18）。 */
  agentRevisionId: string | null;
  runtimeArtifactId: string | null;
  runtimeArtifactDigest: string | null;
  runtimeConfigDigest: string;
  /** Runtime 证据种类 — hosted 要求 artifact 全集；external 无 artifact（03 §3）。 */
  runtimeEvidenceKind: "hosted_artifact" | "external_endpoint";
  /** Runtime 目标摘要 — hosted/external 统一发布证据权威（03 §6）。 */
  runtimeTargetDigest: string;
  capabilityManifestDigest: string;
  /** Agent Contract 证据（Agent Route 必填，base route 为 null — 05 §5）。 */
  agentContractSnapshotId: string | null;
  agentContractDigest: string | null;
  agentContextDigest: string | null;
  runtimeAttestationIds: string[];
  /** null = 基础 Harness Route（§18 not_applicable）。 */
  agentPublicationRecordId: string | null;
  runtimePublicationRecordId: string;
  conformanceRunId: string;
}

export interface RouteResolutionCandidate {
  deploymentRouteId: string;
  routeSetId: string;
  routeSetVersionNo: number;
  routeRevisionId: string;
  routeRevisionNo: number;
  routeActivationId: string;
  routeActivationSequence: number;
  /** 显式目标类型 — runtime 或 agent，禁止隐式 null 猜测。 */
  targetKind: "runtime" | "agent";
  /**
   * 绑定的 AgentRevision ID。
   * runtime 为 null；agent 必填。
   */
  agentRevisionId: string | null;
  runtimeRevisionId: string;
  policyRevisionId: string | null;
  contentDigest: string;
  trafficWeight: number;
  routeGroupId: string;
  priorityNo: number;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  eligibilityConditions: unknown;
  activationState: "active" | "disabled";
  agentLifecycleState: string;
  agentRevisionState: string;
  agentPublicationActive: boolean;
  agentEvidenceValid: boolean;
  runtimeLifecycleState: string;
  runtimeRevisionState: string;
  runtimePublicationActive: boolean;
  runtimeEvidenceValid: boolean;
  runtimeConformanceValid: boolean;
  policyRevisionState: string | null;
  /** 控制面证据（恒非空；base route 的 agent 字段为 null，§18）。 */
  controlPlaneEvidence: RouteControlPlaneEvidence;
  /** Projection 版本号（仅 Projection 候选有值，Authority 候选为 undefined）。 */
  projectionVersionNo?: number;
}

export interface RouteResolution {
  deploymentRouteId: string;
  routeSetId: string;
  routeSetVersionNo: number;
  routeRevisionId: string;
  routeRevisionNo: number;
  routeActivationId: string;
  routeActivationSequence: number;
  /** 显式目标类型 — runtime 或 agent。 */
  targetKind: "runtime" | "agent";
  /**
   * 绑定的 AgentRevision ID。
   * runtime 为 null；agent 必填。
   */
  agentRevisionId: string | null;
  runtimeRevisionId: string;
  policyRevisionId: string | null;
  routeContentDigest: string;
  routeGroupId: string;
  specificity: number;
  priorityNo: number;
  trafficWeight: number;
  trafficBucket: number;
  resolutionKeyDigest: string;
  resolutionInputDigest: string;
  resolvedAt: Date;
  /**
   * 控制面证据（恒非空）。
   * 基础 Harness Route（targetKind=runtime，agentRevisionId=null）→ agent 字段为 null
   * （Agent Evidence not_applicable，§18），Runtime 字段始终填充；Agent Route → 完整成组（§7.4）。
   */
  controlPlaneEvidence: RouteControlPlaneEvidence;
  /** Projection 版本号（来自 RouteEligibilityProjection），用于 Binding 版本一致性校验。 */
  projectionVersionNo?: number;
}

export type RouteResolutionOutcome =
  | {
      status: "resolved";
      resolution: RouteResolution;
      eligibleCandidateCount: number;
    }
  | {
      status: "unresolved";
      reason: "no_eligible_route";
      evaluatedCandidateCount: number;
    }
  | {
      status: "unresolved";
      reason: "ambiguous_route_configuration";
      eligibleCandidateCount: number;
      groupIds: string[];
    }
  | {
      status: "unresolved";
      reason: "invalid_traffic_weight_total";
      eligibleCandidateCount: number;
      trafficWeightTotal: number;
    };

export interface ResolveRouteCandidatesInput {
  tenantId: string;
  /** 显式解析目标 — {kind:"runtime"} 或 {kind:"agent", agentId}（专题01 冻结架构）。 */
  target: RouteTarget;
  routeScopeKey: string;
  businessKey: { threadId?: string; jobId?: string };
  attributes: Record<string, RouteResolutionAttribute>;
  threadDefaultModelRef?: string | null;
  candidates: RouteResolutionCandidate[];
  now: Date;
}

interface EligibleCandidate {
  candidate: RouteResolutionCandidate;
  specificity: number;
  normalizedEligibility: NormalizedEligibility;
}

/**
 * RouteResolver 正式裁决（任务 1.7 修正后）。
 *
 * 1. 过滤不匹配或无资格候选
 * 2. 找最高 Specificity
 * 3. 在其中找最高 Priority
 * 4. 剩余候选必须属于同一个 Route Group（否则 ambiguous_route_configuration）
 * 5. Group 权重必须合计 10000
 * 6. 按 deploymentRouteId 稳定排序
 * 7. 使用 Business Key 稳定 Bucket
 */
export function resolveRouteCandidates(input: ResolveRouteCandidatesInput): RouteResolutionOutcome {
  const executionKey = requireExecutionKey(input.businessKey);

  // 1. 过滤不匹配或无资格候选，使用 RouteSelector 统一规范化
  const eligible = input.candidates.flatMap((candidate): EligibleCandidate[] => {
    if (!isControlPlaneEligible(candidate, input.now)) return [];
    const normalized = normalizeEligibility(candidate.eligibilityConditions);
    if (!normalized) return [];
    // 检查 eligibility 条件是否匹配输入属性
    if (!eligibilityMatches(normalized, input.attributes)) return [];
    const specificity = computeSpecificity(normalized);
    return [{ candidate, specificity, normalizedEligibility: normalized }];
  });

  if (eligible.length === 0) {
    return {
      status: "unresolved",
      reason: "no_eligible_route",
      evaluatedCandidateCount: input.candidates.length,
    };
  }

  // 2. 找最高 Specificity
  const maxSpecificity = Math.max(...eligible.map((e) => e.specificity));
  const bySpecificity = eligible.filter((e) => e.specificity === maxSpecificity);

  // 3. 在其中找最高 Priority
  const maxPriority = Math.max(...bySpecificity.map((e) => e.candidate.priorityNo));
  const peers = bySpecificity.filter((e) => e.candidate.priorityNo === maxPriority);

  // 4. 剩余候选必须属于同一个 Route Group
  const groupIds = [...new Set(peers.map((e) => e.candidate.routeGroupId))];
  if (groupIds.length > 1) {
    return {
      status: "unresolved",
      reason: "ambiguous_route_configuration",
      eligibleCandidateCount: peers.length,
      groupIds,
    };
  }
  const selectedGroupId = groupIds[0];
  if (!selectedGroupId) throw new Error("RouteResolver traffic group 为空");

  const group = peers.filter((e) => e.candidate.routeGroupId === selectedGroupId);

  // 5. Group 权重必须合计 10000
  const trafficWeightTotal = group.reduce((sum, e) => sum + e.candidate.trafficWeight, 0);
  if (
    trafficWeightTotal !== ROUTE_TRAFFIC_WEIGHT_TOTAL ||
    group.some((e) => !Number.isInteger(e.candidate.trafficWeight) || e.candidate.trafficWeight < 0)
  ) {
    return {
      status: "unresolved",
      reason: "invalid_traffic_weight_total",
      eligibleCandidateCount: group.length,
      trafficWeightTotal,
    };
  }

  // 6. 按 deploymentRouteId 稳定排序
  group.sort((left, right) =>
    left.candidate.deploymentRouteId.localeCompare(right.candidate.deploymentRouteId),
  );

  // 7. 使用 Business Key 稳定 Bucket
  const resolutionKeyDigest = computeResolutionKeyDigest({
    tenantId: input.tenantId,
    executionKey,
    target: input.target,
    routeGroupId: selectedGroupId,
  });
  const trafficBucket = hashBucket(resolutionKeyDigest, ROUTE_TRAFFIC_WEIGHT_TOTAL);
  let upperBound = 0;
  const selected = group.find((e) => {
    upperBound += e.candidate.trafficWeight;
    return trafficBucket < upperBound;
  });
  if (!selected) {
    throw new Error("RouteResolver 权重桶未命中候选路由");
  }

  return {
    status: "resolved",
    resolution: {
      deploymentRouteId: selected.candidate.deploymentRouteId,
      routeSetId: selected.candidate.routeSetId,
      routeSetVersionNo: selected.candidate.routeSetVersionNo,
      routeRevisionId: selected.candidate.routeRevisionId,
      routeRevisionNo: selected.candidate.routeRevisionNo,
      routeActivationId: selected.candidate.routeActivationId,
      routeActivationSequence: selected.candidate.routeActivationSequence,
      targetKind: selected.candidate.targetKind,
      agentRevisionId: selected.candidate.agentRevisionId,
      runtimeRevisionId: selected.candidate.runtimeRevisionId,
      policyRevisionId: selected.candidate.policyRevisionId,
      routeContentDigest: selected.candidate.contentDigest,
      routeGroupId: selectedGroupId,
      specificity: selected.specificity,
      priorityNo: selected.candidate.priorityNo,
      trafficWeight: selected.candidate.trafficWeight,
      trafficBucket,
      resolutionKeyDigest,
      resolutionInputDigest: computeResolutionInputDigest({
        tenantId: input.tenantId,
        target: input.target,
        routeScopeKey: input.routeScopeKey,
        businessKey: input.businessKey,
        attributes: input.attributes,
        threadDefaultModelRef: input.threadDefaultModelRef,
      }),
      resolvedAt: input.now,
      // 控制面证据恒非空。基础 Harness Route（agentRevisionId=null）的 agent 字段
      // 由 loader 填 null（§18 Agent Evidence not_applicable）；Runtime 字段始终填充。
      // Agent Route → 完整控制面证据。
      controlPlaneEvidence: cloneControlPlaneEvidence(
        requireControlPlaneEvidence(selected.candidate),
      ),
      /** 从候选透传 Projection 版本号。 */
      projectionVersionNo: selected.candidate.projectionVersionNo,
    },
    eligibleCandidateCount: group.length,
  };
}

// ─── 导出工具 ──────────────────────────────────────────────

export function computeResolutionKeyDigest(input: {
  tenantId: string;
  executionKey: string;
  /** 显式解析目标 — runtime 与不同 agent 产生不同 digest（§8.4）。 */
  target: RouteTarget;
  routeGroupId: string;
}): string {
  const canonical = JSON.stringify([
    input.tenantId,
    input.executionKey,
    normalizeTarget(input.target),
    input.routeGroupId,
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** 将显式 target 归一为 digest 规范形（与 agentConstraint 语义保持 digest 兼容）。 */
export function normalizeTarget(target: RouteTarget): unknown {
  return target.kind === "agent" ? target.agentId : null;
}

export function computeCapabilityManifestDigest(input: {
  /** 无 Agent 约束为 null（基础 Harness Route），不参与能力兼容。 */
  agentRevisionId: string | null;
  agentInterfaceRequirements: unknown;
  runtimeRevisionId: string;
  runtimeCapabilities: unknown;
}): string {
  const canonical = JSON.stringify(sortKeys(input));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

// ─── 内部工具 ──────────────────────────────────────────────

function requireExecutionKey(businessKey: { threadId?: string; jobId?: string }): string {
  const threadId = businessKey.threadId?.trim();
  const jobId = businessKey.jobId?.trim();
  if (Boolean(threadId) === Boolean(jobId)) {
    throw new Error("RouteResolver businessKey 必须且只能提供 threadId 或 jobId");
  }
  return threadId ? `thread:${threadId}` : `job:${jobId}`;
}

function isControlPlaneEligible(candidate: RouteResolutionCandidate, now: Date): boolean {
  // Runtime Evidence 无条件必填（§12/§10.2），无 Agent Route 也必须满足。
  // controlPlaneEvidence 恒非空；Agent 维度仅 Agent Route 参与资格判断（§7.4），
  // 基础 Harness Route 不要求（Agent Evidence not_applicable，§18，运行时证据已由下方布尔标志独立校验）。
  const runtimeEligible =
    candidate.runtimeLifecycleState === "enabled" &&
    candidate.runtimeRevisionState === "published" &&
    candidate.runtimePublicationActive &&
    candidate.runtimeEvidenceValid &&
    candidate.runtimeConformanceValid &&
    (candidate.policyRevisionId === null || candidate.policyRevisionState === "published");

  if (candidate.targetKind === "runtime") {
    // 基础 Harness Route：无 Agent 资产约束，Agent Evidence 为 not_applicable（§18），
    // 不参与资格判断，也不伪装成 passed。仅需 Runtime 证据。
    return (
      candidate.activationState === "active" &&
      (!candidate.effectiveFrom || candidate.effectiveFrom <= now) &&
      (!candidate.effectiveUntil || candidate.effectiveUntil > now) &&
      runtimeEligible
    );
  }

  // Agent Route：Agent Evidence 完整成组必填（§7.4）。
  return (
    candidate.activationState === "active" &&
    (!candidate.effectiveFrom || candidate.effectiveFrom <= now) &&
    (!candidate.effectiveUntil || candidate.effectiveUntil > now) &&
    candidate.agentLifecycleState === "enabled" &&
    candidate.agentRevisionState === "published" &&
    candidate.agentPublicationActive &&
    candidate.agentEvidenceValid &&
    candidate.controlPlaneEvidence !== null &&
    runtimeEligible
  );
}

/**
 * 使用 RouteSelector.normalizeEligibility 的结果检查属性匹配。
 * 集中封装属性匹配逻辑，供 eligibilitySpecificity 与路由裁决复用。
 */
function eligibilityMatches(
  normalized: NormalizedEligibility,
  attributes: Record<string, RouteResolutionAttribute>,
): boolean {
  for (const [key, expected] of Object.entries(normalized.all)) {
    if (attributes[key] !== expected) return false;
  }
  return true;
}

function requireControlPlaneEvidence(
  candidate: RouteResolutionCandidate,
): RouteControlPlaneEvidence {
  if (!candidate.controlPlaneEvidence) {
    throw new Error("RouteResolver 已选候选缺少控制面证据");
  }
  return candidate.controlPlaneEvidence;
}

function cloneControlPlaneEvidence(evidence: RouteControlPlaneEvidence): RouteControlPlaneEvidence {
  return {
    ...evidence,
    runtimeAttestationIds: [...evidence.runtimeAttestationIds].sort(),
  };
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function hashBucket(digest: string, modulus: number): number {
  const value = BigInt(`0x${digest.slice("sha256:".length, "sha256:".length + 16)}`);
  return Number(value % BigInt(modulus));
}
