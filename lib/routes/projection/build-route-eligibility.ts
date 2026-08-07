/**
 * Route Eligibility Projection 构建器。
 *
 * /: 使用统一 RevisionExecutionEligibilityPolicy + Reader，
 * 构建器只做：读取 Snapshot → 调用 Policy → 组装 Projection → 计算 Digest → 幂等 UPSERT。
 *
 * : 投影版本规则：
 * - 现有行不存在 → projectionVersionNo = 1
 * - Digest 相同 → 不增加版本
 * - Digest 变化 → projectionVersionNo + 1
 *
 * 权威事实：RouteRevision, RouteActivation, Agent/AgentRevision,
 * Runtime/RuntimeRevision, PublicationRecord, Attestation, Conformance, Policy。
 * 投影不是新的权威事实源。
 */

import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { deploymentRouteSetTable, deploymentRouteTable } from "@/lib/persistence/schema/routes";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { computeSpecificity, normalizeEligibility } from "@/lib/routes/domain/route-selector";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { RouteEligibilityStore, UpsertProjectionInput } from "./route-eligibility-store";

// §03: 统一 Policy + Reader（从 control-plane/domain）
import {
 RevisionExecutionEligibilityPolicy,
 extractRequiredCapabilities,
} from "@/lib/control-plane/domain/revision-execution-eligibility";
import {
 createMySqlRevisionExecutionEvidenceReader,
} from "@/lib/control-plane/persistence/mysql-revision-execution-evidence-reader";

export interface BuildProjectionDependencies {
 store: RouteEligibilityStore;
}

export interface BuildRouteEligibilityInput {
 tenantId: string;
 routeId: string;
 /** : 来源事件信息，用于权威版本计算。 */
 sourceEventId?: string | null;
 sourceAggregateVersion?: number | null;
}

export interface BuildRouteEligibilityResult {
 routeId: string;
 eligibilityState: "eligible" | "ineligible" | "pending_rebuild";
 projectionVersionNo: number;
}

/**
 * 创建 Projection 构建器。
 *
 * /: 构建器使用统一 Reader 加载证据 + 统一 Policy 判断资格，
 * 计算 projectionContentDigest 实现幂等版本。
 */
export function createBuildRouteEligibility(deps: BuildProjectionDependencies) {
 return async function buildRouteEligibility(
 input: BuildRouteEligibilityInput,
 ): Promise<BuildRouteEligibilityResult> {
 const now = new Date();

 // 1. 查找 DeploymentRoute
 const [route] = await db
 .select()
 .from(deploymentRouteTable)
 .where(eq(deploymentRouteTable.id, input.routeId))
 .limit(1);
 if (!route) {
 // : Route 不存在 → 删除孤立投影
 await deps.store.deleteProjection(input.routeId);
 return { routeId: input.routeId, eligibilityState: "ineligible", projectionVersionNo: 0 };
 }

 // 2. 查找 RouteSet（获取 agentId, routeScopeKey）
 const [routeSet] = await db
 .select()
 .from(deploymentRouteSetTable)
 .where(eq(deploymentRouteSetTable.id, route.routeSetId))
 .limit(1);
 if (!routeSet) {
 // : RouteSet 不存在 → 删除孤立投影
 await deps.store.deleteProjection(input.routeId);
 return { routeId: input.routeId, eligibilityState: "ineligible", projectionVersionNo: 0 };
 }

 // 3. 没有 activeRouteRevisionId → ineligible
 if (!route.activeRouteRevisionId) {
 const digest = computeProjectionContentDigest(baseIneligibleFields(route, routeSet));
 const existing = await deps.store.getProjectionByRoute(input.routeId);
 const version = computeNextVersion(existing, digest);
 await deps.store.upsertProjection({
 ...baseIneligible(route, routeSet),
 projectionContentDigest: digest,
 eligibilityState: "ineligible",
 projectionVersionNo: version,
 lastRebuiltAt: now,
 });
 return {
 routeId: input.routeId,
 eligibilityState: "ineligible",
 projectionVersionNo: version,
 };
 }

 // 4. 读取 RouteRevision
 const [revision] = await db
 .select()
 .from(routeRevision)
 .where(
 and(
 eq(routeRevision.id, route.activeRouteRevisionId),
 eq(routeRevision.tenantId, input.tenantId),
 ),
 )
 .limit(1);
 if (!revision) {
 const digest = computeProjectionContentDigest(baseIneligibleFields(route, routeSet));
 const existing = await deps.store.getProjectionByRoute(input.routeId);
 const version = computeNextVersion(existing, digest);
 await deps.store.upsertProjection({
 ...baseIneligible(route, routeSet),
 projectionContentDigest: digest,
 eligibilityState: "ineligible",
 projectionVersionNo: version,
 lastRebuiltAt: now,
 });
 return {
 routeId: input.routeId,
 eligibilityState: "ineligible",
 projectionVersionNo: version,
 };
 }

 // 5. 读取 RouteActivation
 const [activation] = await db
 .select()
 .from(routeActivation)
 .where(eq(routeActivation.routeId, route.id))
 .orderBy(desc(routeActivation.activationSequence))
 .limit(1);
 if (!activation || activation.routeRevisionId !== revision.id) {
 const digest = computeProjectionContentDigest(baseIneligibleFields(route, routeSet));
 const existing = await deps.store.getProjectionByRoute(input.routeId);
 const version = computeNextVersion(existing, digest);
 await deps.store.upsertProjection({
 ...baseIneligible(route, routeSet),
 projectionContentDigest: digest,
 eligibilityState: "ineligible",
 projectionVersionNo: version,
 lastRebuiltAt: now,
 });
 return {
 routeId: input.routeId,
 eligibilityState: "ineligible",
 projectionVersionNo: version,
 };
 }

 // 6. 读取 Agent + AgentRevision + Runtime + RuntimeRevision（权威事实）
 const [agent, agentRevision, runtimeRevision] = await Promise.all([
 db
 .select()
 .from(agentTable)
 .where(and(eq(agentTable.id, routeSet.agentId), isNull(agentTable.deletedAt)))
 .limit(1)
 .then((r) => r[0] ?? null),
 db
 .select()
 .from(agentRevisionTable)
 .where(eq(agentRevisionTable.id, revision.agentRevisionId))
 .limit(1)
 .then((r) => r[0] ?? null),
 db
 .select()
 .from(runtimeRevisionTable)
 .where(eq(runtimeRevisionTable.id, revision.runtimeRevisionId))
 .limit(1)
 .then((r) => r[0] ?? null),
 ]);

 const [runtime] =
 agent && runtimeRevision
 ? await db
 .select()
 .from(runtimeTable)
 .where(
 and(eq(runtimeTable.id, runtimeRevision.runtimeId), isNull(runtimeTable.deletedAt)),
 )
 .limit(1)
 : [null];

 // §03: 7. 使用统一 Reader 加载完整证据快照
 const evidenceReader = createMySqlRevisionExecutionEvidenceReader({ db });
 const evidenceSnapshot = await evidenceReader.loadCurrentEvidence({
 tenantId: input.tenantId,
 agentRevisionId: revision.agentRevisionId,
 runtimeRevisionId: revision.runtimeRevisionId,
 policyRevisionId: revision.policyRevisionId,
 });

 // §03: 8. 从 AgentRevision 提取 requiredCapabilities（fail-closed）
 const requiredCapabilities = extractRequiredCapabilities(
 agentRevision?.agentInterfaceRequirementsJson,
 );

 // §03: 9. 使用统一 Policy 判断资格
 const eligibilityResult = RevisionExecutionEligibilityPolicy.isEligible(
 evidenceSnapshot,
 requiredCapabilities,
 );
 const isEligible = eligibilityResult.eligible;

 // Policy revision state for projection
 const policyRevisionState = evidenceSnapshot.policyRequirement.kind === "referenced"
  ? evidenceSnapshot.policyRequirement.policyRevision.revisionState
  : null;

 // 收集 ineligibility 原因
 const ineligibilityReasons: string[] = [];
 if (!agent) ineligibilityReasons.push("agent_not_found");
 if (!agentRevision) ineligibilityReasons.push("agent_revision_not_found");
 if (!runtime) ineligibilityReasons.push("runtime_not_found");
 if (!runtimeRevision) ineligibilityReasons.push("runtime_revision_not_found");
 if (activation.activationState !== "active") ineligibilityReasons.push("activation_not_active");
 // 从统一 Policy 错误中提取原因
 for (const err of eligibilityResult.errors) {
 ineligibilityReasons.push(err.code);
 }

 // 10. 计算选择属性
 const normalized = normalizeEligibility(revision.eligibilityConditionsJson);
 const specificity = normalized ? computeSpecificity(normalized) : 0;

 const capabilityCompatibilityDigest =
 agentRevision && runtimeRevision
 ? computeCapabilityManifestDigest({
 agentRevisionId: agentRevision.id,
 agentInterfaceRequirements: agentRevision.agentInterfaceRequirementsJson,
 runtimeRevisionId: runtimeRevision.id,
 runtimeCapabilities: runtimeRevision.runtimeCapabilitiesJson,
 })
 : "sha256:0000000000000000000000000000000000000000000000000000000000000000";

 // §03: 从统一 Snapshot 提取布尔字段
 const agentPublicationActive = evidenceSnapshot.agentPublication ? 1 : 0;
 const agentEvidenceValid =
 evidenceSnapshot.agentArtifactEvidence?.verificationState === "verified" &&
 evidenceSnapshot.agentArtifactEvidence.revokedAt === null
 ? 1
 : 0;
 const runtimePublicationActive = evidenceSnapshot.runtimePublication ? 1 : 0;
 const runtimeEvidenceValid =
 evidenceSnapshot.runtimeArtifactEvidence?.verificationState === "verified" &&
 evidenceSnapshot.runtimeArtifactEvidence.revokedAt === null
 ? 1
 : 0;
 // Conformance: 从 Policy 错误判断
 const runtimeConformanceValid = eligibilityResult.errors.some(
 (e) => e.dimension === "runtime_conformance",
 )
 ? 0
 : 1;

 // : 11. 计算 projectionContentDigest 并确定版本号
 const projectionFields = {
 routeId: route.id,
 tenantId: input.tenantId,
 agentId: routeSet.agentId,
 routeSetId: routeSet.id,
 routeScopeKey: routeSet.routeScopeKey,
 routeSetVersionNo: activation.routeSetVersionNo,
 routeRevisionId: revision.id,
 routeRevisionNo: revision.revisionNo,
 routeActivationId: activation.id,
 routeActivationSequence: activation.activationSequence,
 routeGroupId: readRouteGroupId(
 revision.routeGroupId,
 revision.trafficAllocationJson,
 routeSet.id,
 ),
 selectorDigest: revision.selectorDigest,
 eligibilityConditionsJson: revision.eligibilityConditionsJson,
 specificity,
 priorityNo: revision.priorityNo,
 trafficWeight: revision.trafficWeight,
 effectiveFrom: revision.effectiveFrom?.toISOString() ?? null,
 effectiveUntil: revision.effectiveUntil?.toISOString() ?? null,
 agentRevisionId: revision.agentRevisionId,
 agentRevisionState: agentRevision?.revisionState ?? "missing",
 agentLifecycleState: agent?.lifecycleState ?? "missing",
 agentPublicationActive,
 agentEvidenceValid,
 runtimeRevisionId: revision.runtimeRevisionId,
 runtimeRevisionState: runtimeRevision?.revisionState ?? "missing",
 runtimeLifecycleState: runtime?.lifecycleState ?? "missing",
 runtimePublicationActive,
 runtimeEvidenceValid,
 runtimeConformanceValid,
 policyRevisionId: revision.policyRevisionId,
 policyRevisionState,
 capabilityCompatibilityDigest,
 agentArtifactDigest: agentRevision?.artifactDigest ?? null,
 runtimeArtifactDigest: runtimeRevision?.artifactDigest ?? null,
 runtimeConfigDigest: runtimeRevision?.configHash ?? null,
 routeContentDigest: revision.contentDigest,
 agentPublicationRecordId: evidenceSnapshot.agentPublication?.publicationRecordId ?? null,
 runtimePublicationRecordId: evidenceSnapshot.runtimePublication?.publicationRecordId ?? null,
 agentAttestationIds: evidenceSnapshot.agentPublication?.attestationIds ?? null,
 runtimeAttestationIds: evidenceSnapshot.runtimePublication?.attestationIds ?? null,
 conformanceRunId: evidenceSnapshot.runtimePublication?.conformanceRunId ?? null,
 agentArtifactId: evidenceSnapshot.agentArtifactEvidence?.artifactId ?? null,
 runtimeArtifactId: evidenceSnapshot.runtimeArtifactEvidence?.artifactId ?? null,
 invalidReason: isEligible ? null : ineligibilityReasons.join(","),
 eligibilityState: (isEligible ? "eligible" : "ineligible") as "eligible" | "ineligible",
 };

 const projectionContentDigest = computeProjectionContentDigest(projectionFields);
 const existing = await deps.store.getProjectionByRoute(input.routeId);
 const projectionVersionNo = computeNextVersion(existing, projectionContentDigest);

 const projectionInput: UpsertProjectionInput = {
 ...projectionFields,
 effectiveFrom: revision.effectiveFrom,
 effectiveUntil: revision.effectiveUntil,
 projectionContentDigest,
 projectionVersionNo,
 lastRebuiltAt: now,
 // §06: 事件元数据存入 DB 但不参与 Digest 计算
 sourceEventId: input.sourceEventId ?? null,
 sourceAggregateVersion: input.sourceAggregateVersion ?? null,
 };

 await deps.store.upsertProjection(projectionInput);
 return {
 routeId: input.routeId,
 eligibilityState: isEligible ? "eligible" : "ineligible",
 projectionVersionNo,
 };
 };
}

// ─── : projectionContentDigest 计算 ──────────────────────

/**
 * 计算投影内容摘要 — 对所有投影字段规范化后 SHA-256。
 * 相同权威事实必须产生相同 digest，不同事实必须产生不同 digest。
 */
export function computeProjectionContentDigest(fields: Record<string, unknown>): string {
 const canonical = JSON.stringify(fields, Object.keys(fields).sort());
 const hash = createHash("sha256").update(canonical).digest("hex");
 return `sha256:${hash}`;
}

/**
 * : Digest-based 版本规则。
 *
 * - 现有行不存在 → projectionVersionNo = 1
 * - Digest 相同 → 不增加版本（返回现有版本）
 * - Digest 变化 → projectionVersionNo + 1
 */
export function computeNextVersion(
 existing: { projectionVersionNo: number; projectionContentDigest: string } | null,
 newDigest: string,
): number {
 if (!existing) return 1;
 if (existing.projectionContentDigest === newDigest) return existing.projectionVersionNo;
 return existing.projectionVersionNo + 1;
}

// ─── 内部工具 ──────────────────────────────────────────────

/** 返回 ineligible 投影的可 digest 字段（不含 Date 对象）。 */
function baseIneligibleFields(
 route: { id: string; routeSetId: string; tenantId?: string },
 routeSet: { agentId: string; routeScopeKey: string },
): Record<string, unknown> {
 return {
 routeId: route.id,
 tenantId: route.tenantId ?? "",
 agentId: routeSet.agentId,
 routeSetId: route.routeSetId,
 routeScopeKey: routeSet.routeScopeKey,
 routeSetVersionNo: 0,
 routeRevisionId: "",
 routeRevisionNo: 0,
 routeActivationId: "",
 routeActivationSequence: 0,
 routeGroupId: "primary",
 selectorDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
 eligibilityConditionsJson: {},
 specificity: 0,
 priorityNo: 0,
 trafficWeight: 0,
 effectiveFrom: null,
 effectiveUntil: null,
 agentRevisionId: "",
 agentRevisionState: "missing",
 agentLifecycleState: "missing",
 agentPublicationActive: 0,
 agentEvidenceValid: 0,
 runtimeRevisionId: "",
 runtimeRevisionState: "missing",
 runtimeLifecycleState: "missing",
 runtimePublicationActive: 0,
 runtimeEvidenceValid: 0,
 runtimeConformanceValid: 0,
 policyRevisionId: null,
 policyRevisionState: null,
 capabilityCompatibilityDigest:
 "sha256:0000000000000000000000000000000000000000000000000000000000000000",
 agentArtifactDigest: null,
 runtimeArtifactDigest: null,
 runtimeConfigDigest: null,
 routeContentDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
 agentPublicationRecordId: null,
 runtimePublicationRecordId: null,
 agentAttestationIds: null,
 runtimeAttestationIds: null,
 conformanceRunId: null,
 agentArtifactId: null,
 runtimeArtifactId: null,
 sourceEventId: null,
 sourceAggregateVersion: null,
 invalidReason: "base_ineligible",
 eligibilityState: "ineligible",
 };
}

function baseIneligible(
 route: { id: string; routeSetId: string; tenantId?: string },
 routeSet: { agentId: string; routeScopeKey: string },
): Omit<UpsertProjectionInput, "projectionContentDigest" | "eligibilityState" | "projectionVersionNo" | "lastRebuiltAt"> {
 return {
 routeId: route.id,
 tenantId: route.tenantId ?? "",
 agentId: routeSet.agentId,
 routeSetId: route.routeSetId,
 routeScopeKey: routeSet.routeScopeKey,
 routeSetVersionNo: 0,
 routeRevisionId: "",
 routeRevisionNo: 0,
 routeActivationId: "",
 routeActivationSequence: 0,
 routeGroupId: "primary",
 selectorDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
 eligibilityConditionsJson: {},
 specificity: 0,
 priorityNo: 0,
 trafficWeight: 0,
 effectiveFrom: null,
 effectiveUntil: null,
 agentRevisionId: "",
 agentRevisionState: "missing",
 agentLifecycleState: "missing",
 agentPublicationActive: 0,
 agentEvidenceValid: 0,
 runtimeRevisionId: "",
 runtimeRevisionState: "missing",
 runtimeLifecycleState: "missing",
 runtimePublicationActive: 0,
 runtimeEvidenceValid: 0,
 runtimeConformanceValid: 0,
 policyRevisionId: null,
 policyRevisionState: null,
 capabilityCompatibilityDigest:
 "sha256:0000000000000000000000000000000000000000000000000000000000000000",
 agentArtifactDigest: null,
 runtimeArtifactDigest: null,
 runtimeConfigDigest: null,
 routeContentDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
 agentPublicationRecordId: null,
 runtimePublicationRecordId: null,
 agentAttestationIds: null,
 runtimeAttestationIds: null,
 conformanceRunId: null,
 agentArtifactId: null,
 runtimeArtifactId: null,
 sourceEventId: null,
 sourceAggregateVersion: null,
 invalidReason: "base_ineligible",
 };
}

function readRouteGroupId(
 columnValue: string | null,
 jsonValue: unknown,
 fallback: string,
): string {
 if (columnValue) return columnValue;
 if (jsonValue && typeof jsonValue === "object" && !Array.isArray(jsonValue)) {
 const groupId = (jsonValue as { groupId?: unknown }).groupId;
 if (typeof groupId === "string" && groupId.trim()) return groupId;
 }
 return fallback;
}
