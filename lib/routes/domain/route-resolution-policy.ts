import { createHash } from "node:crypto";

export const ROUTE_TRAFFIC_WEIGHT_TOTAL = 10_000;

export type RouteResolutionAttribute = string | number | boolean;

export interface RouteResolutionCandidate {
  deploymentRouteId: string;
  routeSetId: string;
  routeSetVersionNo: number;
  routeRevisionId: string;
  routeRevisionNo: number;
  routeActivationId: string;
  routeActivationSequence: number;
  agentRevisionId: string;
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
}

export interface RouteResolution {
  deploymentRouteId: string;
  routeSetId: string;
  routeSetVersionNo: number;
  routeRevisionId: string;
  routeRevisionNo: number;
  routeActivationId: string;
  routeActivationSequence: number;
  agentRevisionId: string;
  runtimeRevisionId: string;
  policyRevisionId: string | null;
  routeContentDigest: string;
  routeGroupId: string;
  specificity: number;
  priorityNo: number;
  trafficWeight: number;
  trafficBucket: number;
  resolutionKeyDigest: string;
  resolvedAt: Date;
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
      reason: "invalid_traffic_weight_total";
      eligibleCandidateCount: number;
      trafficWeightTotal: number;
    };

export interface ResolveRouteCandidatesInput {
  tenantId: string;
  agentId: string;
  routeScopeKey: string;
  businessKey: { threadId?: string; jobId?: string };
  attributes: Record<string, RouteResolutionAttribute>;
  candidates: RouteResolutionCandidate[];
  now: Date;
}

interface EligibleCandidate {
  candidate: RouteResolutionCandidate;
  specificity: number;
}

export function resolveRouteCandidates(input: ResolveRouteCandidatesInput): RouteResolutionOutcome {
  const executionKey = requireExecutionKey(input.businessKey);
  const eligible = input.candidates.flatMap((candidate): EligibleCandidate[] => {
    const specificity = eligibilitySpecificity(candidate.eligibilityConditions, input.attributes);
    if (specificity === null || !isControlPlaneEligible(candidate, input.now)) return [];
    return [{ candidate, specificity }];
  });
  if (eligible.length === 0) {
    return {
      status: "unresolved",
      reason: "no_eligible_route",
      evaluatedCandidateCount: input.candidates.length,
    };
  }

  eligible.sort(compareResolutionPrecedence);
  const highest = eligible[0];
  if (!highest) {
    throw new Error("RouteResolver eligible 集合异常为空");
  }
  const precedencePeers = eligible.filter(
    (item) =>
      item.specificity === highest.specificity &&
      item.candidate.priorityNo === highest.candidate.priorityNo &&
      item.candidate.routeRevisionNo === highest.candidate.routeRevisionNo,
  );
  const selectedGroupId = [
    ...new Set(precedencePeers.map((item) => item.candidate.routeGroupId)),
  ].sort((left, right) => left.localeCompare(right))[0];
  if (!selectedGroupId) throw new Error("RouteResolver traffic group 为空");
  const group = precedencePeers
    .filter((item) => item.candidate.routeGroupId === selectedGroupId)
    .sort((left, right) =>
      left.candidate.routeRevisionId.localeCompare(right.candidate.routeRevisionId),
    );
  const trafficWeightTotal = group.reduce((sum, item) => sum + item.candidate.trafficWeight, 0);
  if (
    trafficWeightTotal !== ROUTE_TRAFFIC_WEIGHT_TOTAL ||
    group.some(
      (item) => !Number.isInteger(item.candidate.trafficWeight) || item.candidate.trafficWeight < 0,
    )
  ) {
    return {
      status: "unresolved",
      reason: "invalid_traffic_weight_total",
      eligibleCandidateCount: group.length,
      trafficWeightTotal,
    };
  }

  const resolutionKeyDigest = computeResolutionKeyDigest({
    tenantId: input.tenantId,
    executionKey,
    agentId: input.agentId,
    routeGroupId: selectedGroupId,
  });
  const trafficBucket = hashBucket(resolutionKeyDigest, ROUTE_TRAFFIC_WEIGHT_TOTAL);
  let upperBound = 0;
  const selected = group.find((item) => {
    upperBound += item.candidate.trafficWeight;
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
      resolvedAt: input.now,
    },
    eligibleCandidateCount: group.length,
  };
}

export function computeResolutionKeyDigest(input: {
  tenantId: string;
  executionKey: string;
  agentId: string;
  routeGroupId: string;
}): string {
  const canonical = JSON.stringify([
    input.tenantId,
    input.executionKey,
    input.agentId,
    input.routeGroupId,
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function requireExecutionKey(businessKey: { threadId?: string; jobId?: string }): string {
  const threadId = businessKey.threadId?.trim();
  const jobId = businessKey.jobId?.trim();
  if (Boolean(threadId) === Boolean(jobId)) {
    throw new Error("RouteResolver businessKey 必须且只能提供 threadId 或 jobId");
  }
  return threadId ? `thread:${threadId}` : `job:${jobId}`;
}

function isControlPlaneEligible(candidate: RouteResolutionCandidate, now: Date): boolean {
  return (
    candidate.activationState === "active" &&
    (!candidate.effectiveFrom || candidate.effectiveFrom <= now) &&
    (!candidate.effectiveUntil || candidate.effectiveUntil > now) &&
    candidate.agentLifecycleState === "enabled" &&
    candidate.agentRevisionState === "published" &&
    candidate.agentPublicationActive &&
    candidate.agentEvidenceValid &&
    candidate.runtimeLifecycleState === "enabled" &&
    candidate.runtimeRevisionState === "published" &&
    candidate.runtimePublicationActive &&
    candidate.runtimeEvidenceValid &&
    candidate.runtimeConformanceValid &&
    (candidate.policyRevisionId === null || candidate.policyRevisionState === "published")
  );
}

function eligibilitySpecificity(
  rawConditions: unknown,
  attributes: Record<string, RouteResolutionAttribute>,
): number | null {
  if (!isPlainObject(rawConditions)) return null;
  const keys = Object.keys(rawConditions);
  if (keys.length === 0) return 0;
  if (keys.length !== 1 || keys[0] !== "all") return null;
  const all = rawConditions.all;
  if (!isPlainObject(all)) return null;
  const conditions = Object.entries(all);
  for (const [key, expected] of conditions) {
    if (!isScalar(expected) || attributes[key] !== expected) return null;
  }
  return conditions.length;
}

function compareResolutionPrecedence(left: EligibleCandidate, right: EligibleCandidate): number {
  return (
    right.specificity - left.specificity ||
    right.candidate.priorityNo - left.candidate.priorityNo ||
    right.candidate.routeRevisionNo - left.candidate.routeRevisionNo ||
    left.candidate.routeGroupId.localeCompare(right.candidate.routeGroupId) ||
    left.candidate.routeRevisionId.localeCompare(right.candidate.routeRevisionId)
  );
}

function hashBucket(digest: string, modulus: number): number {
  const value = BigInt(`0x${digest.slice("sha256:".length, "sha256:".length + 16)}`);
  return Number(value % BigInt(modulus));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): value is RouteResolutionAttribute {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
