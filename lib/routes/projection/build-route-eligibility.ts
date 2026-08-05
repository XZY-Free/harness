/**
 * Route Eligibility Projection 构建器。
 *
 * §4.3: 不再直接实现资格规则 — 委托 Phase 1 统一 Policy + Snapshot。
 * 构建器只做：读取 Snapshot → 调用 Policy → 组装 Projection → Upsert。
 *
 * 权威事实：RouteRevision, RouteActivation, Agent/AgentRevision,
 *           Runtime/RuntimeRevision, PublicationRecord, Attestation, Conformance, Policy。
 * 投影不是新的权威事实源。
 */

import { db } from "@/lib/db/client";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { policyRevisionTable } from "@/lib/persistence/schema/control-plane";
import { deploymentRouteSetTable, deploymentRouteTable } from "@/lib/persistence/schema/routes";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { computeSpecificity, normalizeEligibility } from "@/lib/routes/domain/route-selector";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { RouteEligibilityStore, UpsertProjectionInput } from "./route-eligibility-store";

import type { ArtifactEvidenceSnapshot } from "@/lib/artifacts/domain/artifact-evidence";
// §4.3: Phase 1 统一 Policy + Evidence 读取器
import { loadArtifactEvidenceSnapshot } from "@/lib/artifacts/persistence/artifact-evidence-reader";
import {
  type RevisionExecutionEligibilityError,
  RevisionExecutionEligibilityPolicy,
  type RevisionExecutionEvidenceSnapshot,
} from "@/lib/publications/application/load-revision-execution-evidence";
import type { ActivePublicationSnapshot } from "@/lib/publications/domain/publication-eligibility";
import { loadActivePublicationSnapshot } from "@/lib/publications/persistence/publication-evidence-reader";

export interface BuildProjectionDependencies {
  store: RouteEligibilityStore;
}

export interface BuildRouteEligibilityInput {
  tenantId: string;
  routeId: string;
  /** §4.2: 来源事件信息，用于权威版本计算。 */
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
 * §4.3: 构建器不再直接实现 loadActivePublication/validatePublicationEvidence/
 * validateRuntimeConformance，改用 Phase 1 的统一 Evidence Snapshot + Policy。
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
      // §4.4: Route 不存在 → 删除孤立投影
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
      // §4.4: RouteSet 不存在 → 删除孤立投影
      await deps.store.deleteProjection(input.routeId);
      return { routeId: input.routeId, eligibilityState: "ineligible", projectionVersionNo: 0 };
    }

    // 3. 没有 activeRouteRevisionId → ineligible
    if (!route.activeRouteRevisionId) {
      const version = computeAuthoritativeVersion(
        Number(routeSet.versionNo),
        0,
        input.sourceAggregateVersion ?? 0,
      );
      await deps.store.upsertProjection({
        ...baseIneligible(route, routeSet),
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
      const version = computeAuthoritativeVersion(
        Number(routeSet.versionNo),
        0,
        input.sourceAggregateVersion ?? 0,
      );
      await deps.store.upsertProjection({
        ...baseIneligible(route, routeSet),
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
      const version = computeAuthoritativeVersion(
        Number(routeSet.versionNo),
        0,
        input.sourceAggregateVersion ?? 0,
      );
      await deps.store.upsertProjection({
        ...baseIneligible(route, routeSet),
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

    // §4.3: 7. 使用 Phase 1 统一 Evidence 读取器加载完整快照
    const [agentArtifactEvidence, runtimeArtifactEvidence, agentPublication, runtimePublication] =
      await Promise.all([
        loadArtifactEvidenceSnapshot({
          tenantId: input.tenantId,
          artifactType: "agent_revision",
          artifactRevisionId: revision.agentRevisionId,
        }),
        loadArtifactEvidenceSnapshot({
          tenantId: input.tenantId,
          artifactType: "runtime_revision",
          artifactRevisionId: revision.runtimeRevisionId,
        }),
        loadActivePublicationSnapshot({
          tenantId: input.tenantId,
          subjectType: "agent_revision",
          subjectRevisionId: revision.agentRevisionId,
        }),
        loadActivePublicationSnapshot({
          tenantId: input.tenantId,
          subjectType: "runtime_revision",
          subjectRevisionId: revision.runtimeRevisionId,
        }),
      ]);

    // 8. Policy
    const policyRevisionState = revision.policyRevisionId
      ? await db
          .select({ state: policyRevisionTable.revisionState })
          .from(policyRevisionTable)
          .where(eq(policyRevisionTable.id, revision.policyRevisionId))
          .limit(1)
          .then((r) => r[0]?.state ?? "missing")
      : null;

    // §4.3: 9. 使用 Phase 1 统一 Policy 计算资格
    const evidenceSnapshot: RevisionExecutionEvidenceSnapshot = {
      tenantId: input.tenantId,
      agentRevisionId: revision.agentRevisionId,
      agentArtifactEvidence,
      agentPublication,
      agentLifecycleState: agent?.lifecycleState === "enabled" ? "active" : "archived",
      agentRevisionState:
        agentRevision?.revisionState === "published"
          ? "published"
          : agentRevision?.revisionState === "withdrawn"
            ? "withdrawn"
            : "draft",
      runtimeRevisionId: revision.runtimeRevisionId,
      runtimeArtifactEvidence,
      runtimePublication,
      runtimeConformance: null, // §4.3 TODO: 需要 loadConformanceEligibilitySnapshot
      runtimeLifecycleState: runtime?.lifecycleState === "enabled" ? "active" : "retired",
      runtimeRevisionState:
        runtimeRevision?.revisionState === "published"
          ? "published"
          : runtimeRevision?.revisionState === "withdrawn"
            ? "withdrawn"
            : "draft",
      runtimeCapabilities: Array.isArray(runtimeRevision?.runtimeCapabilitiesJson)
        ? (runtimeRevision.runtimeCapabilitiesJson as string[])
        : [],
      policyRevisionId: revision.policyRevisionId,
    };

    // §4.3: 统一 Policy 判断
    const eligibilityResult = RevisionExecutionEligibilityPolicy.isEligible(
      evidenceSnapshot,
      [], // requiredCapabilities 从 Route eligibilityConditions 推导，当前为空
    );
    const isEligible = eligibilityResult.eligible;

    // 收集 ineligibility 原因
    const ineligibilityReasons: string[] = [];
    if (!agent) ineligibilityReasons.push("agent_not_found");
    if (!agentRevision) ineligibilityReasons.push("agent_revision_not_found");
    if (!runtime) ineligibilityReasons.push("runtime_not_found");
    if (!runtimeRevision) ineligibilityReasons.push("runtime_revision_not_found");
    if (activation.activationState !== "active") ineligibilityReasons.push("activation_not_active");
    if (revision.policyRevisionId !== null && policyRevisionState !== "published")
      ineligibilityReasons.push("policy_not_published");
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

    // 11. 构建 Projection 并写入
    const version = computeAuthoritativeVersion(
      activation.routeSetVersionNo,
      activation.activationSequence,
      input.sourceAggregateVersion ?? revision.revisionNo,
    );

    // §4.3: 从统一 Snapshot 提取布尔字段
    const agentPublicationActive = agentPublication ? 1 : 0;
    const agentEvidenceValid =
      agentArtifactEvidence?.verificationState === "verified" &&
      agentArtifactEvidence.revokedAt === null
        ? 1
        : 0;
    const runtimePublicationActive = runtimePublication ? 1 : 0;
    const runtimeEvidenceValid =
      runtimeArtifactEvidence?.verificationState === "verified" &&
      runtimeArtifactEvidence.revokedAt === null
        ? 1
        : 0;
    // Conformance: 从 Policy 错误判断
    const runtimeConformanceValid = eligibilityResult.errors.some(
      (e) => e.dimension === "runtime_conformance",
    )
      ? 0
      : 1;

    const projectionInput: UpsertProjectionInput = {
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
      effectiveFrom: revision.effectiveFrom,
      effectiveUntil: revision.effectiveUntil,
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
      // ─── §4.1: 完整执行证据 ID ──────────────────────
      agentPublicationRecordId: agentPublication?.publicationRecordId ?? null,
      runtimePublicationRecordId: runtimePublication?.publicationRecordId ?? null,
      agentAttestationIds: agentPublication?.attestationIds ?? null,
      runtimeAttestationIds: runtimePublication?.attestationIds ?? null,
      conformanceRunId: runtimePublication?.conformanceRunId ?? null,
      agentArtifactId: agentArtifactEvidence?.artifactId ?? null,
      runtimeArtifactId: runtimeArtifactEvidence?.artifactId ?? null,
      sourceEventId: input.sourceEventId ?? null,
      sourceAggregateVersion: input.sourceAggregateVersion ?? null,
      invalidReason: isEligible ? null : ineligibilityReasons.join(","),
      eligibilityState: isEligible ? "eligible" : "ineligible",
      projectionVersionNo: version,
      lastRebuiltAt: now,
    };

    await deps.store.upsertProjection(projectionInput);
    return {
      routeId: input.routeId,
      eligibilityState: isEligible ? "eligible" : "ineligible",
      projectionVersionNo: version,
    };
  };

  /** §4.2: 权威组合版本 — 替代 MAX+1，防止并发重复/乱序。 */
  function computeAuthoritativeVersion(
    routeSetVersionNo: number,
    activationSequence: number,
    aggregateVersion: number,
  ): number {
    return routeSetVersionNo * 1_000_000 + activationSequence * 1_000 + aggregateVersion;
  }
}

// ─── 内部工具 ──────────────────────────────────────────────

function baseIneligible(
  route: { id: string; routeSetId: string; tenantId?: string },
  routeSet: { agentId: string; routeScopeKey: string },
): Omit<UpsertProjectionInput, "eligibilityState" | "projectionVersionNo" | "lastRebuiltAt"> {
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
    // ─── §4.1: 证据字段 — ineligible 时为 null（不可填空字符串）
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
