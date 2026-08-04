/**
 * Route Eligibility Projection 构建器。
 *
 * 从权威事实构建可重建的读取投影。
 * 不在用户热路径执行 — 由 Outbox 事件触发或 CLI 重建命令调用。
 *
 * 权威事实：RouteRevision, RouteActivation, Agent/AgentRevision,
 *           Runtime/RuntimeRevision, PublicationRecord, Attestation, Conformance, Policy。
 * 投影不是新的权威事实源。
 */

import { db } from "@/lib/db/client";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/control-plane";
import { deploymentRouteSetTable, deploymentRouteTable } from "@/lib/persistence/schema/control-plane";
import { policyRevisionTable } from "@/lib/persistence/schema/control-plane";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/control-plane";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import {
  artifact,
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { runtimeConformanceRun } from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import {
  computeCapabilityManifestDigest,
} from "@/lib/routes/domain/route-resolution-policy";
import {
  normalizeEligibility,
  computeSpecificity,
} from "@/lib/routes/domain/route-selector";
import type { RouteEligibilityStore, UpsertProjectionInput } from "./route-eligibility-store";
import { and, desc, eq, isNull } from "drizzle-orm";

export interface BuildProjectionDependencies {
  store: RouteEligibilityStore;
}

export interface BuildRouteEligibilityInput {
  tenantId: string;
  routeId: string;
}

export interface BuildRouteEligibilityResult {
  routeId: string;
  eligibilityState: "eligible" | "ineligible" | "pending_rebuild";
  projectionVersionNo: number;
}

/**
 * 创建 Projection 构建器。
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
      return { routeId: input.routeId, eligibilityState: "ineligible", projectionVersionNo: 0 };
    }

    // 2. 查找 RouteSet（获取 agentId, routeScopeKey）
    const [routeSet] = await db
      .select()
      .from(deploymentRouteSetTable)
      .where(eq(deploymentRouteSetTable.id, route.routeSetId))
      .limit(1);
    if (!routeSet) {
      return { routeId: input.routeId, eligibilityState: "ineligible", projectionVersionNo: 0 };
    }

    // 3. 没有 activeRouteRevisionId → ineligible
    if (!route.activeRouteRevisionId) {
      const version = await nextVersion(input.tenantId);
      await deps.store.upsertProjection({
        ...baseIneligible(route, routeSet),
        eligibilityState: "ineligible",
        projectionVersionNo: version,
        lastRebuiltAt: now,
      });
      return { routeId: input.routeId, eligibilityState: "ineligible", projectionVersionNo: version };
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
      const version = await nextVersion(input.tenantId);
      await deps.store.upsertProjection({
        ...baseIneligible(route, routeSet),
        eligibilityState: "ineligible",
        projectionVersionNo: version,
        lastRebuiltAt: now,
      });
      return { routeId: input.routeId, eligibilityState: "ineligible", projectionVersionNo: version };
    }

    // 5. 读取 RouteActivation
    const [activation] = await db
      .select()
      .from(routeActivation)
      .where(eq(routeActivation.routeId, route.id))
      .orderBy(desc(routeActivation.activationSequence))
      .limit(1);
    if (!activation || activation.routeRevisionId !== revision.id) {
      const version = await nextVersion(input.tenantId);
      await deps.store.upsertProjection({
        ...baseIneligible(route, routeSet),
        eligibilityState: "ineligible",
        projectionVersionNo: version,
        lastRebuiltAt: now,
      });
      return { routeId: input.routeId, eligibilityState: "ineligible", projectionVersionNo: version };
    }

    // 6. 读取 Agent + AgentRevision + Runtime + RuntimeRevision
    const [agent, agentRevision, runtimeRevision] = await Promise.all([
      db.select().from(agentTable)
        .where(and(eq(agentTable.id, routeSet.agentId), isNull(agentTable.deletedAt)))
        .limit(1).then((r) => r[0] ?? null),
      db.select().from(agentRevisionTable)
        .where(eq(agentRevisionTable.id, revision.agentRevisionId))
        .limit(1).then((r) => r[0] ?? null),
      db.select().from(runtimeRevisionTable)
        .where(eq(runtimeRevisionTable.id, revision.runtimeRevisionId))
        .limit(1).then((r) => r[0] ?? null),
    ]);

    const [runtime] = agent && runtimeRevision
      ? await db.select().from(runtimeTable)
          .where(and(eq(runtimeTable.id, runtimeRevision.runtimeId), isNull(runtimeTable.deletedAt)))
          .limit(1)
      : [null];

    // 7. 验证 Publication + Evidence + Conformance
    const [agentPublication, runtimePublication] = await Promise.all([
      loadActivePublication(input.tenantId, "agent_revision", revision.agentRevisionId),
      loadActivePublication(input.tenantId, "runtime_revision", revision.runtimeRevisionId),
    ]);

    const [agentEvidenceValid, runtimeEvidenceValid] = await Promise.all([
      validatePublicationEvidence(input.tenantId, agentPublication, "agent_revision", revision.agentRevisionId, agentRevision?.artifactId ?? null, agentRevision?.artifactDigest ?? null),
      validatePublicationEvidence(input.tenantId, runtimePublication, "runtime_revision", revision.runtimeRevisionId, runtimeRevision?.artifactId ?? null, runtimeRevision?.artifactDigest ?? null),
    ]);

    const runtimeConformanceValid = runtimeRevision
      ? await validateRuntimeConformance(input.tenantId, runtimePublication?.conformanceRunId ?? null, runtimeRevision)
      : false;

    // 8. Policy
    const policyRevisionState = revision.policyRevisionId
      ? await db.select({ state: policyRevisionTable.revisionState })
          .from(policyRevisionTable)
          .where(eq(policyRevisionTable.id, revision.policyRevisionId))
          .limit(1)
          .then((r) => r[0]?.state ?? "missing")
      : null;

    // 9. 计算 Eligibility
    const isEligible = Boolean(
      agent &&
      agentRevision &&
      runtime &&
      runtimeRevision &&
      activation.activationState === "active" &&
      agent.lifecycleState === "enabled" &&
      agentRevision.revisionState === "published" &&
      agentPublication &&
      agentEvidenceValid &&
      runtime.lifecycleState === "enabled" &&
      runtimeRevision.revisionState === "published" &&
      runtimePublication &&
      runtimeEvidenceValid &&
      runtimeConformanceValid &&
      (revision.policyRevisionId === null || policyRevisionState === "published"),
    );

    // 10. 计算选择属性
    // §2.1: 读取路径防御性逻辑 — 应用层已拒绝非法 eligibility，此处 null 理论不可达。
    // 若出现说明存在历史脏数据，specificity 降级为 0 但不阻塞投影构建。
    const normalized = normalizeEligibility(revision.eligibilityConditionsJson);
    const specificity = normalized ? computeSpecificity(normalized) : 0;

    const capabilityCompatibilityDigest = agentRevision && runtimeRevision
      ? computeCapabilityManifestDigest({
          agentRevisionId: agentRevision.id,
          agentInterfaceRequirements: agentRevision.agentInterfaceRequirementsJson,
          runtimeRevisionId: runtimeRevision.id,
          runtimeCapabilities: runtimeRevision.runtimeCapabilitiesJson,
        })
      : "sha256:0000000000000000000000000000000000000000000000000000000000000000";

    // 11. 构建 Projection 并写入
    const version = await nextVersion(input.tenantId);
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
      routeGroupId: readRouteGroupId(revision.routeGroupId, revision.trafficAllocationJson, routeSet.id),
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
      agentPublicationActive: agentPublication ? 1 : 0,
      agentEvidenceValid: agentEvidenceValid ? 1 : 0,
      runtimeRevisionId: revision.runtimeRevisionId,
      runtimeRevisionState: runtimeRevision?.revisionState ?? "missing",
      runtimeLifecycleState: runtime?.lifecycleState ?? "missing",
      runtimePublicationActive: runtimePublication ? 1 : 0,
      runtimeEvidenceValid: runtimeEvidenceValid ? 1 : 0,
      runtimeConformanceValid: runtimeConformanceValid ? 1 : 0,
      policyRevisionId: revision.policyRevisionId,
      policyRevisionState: policyRevisionState,
      capabilityCompatibilityDigest,
      agentArtifactDigest: agentRevision?.artifactDigest ?? null,
      runtimeArtifactDigest: runtimeRevision?.artifactDigest ?? null,
      runtimeConfigDigest: runtimeRevision?.configHash ?? null,
      routeContentDigest: revision.contentDigest,
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

  /** 递增 projectionVersionNo。 */
  async function nextVersion(tenantId: string): Promise<number> {
    const current = await deps.store.getMaxProjectionVersionNo(tenantId);
    return current + 1;
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
    capabilityCompatibilityDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    agentArtifactDigest: null,
    runtimeArtifactDigest: null,
    runtimeConfigDigest: null,
    routeContentDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  };
}

async function loadActivePublication(
  tenantId: string,
  subjectType: "agent_revision" | "runtime_revision",
  subjectRevisionId: string,
) {
  const [row] = await db
    .select({ publication: publicationRecord, withdrawalId: withdrawalRecord.id })
    .from(publicationRecord)
    .leftJoin(withdrawalRecord, eq(withdrawalRecord.publicationRecordId, publicationRecord.id))
    .where(
      and(
        eq(publicationRecord.tenantId, tenantId),
        eq(publicationRecord.subjectType, subjectType),
        eq(publicationRecord.subjectRevisionId, subjectRevisionId),
      ),
    )
    .limit(1);
  return row && !row.withdrawalId ? row.publication : null;
}

async function validatePublicationEvidence(
  tenantId: string,
  publication: typeof publicationRecord.$inferSelect | null,
  artifactType: "agent_revision" | "runtime_revision",
  revisionId: string,
  artifactId: string | null,
  artifactDigest: string | null,
): Promise<boolean> {
  if (
    !publication ||
    !artifactId ||
    !artifactDigest ||
    !Array.isArray(publication.attestationIds) ||
    publication.attestationIds.length === 0
  ) {
    return false;
  }
  const results = await Promise.all(
    publication.attestationIds.map(async (attestationId) => {
      if (typeof attestationId !== "string") return false;
      const [row] = await db
        .select({
          attestation: artifactAttestation,
          artifact,
          revocationId: attestationRevocationRecord.id,
        })
        .from(artifactAttestation)
        .innerJoin(artifact, eq(artifact.id, artifactAttestation.artifactId))
        .leftJoin(attestationRevocationRecord, eq(attestationRevocationRecord.attestationId, artifactAttestation.id))
        .where(
          and(
            eq(artifactAttestation.id, attestationId),
            eq(artifactAttestation.tenantId, tenantId),
            eq(artifactAttestation.artifactType, artifactType),
            eq(artifactAttestation.artifactRevisionId, revisionId),
          ),
        )
        .limit(1);
      return Boolean(
        row &&
        !row.revocationId &&
        !row.attestation.revokedAt &&
        row.attestation.verificationState === "verified" &&
        row.attestation.artifactId === artifactId &&
        row.attestation.artifactDigest === artifactDigest &&
        row.artifact.tenantId === tenantId &&
        row.artifact.digest === artifactDigest,
      );
    }),
  );
  return results.every(Boolean);
}

async function validateRuntimeConformance(
  tenantId: string,
  conformanceRunId: string | null,
  runtimeRev: typeof runtimeRevisionTable.$inferSelect,
): Promise<boolean> {
  if (!conformanceRunId || !runtimeRev.artifactDigest) return false;
  const [run] = await db
    .select()
    .from(runtimeConformanceRun)
    .where(
      and(
        eq(runtimeConformanceRun.id, conformanceRunId),
        eq(runtimeConformanceRun.tenantId, tenantId),
      ),
    )
    .limit(1);
  return Boolean(
    run &&
    run.overallResult === "passed" &&
    run.runtimeRevisionId === runtimeRev.id &&
    run.runtimeArtifactDigest === runtimeRev.artifactDigest &&
    run.runtimeConfigDigest === runtimeRev.configHash &&
    run.protocolContractRevision === runtimeRev.protocolContractRevision,
  );
}

function readRouteGroupId(columnValue: string | null, jsonValue: unknown, fallback: string): string {
  if (columnValue) return columnValue;
  if (jsonValue && typeof jsonValue === "object" && !Array.isArray(jsonValue)) {
    const groupId = (jsonValue as { groupId?: unknown }).groupId;
    if (typeof groupId === "string" && groupId.trim()) return groupId;
  }
  return fallback;
}
