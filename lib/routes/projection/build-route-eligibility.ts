/**
 * Route Eligibility Projection 构建器。
 *
 * 使用统一 RevisionExecutionEligibilityPolicy + Reader，
 * 构建器只做：读取 Snapshot → 调用 Policy → 组装 Projection → 计算 Digest → 幂等 UPSERT。
 *
 * 投影版本规则：
 * - 现有行不存在 → projectionVersionNo = 1
 * - Digest 相同 → 不增加版本
 * - Digest 变化 → projectionVersionNo + 1
 *
 * 权威事实：RouteRevision, RouteActivation, Agent/AgentRevision,
 * Runtime/RuntimeRevision, PublicationRecord, Attestation, Conformance, Policy。
 * 投影不是新的权威事实源。
 */

import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { db } from "@/lib/db/client";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { deploymentRouteSetTable, deploymentRouteTable } from "@/lib/persistence/schema/routes";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { computeSpecificity, normalizeEligibility } from "@/lib/routes/domain/route-selector";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { RouteEligibilityStore, UpsertProjectionInput } from "./route-eligibility-store";

// 统一 Policy + Reader（从 control-plane/domain）
import {
  RevisionExecutionEligibilityPolicy,
  extractRequiredCapabilities,
} from "@/lib/control-plane/domain/revision-execution-eligibility";
import { createMySqlRevisionExecutionEvidenceReader } from "@/lib/control-plane/persistence/mysql-revision-execution-evidence-reader";

export interface BuildProjectionDependencies {
  store: RouteEligibilityStore;
}

export interface BuildRouteEligibilityInput {
  tenantId: string;
  routeId: string;
  /** 来源事件信息，用于权威版本计算。 */
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
 * 构建器使用统一 Reader 加载证据 + 统一 Policy 判断资格，
 * 计算 projectionContentDigest 实现幂等版本。
 */
export function createBuildRouteEligibility(deps: BuildProjectionDependencies) {
  return async function buildRouteEligibility(
    input: BuildRouteEligibilityInput,
  ): Promise<BuildRouteEligibilityResult> {
    const now = new Date();

    // 1. 通过所属 RouteSet 同时确认 DeploymentRoute 的租户归属。
    const [route] = await db
      .select({
        id: deploymentRouteTable.id,
        routeSetId: deploymentRouteTable.routeSetId,
        routeState: deploymentRouteTable.routeState,
      })
      .from(deploymentRouteTable)
      .innerJoin(
        deploymentRouteSetTable,
        and(
          eq(deploymentRouteTable.routeSetId, deploymentRouteSetTable.id),
          eq(deploymentRouteSetTable.tenantId, input.tenantId),
        ),
      )
      .where(eq(deploymentRouteTable.id, input.routeId))
      .limit(1);
    if (!route) {
      // 无法区分 Route 不存在与属于其他租户；未确认租户前禁止按 routeId 删除。
      return { routeId: input.routeId, eligibilityState: "ineligible", projectionVersionNo: 0 };
    }

    // 2. latest RouteActivation 是当前 revision 的唯一入口。
    const [activation] = await db
      .select()
      .from(routeActivation)
      .where(
        and(eq(routeActivation.routeId, route.id), eq(routeActivation.tenantId, input.tenantId)),
      )
      .orderBy(desc(routeActivation.activationSequence))
      .limit(1);
    if (!activation) {
      await deps.store.deleteProjection(input.routeId);
      return { routeId: input.routeId, eligibilityState: "ineligible", projectionVersionNo: 0 };
    }

    // 3. revision 必须由 latest activation.routeRevisionId 指向，禁止读取 route.activeRouteRevisionId。
    const [revision] = await db
      .select()
      .from(routeRevision)
      .where(
        and(
          eq(routeRevision.id, activation.routeRevisionId),
          eq(routeRevision.routeId, route.id),
          eq(routeRevision.tenantId, input.tenantId),
        ),
      )
      .limit(1);
    if (!revision) {
      await deps.store.deleteProjection(input.routeId);
      return { routeId: input.routeId, eligibilityState: "ineligible", projectionVersionNo: 0 };
    }

    // 3b. routeGroupId 只消费 revision.routeGroupId；null/空/纯空白视为非法权威，
    // fail-closed，禁止从 trafficAllocationJson 或 routeSet.id 猜测，删除既有投影。
    const routeGroupId = revision.routeGroupId;
    if (typeof routeGroupId !== "string" || routeGroupId.trim().length === 0) {
      await deps.store.deleteProjection(input.routeId);
      return { routeId: input.routeId, eligibilityState: "ineligible", projectionVersionNo: 0 };
    }

    // 4. RouteSet 必须与 Route、Activation、Revision 的真实外键一致。
    const [routeSet] = await db
      .select()
      .from(deploymentRouteSetTable)
      .where(eq(deploymentRouteSetTable.id, revision.routeSetId))
      .limit(1);
    if (
      !routeSet ||
      route.routeSetId !== routeSet.id ||
      activation.routeSetId !== routeSet.id ||
      routeSet.tenantId !== input.tenantId
    ) {
      await deps.store.deleteProjection(input.routeId);
      return { routeId: input.routeId, eligibilityState: "ineligible", projectionVersionNo: 0 };
    }

    // 5. 读取 Agent + AgentRevision + Runtime + RuntimeRevision（权威事实）
    // 无 Agent 约束（routeSet.agentId / revision.agentRevisionId 为 null）→
    // 基础 Harness Route，Agent 维度事实跳过，Agent Evidence 为 not_applicable（§18）。
    const hasAgentConstraint = routeSet.agentId !== null && revision.agentRevisionId !== null;
    const [agent, agentRevision, runtimeRevision] = await Promise.all([
      hasAgentConstraint && routeSet.agentId
        ? db
            .select()
            .from(agentTable)
            .where(and(eq(agentTable.id, routeSet.agentId), isNull(agentTable.deletedAt)))
            .limit(1)
            .then((r) => r[0] ?? null)
        : Promise.resolve(null),
      hasAgentConstraint
        ? db
            .select()
            .from(agentRevisionTable)
            .where(eq(agentRevisionTable.id, revision.agentRevisionId as string))
            .limit(1)
            .then((r) => r[0] ?? null)
        : Promise.resolve(null),
      db
        .select()
        .from(runtimeRevisionTable)
        .where(eq(runtimeRevisionTable.id, revision.runtimeRevisionId))
        .limit(1)
        .then((r) => r[0] ?? null),
    ]);

    const [runtime] = runtimeRevision
      ? await db
          .select()
          .from(runtimeTable)
          .where(
            and(eq(runtimeTable.id, runtimeRevision.runtimeId), isNull(runtimeTable.deletedAt)),
          )
          .limit(1)
      : [null];

    // 7. 使用统一 Reader 加载完整证据快照（无 Agent 约束时 Reader 内部跳过 Agent 维度）
    const evidenceReader = createMySqlRevisionExecutionEvidenceReader({ db });
    const evidenceSnapshot = await evidenceReader.loadCurrentEvidence({
      tenantId: input.tenantId,
      agentRevisionId: revision.agentRevisionId,
      runtimeRevisionId: revision.runtimeRevisionId,
      policyRevisionId: revision.policyRevisionId,
    });

    // 8. 从 AgentRevision 提取 requiredCapabilities（fail-closed）
    // 无 Agent 约束时 agentRevision 为 null → extractRequiredCapabilities 返回 []。
    const requiredCapabilities = extractRequiredCapabilities(
      agentRevision?.agentInterfaceRequirementsJson,
    );

    // 8. Route 自身、latest activation、revision 窗口和 selector 共同参与资格判断。
    const normalized = normalizeEligibility(revision.eligibilityConditionsJson);
    const routeAuthorityEligible =
      route.routeState === "enabled" &&
      activation.activationState === "active" &&
      (!revision.effectiveFrom || revision.effectiveFrom <= now) &&
      (!revision.effectiveUntil || revision.effectiveUntil > now) &&
      normalized !== null;

    // 9. 使用统一 Policy 判断证据资格
    // RevisionExecutionEligibilityPolicy 内部已调用统一 Runtime Conformance 纯验证器，
    // 投影据此派生 runtimeConformanceValid，不重复调用第二套 Policy。
    const eligibilityResult = RevisionExecutionEligibilityPolicy.isEligible(
      evidenceSnapshot,
      requiredCapabilities,
    );

    // 无 Agent 约束（基础 Harness Route）→ Agent 生命周期不参与资格判断（§18 not_applicable）；
    // Runtime 生命周期始终必填（§12）。
    const entityLifecycleEligible = hasAgentConstraint
      ? agent?.lifecycleState === "enabled" &&
        agentRevision?.revisionState === "published" &&
        runtime?.lifecycleState === "enabled" &&
        runtimeRevision?.revisionState === "published"
      : runtime?.lifecycleState === "enabled" && runtimeRevision?.revisionState === "published";
    const isEligible =
      routeAuthorityEligible && entityLifecycleEligible && eligibilityResult.eligible;

    // Policy revision state for projection
    const policyRevisionState =
      evidenceSnapshot.policyRequirement.kind === "referenced"
        ? evidenceSnapshot.policyRequirement.policyRevision.revisionState
        : null;

    // 收集 ineligibility 原因
    const ineligibilityReasons: string[] = [];
    if (route.routeState !== "enabled") ineligibilityReasons.push("route_not_enabled");
    if (activation.activationState !== "active") ineligibilityReasons.push("activation_not_active");
    if (revision.effectiveFrom && revision.effectiveFrom > now) {
      ineligibilityReasons.push("revision_not_effective_yet");
    }
    if (revision.effectiveUntil && revision.effectiveUntil <= now) {
      ineligibilityReasons.push("revision_expired");
    }
    if (!normalized) ineligibilityReasons.push("selector_invalid");
    // 无 Agent 约束（基础 Harness Route）→ Agent 维度原因不参与（not_applicable，§18）。
    if (hasAgentConstraint) {
      if (!agent) ineligibilityReasons.push("agent_not_found");
      if (!agentRevision) ineligibilityReasons.push("agent_revision_not_found");
      if (agent && agent.lifecycleState !== "enabled") {
        ineligibilityReasons.push("agent_not_enabled");
      }
      if (agentRevision && agentRevision.revisionState !== "published") {
        ineligibilityReasons.push("agent_revision_not_published");
      }
    }
    if (!runtime) ineligibilityReasons.push("runtime_not_found");
    if (!runtimeRevision) ineligibilityReasons.push("runtime_revision_not_found");
    if (runtime && runtime.lifecycleState !== "enabled") {
      ineligibilityReasons.push("runtime_not_enabled");
    }
    if (runtimeRevision && runtimeRevision.revisionState !== "published") {
      ineligibilityReasons.push("runtime_revision_not_published");
    }
    // 从统一 Policy 错误中提取原因（含 runtime_conformance dimension 的 Conformance 失败）
    for (const err of eligibilityResult.errors) {
      ineligibilityReasons.push(err.code);
    }

    // 10. 计算选择属性
    const specificity = normalized ? computeSpecificity(normalized) : 0;

    const capabilityCompatibilityDigest = computeCapabilityManifestDigest({
      agentRevisionId: revision.agentRevisionId,
      agentInterfaceRequirements: agentRevision?.agentInterfaceRequirementsJson ?? null,
      runtimeRevisionId: revision.runtimeRevisionId,
      runtimeCapabilities: runtimeRevision?.runtimeCapabilitiesJson ?? null,
    });

    // 从统一 Snapshot 提取布尔字段
    const agentPublicationActive = evidenceSnapshot.agentPublication ? 1 : 0;
    const agentEvidenceValid =
      evidenceSnapshot.agentArtifactEvidence?.verificationState === "verified" &&
      evidenceSnapshot.agentArtifactEvidence.revokedAt === null
        ? 1
        : 0;
    const runtimePublicationActive = evidenceSnapshot.runtimePublication ? 1 : 0;
    // Runtime evidence all-or-nothing（03 §3）：hosted 要求 Artifact 全集 verified；
    // external_endpoint 无 Runtime Artifact（不伪造），证据有效即 1。
    const runtimeEvidenceKind = runtimeRevision?.runtimeEvidenceKind ?? null;
    const runtimeEvidenceValid =
      runtimeEvidenceKind === "external_endpoint"
        ? 1
        : evidenceSnapshot.runtimeArtifactEvidence?.verificationState === "verified" &&
            evidenceSnapshot.runtimeArtifactEvidence.revokedAt === null
          ? 1
          : 0;
    // Conformance: 由同一次 RevisionExecutionEligibilityPolicy 结果派生
    // （runtime_conformance dimension 无错误 → 有效）。
    const runtimeConformanceValid = eligibilityResult.errors.some(
      (err) => err.dimension === "runtime_conformance",
    )
      ? 0
      : 1;

    // 11. 计算 projectionContentDigest 并确定版本号
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
      activationState: activation.activationState,
      routeGroupId,
      selectorDigest: revision.selectorDigest,
      eligibilityConditionsJson: revision.eligibilityConditionsJson,
      specificity,
      priorityNo: revision.priorityNo,
      trafficWeight: revision.trafficWeight,
      effectiveFrom: revision.effectiveFrom?.toISOString() ?? null,
      effectiveUntil: revision.effectiveUntil?.toISOString() ?? null,
      agentRevisionId: revision.agentRevisionId,
      // 无 Agent 约束（基础 Harness Route）→ Agent Evidence not_applicable，不伪装 passed（§18）。
      agentRevisionState: hasAgentConstraint
        ? (agentRevision?.revisionState ?? "missing")
        : "not_applicable",
      agentLifecycleState: hasAgentConstraint
        ? (agent?.lifecycleState ?? "missing")
        : "not_applicable",
      agentPublicationActive,
      agentEvidenceValid,
      runtimeRevisionId: revision.runtimeRevisionId,
      runtimeRevisionState: runtimeRevision?.revisionState ?? "missing",
      runtimeLifecycleState: runtime?.lifecycleState ?? "missing",
      runtimePublicationActive,
      runtimeEvidenceValid,
      runtimeConformanceValid,
      runtimeEvidenceKind: runtimeEvidenceKind ?? "hosted_artifact",
      policyRevisionId: revision.policyRevisionId,
      policyRevisionState,
      capabilityCompatibilityDigest,
      agentArtifactDigest: agentRevision?.artifactDigest ?? null,
      runtimeArtifactDigest: runtimeRevision?.artifactDigest ?? null,
      runtimeConfigDigest: runtimeRevision?.configHash ?? null,
      runtimeTargetDigest: runtimeRevision?.runtimeTargetDigest ?? null,
      routeContentDigest: revision.contentDigest,
      agentDescriptorSnapshotId:
        evidenceSnapshot.agentPublication?.agentDescriptorSnapshotId ?? null,
      agentProviderDescriptorDigest:
        evidenceSnapshot.agentPublication?.agentProviderDescriptorDigest ?? null,
      agentInvocationContextContractDigest:
        evidenceSnapshot.agentPublication?.agentInvocationContextContractDigest ?? null,
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
      // 事件元数据存入 DB，但不参与内容 Digest，避免传输元数据改变投影版本。
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
  return computeCanonicalDigest(fields);
}

/**
 * 基于 Digest 的版本规则。
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
