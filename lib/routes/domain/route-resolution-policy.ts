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

/**
 * 候选/解析的判别 target — 只含所选 target 自己的事实。
 * - runtime：只含 runtimeRevisionId。
 * - agent：只含 exact Agent 生产调用事实（endpoint/identity/credential/network）。
 */
export type RouteResolutionTarget =
  | { kind: "runtime"; runtimeRevisionId: string }
  | {
      kind: "agent";
      agentRevisionId: string;
      agentEndpointRef: string;
      agentIdentityMode: "none" | "bearer";
      agentCredentialRefId: string | null;
      agentNetworkZone: string;
    };

/**
 * 控制面证据 — 严格 runtime|agent 判别联合。
 * - runtime：只含 Runtime artifact/config/target/publication/conformance/attestation/capability 事实。
 * - agent：只含 AgentContract/Publication 事实（供 AgentCallBinding 冻结），不含 Runtime 字段或占位符。
 */
export type RouteEvidence =
  | {
      kind: "runtime";
      runtimeArtifactId: string | null;
      runtimeArtifactDigest: string | null;
      runtimeConfigDigest: string;
      /** Runtime 证据种类 — hosted 要求 artifact 全集；external 无 artifact（03 §3）。 */
      runtimeEvidenceKind: "hosted_artifact" | "external_endpoint";
      /** Runtime 目标摘要 — hosted/external 统一发布证据权威（03 §6）。 */
      runtimeTargetDigest: string;
      capabilityManifestDigest: string;
      runtimeAttestationIds: string[];
      runtimePublicationRecordId: string;
      conformanceRunId: string;
    }
  | {
      kind: "agent";
      agentContractSnapshotId: string;
      agentContractDigest: string;
      agentContextDigest: string;
      agentPublicationRecordId: string;
    };

interface RouteResolutionCandidateCommon {
  deploymentRouteId: string;
  routeSetId: string;
  routeSetVersionNo: number;
  routeRevisionId: string;
  routeRevisionNo: number;
  routeActivationId: string;
  routeActivationSequence: number;
  policyRevisionId: string | null;
  contentDigest: string;
  trafficWeight: number;
  routeGroupId: string;
  priorityNo: number;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  eligibilityConditions: unknown;
  activationState: "active" | "disabled";
  policyRevisionState: string | null;
  /** Projection 版本号 — 本 store 为 projection-only，候选/解析必须携带（resolve 成功须为正整数）。 */
  projectionVersionNo: number;
}

/**
 * 判别候选 — target 指定 runtime 或 agent，各自只携带本 target 的资格事实。
 * - runtime 候选不 inspect Agent 生命周期/发布/证据。
 * - agent 候选不 inspect Runtime 生命周期/发布/证据/conformance。
 */
export type RouteResolutionCandidate = RouteResolutionCandidateCommon &
  (
    | {
        target: { kind: "runtime"; runtimeRevisionId: string };
        runtimeLifecycleState: string;
        runtimeRevisionState: string;
        runtimePublicationActive: boolean;
        runtimeEvidenceValid: boolean;
        runtimeConformanceValid: boolean;
        controlPlaneEvidence: Extract<RouteEvidence, { kind: "runtime" }>;
      }
    | {
        target: {
          kind: "agent";
          agentRevisionId: string;
          agentEndpointRef: string;
          agentIdentityMode: "none" | "bearer";
          agentCredentialRefId: string | null;
          agentNetworkZone: string;
        };
        agentLifecycleState: string;
        agentRevisionState: string;
        agentPublicationActive: boolean;
        agentEvidenceValid: boolean;
        controlPlaneEvidence: Extract<RouteEvidence, { kind: "agent" }>;
      }
  );

interface RouteResolutionCommon {
  deploymentRouteId: string;
  routeSetId: string;
  routeSetVersionNo: number;
  routeRevisionId: string;
  routeRevisionNo: number;
  routeActivationId: string;
  routeActivationSequence: number;
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
  /** Projection 版本号（成功 projection 解析必须为正整数）。 */
  projectionVersionNo: number;
}

/** 判别解析结果 — 通过 target.kind 收窄对应 target 事实与控制面证据。 */
export type RouteResolution = RouteResolutionCommon &
  (
    | {
        target: { kind: "runtime"; runtimeRevisionId: string };
        controlPlaneEvidence: Extract<RouteEvidence, { kind: "runtime" }>;
      }
    | {
        target: {
          kind: "agent";
          agentRevisionId: string;
          agentEndpointRef: string;
          agentIdentityMode: "none" | "bearer";
          agentCredentialRefId: string | null;
          agentNetworkZone: string;
        };
        controlPlaneEvidence: Extract<RouteEvidence, { kind: "agent" }>;
      }
  );

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
  /** 显式解析目标 — {kind:"runtime"} 或 {kind:"agent", agentId}（冻结架构）。 */
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
    if (!isControlPlaneEligible(candidate, input.now, input.target)) return [];
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
    resolution: buildRouteResolution(selected, {
      tenantId: input.tenantId,
      target: input.target,
      routeScopeKey: input.routeScopeKey,
      businessKey: input.businessKey,
      attributes: input.attributes,
      threadDefaultModelRef: input.threadDefaultModelRef,
      routeGroupId: selectedGroupId,
      trafficBucket,
      resolutionKeyDigest,
      now: input.now,
    }),
    eligibleCandidateCount: group.length,
  };
}

function buildRouteResolution(
  selected: EligibleCandidate,
  ctx: {
    tenantId: string;
    target: RouteTarget;
    routeScopeKey: string;
    businessKey: { threadId?: string; jobId?: string };
    attributes: Record<string, RouteResolutionAttribute>;
    threadDefaultModelRef?: string | null;
    routeGroupId: string;
    trafficBucket: number;
    resolutionKeyDigest: string;
    now: Date;
  },
): RouteResolution {
  const c = selected.candidate;
  const common = {
    deploymentRouteId: c.deploymentRouteId,
    routeSetId: c.routeSetId,
    routeSetVersionNo: c.routeSetVersionNo,
    routeRevisionId: c.routeRevisionId,
    routeRevisionNo: c.routeRevisionNo,
    routeActivationId: c.routeActivationId,
    routeActivationSequence: c.routeActivationSequence,
    policyRevisionId: c.policyRevisionId,
    routeContentDigest: c.contentDigest,
    routeGroupId: ctx.routeGroupId,
    specificity: selected.specificity,
    priorityNo: c.priorityNo,
    trafficWeight: c.trafficWeight,
    trafficBucket: ctx.trafficBucket,
    resolutionKeyDigest: ctx.resolutionKeyDigest,
    resolutionInputDigest: computeResolutionInputDigest({
      tenantId: ctx.tenantId,
      target: ctx.target,
      routeScopeKey: ctx.routeScopeKey,
      businessKey: ctx.businessKey,
      attributes: ctx.attributes,
      threadDefaultModelRef: ctx.threadDefaultModelRef,
    }),
    resolvedAt: ctx.now,
    projectionVersionNo: requirePositiveProjectionVersionNo(c.projectionVersionNo),
  };
  if (isRuntimeCandidate(c)) {
    return {
      ...common,
      target: c.target,
      controlPlaneEvidence: cloneRuntimeEvidence(c.controlPlaneEvidence),
    };
  }
  if (isAgentCandidate(c)) {
    return {
      ...common,
      target: c.target,
      controlPlaneEvidence: cloneAgentEvidence(c.controlPlaneEvidence),
    };
  }
  // target 与证据 kind 矛盾（类型上不可能）→ fail-closed，不把另一分支证据带入结果。
  throw new Error("RouteResolver 候选 target 与控制面证据 kind 不一致");
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

/** 将显式 target 归一为唯一解析输入的 digest 规范形。 */
export function normalizeTarget(target: RouteTarget): unknown {
  return target.kind === "agent" ? target.agentId : null;
}

export function computeCapabilityManifestDigest(input: {
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

/**
 * nested 判别联合收窄 guard — target.kind 收窄无法自动关联 sibling target-specific
 * 字段与 controlPlaneEvidence，故用 type predicate 一次收窄整个候选到对应分支。
 * - runtime：证据必须是 runtime，target 必须是 runtime。
 * - agent：证据必须是 agent，target 必须是 agent。
 */
type RuntimeCandidate = Extract<RouteResolutionCandidate, { target: { kind: "runtime" } }>;
type AgentCandidate = Extract<RouteResolutionCandidate, { target: { kind: "agent" } }>;

function isRuntimeCandidate(candidate: RouteResolutionCandidate): candidate is RuntimeCandidate {
  return candidate.target.kind === "runtime" && candidate.controlPlaneEvidence.kind === "runtime";
}

function isAgentCandidate(candidate: RouteResolutionCandidate): candidate is AgentCandidate {
  return candidate.target.kind === "agent" && candidate.controlPlaneEvidence.kind === "agent";
}

function isControlPlaneEligible(
  candidate: RouteResolutionCandidate,
  now: Date,
  inputTarget: RouteTarget,
): boolean {
  // 候选 target kind 必须与输入 target kind 匹配（agent 只比较 kind：输入 agentId 为
  // 稳定身份，候选 target 携带 AgentRevision 身份，不比较 agentId 与 agentRevisionId）。
  if (candidate.target.kind !== inputTarget.kind) return false;
  // 成功 projection 解析必须携带正整数 projectionVersionNo（缺省/0/非整数不可 resolved）。
  if (!isPositiveProjectionVersionNo(candidate.projectionVersionNo)) return false;

  const commonEligible =
    candidate.activationState === "active" &&
    (!candidate.effectiveFrom || candidate.effectiveFrom <= now) &&
    (!candidate.effectiveUntil || candidate.effectiveUntil > now) &&
    (candidate.policyRevisionId === null || candidate.policyRevisionState === "published");

  // 用 type predicate 同时收窄 candidate.target 与其 sibling target-specific 事实与
  // controlPlaneEvidence（nested discriminant 无法由 target.kind 自动收窄兄弟字段）。
  if (isRuntimeCandidate(candidate)) {
    // Runtime 候选只 inspect Runtime 生命周期/发布/证据/conformance。
    return (
      commonEligible &&
      candidate.runtimeLifecycleState === "enabled" &&
      candidate.runtimeRevisionState === "published" &&
      candidate.runtimePublicationActive &&
      candidate.runtimeEvidenceValid &&
      candidate.runtimeConformanceValid
    );
  }

  // Agent 候选只 inspect Agent 生命周期/发布/证据，不 inspect 任何 Runtime 事实。
  if (isAgentCandidate(candidate)) {
    return (
      commonEligible &&
      candidate.agentLifecycleState === "enabled" &&
      candidate.agentRevisionState === "published" &&
      candidate.agentPublicationActive &&
      candidate.agentEvidenceValid
    );
  }

  // target 与证据 kind 矛盾（类型上不可能）→ fail-closed。
  return false;
}

function isPositiveProjectionVersionNo(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function requirePositiveProjectionVersionNo(value: number | undefined): number {
  if (!isPositiveProjectionVersionNo(value)) {
    throw new Error("RouteResolver 已选候选缺少正整数 projectionVersionNo");
  }
  return value;
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

function cloneRuntimeEvidence(
  evidence: Extract<RouteEvidence, { kind: "runtime" }>,
): Extract<RouteEvidence, { kind: "runtime" }> {
  return {
    ...evidence,
    runtimeAttestationIds: [...evidence.runtimeAttestationIds].sort(),
  };
}

function cloneAgentEvidence(
  evidence: Extract<RouteEvidence, { kind: "agent" }>,
): Extract<RouteEvidence, { kind: "agent" }> {
  return { ...evidence };
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
