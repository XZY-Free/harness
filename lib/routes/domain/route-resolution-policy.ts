import { createHash } from "node:crypto";
import {
 type NormalizedEligibility,
 computeSpecificity,
 isOverlapping,
 isTimeWindowOverlapping,
 normalizeEligibility,
} from "@/lib/routes/domain/route-selector";

export const ROUTE_TRAFFIC_WEIGHT_TOTAL = 10_000;

export type RouteResolutionAttribute = string | number | boolean;

export interface RouteControlPlaneEvidence {
 agentArtifactDigest: string;
 runtimeArtifactDigest: string;
 runtimeConfigDigest: string;
 capabilityManifestDigest: string;
 agentAttestationIds: string[];
 runtimeAttestationIds: string[];
 agentPublicationRecordId: string;
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
 controlPlaneEvidence: RouteControlPlaneEvidence | null;
 /** : Projection 版本号（仅 Projection 候选有值，Authority 候选为 undefined）。 */
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
 controlPlaneEvidence: RouteControlPlaneEvidence;
 /** : Projection 版本号（来自 RouteEligibilityProjection），用于 Binding 版本一致性校验。 */
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
 agentId: input.agentId,
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
 controlPlaneEvidence: cloneControlPlaneEvidence(
 requireControlPlaneEvidence(selected.candidate),
 ),
 /** : 从候选透传 Projection 版本号。 */
 projectionVersionNo: selected.candidate.projectionVersionNo,
 },
 eligibleCandidateCount: group.length,
 };
}

// ─── 导出工具 ──────────────────────────────────────────────

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

export function computeCapabilityManifestDigest(input: {
 agentRevisionId: string;
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
 candidate.controlPlaneEvidence !== null &&
 (candidate.policyRevisionId === null || candidate.policyRevisionState === "published")
 );
}

/**
 * 使用 RouteSelector.normalizeEligibility 的结果检查属性匹配。
 * 替代旧 eligibilitySpecificity 中内联的属性匹配逻辑。
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
 agentAttestationIds: [...evidence.agentAttestationIds].sort(),
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
