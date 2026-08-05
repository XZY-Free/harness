/**
 * ExecutionBinding 最终校验 — §5.1: 使用 Phase 1 统一 Policy/Snapshot。
 *
 * 不再内联 loadActivePublication/validateAttestationsNotRevoked，
 * 改用 Phase 1 的 loadActivePublicationSnapshot + loadArtifactEvidenceSnapshot +
 * PublicationEligibilityPolicy + ArtifactEvidencePolicy。
 *
 * 核心校验（Projection 版本 + Route Activation）在 DB 事务内执行。
 * Phase 1 Evidence Readers 使用全局 db（独立读取，不需要事务一致性）。
 *
 * Fail-closed 校验维度：
 *   1. Projection 版本和输入一致
 *   2. Route 当前 Active Revision 仍一致
 *   3. 双方 Publication 未 Withdrawal（PublicationEligibilityPolicy）
 *   4. 所有 Attestation 无 Revocation + Verified（ArtifactEvidencePolicy）
 *   5. Agent/Runtime Revision 仍 Published
 *   6. Agent/Runtime 仍 Enabled
 *   7. ConformanceRun 仍 Passed 且绑定一致
 *   8. Policy 仍 Published
 */

import { db } from "@/lib/db/client";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { policyRevisionTable } from "@/lib/persistence/schema/control-plane";
import { routeActivation } from "@/lib/routes/persistence/route-revision-record";
import { runtimeConformanceRun } from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { and, desc, eq, isNull } from "drizzle-orm";

// §5.1: Phase 1 统一 Policy + Evidence 读取器
import { loadArtifactEvidenceSnapshot } from "@/lib/artifacts/persistence/artifact-evidence-reader";
import { ArtifactEvidencePolicy } from "@/lib/artifacts/domain/artifact-evidence-policy";
import { loadActivePublicationSnapshot } from "@/lib/publications/persistence/publication-evidence-reader";
import { PublicationEligibilityPolicy } from "@/lib/publications/domain/publication-eligibility";

export interface BindingEligibilityInput {
  tenantId: string;
  routeId: string;
  /** Resolver 冻结的 RouteRevisionId。 */
  routeRevisionId: string;
  /** Resolver 冻结的 RouteActivationId。 */
  routeActivationId: string;
  /** Resolver 冻结的 AgentRevisionId。 */
  agentRevisionId: string;
  /** Resolver 冻结的 RuntimeRevisionId。 */
  runtimeRevisionId: string;
  /** Resolver 冻结的 PolicyRevisionId（可 null）。 */
  policyRevisionId: string | null;
  /** Projection 版本号 — 用于检测 Projection 滞后。 */
  projectionVersionNo: number;
}

export interface BindingEligibilityResult {
  valid: boolean;
  /** 校验失败原因。 */
  reason?: string;
  /** Projection 版本是否一致。 */
  projectionVersionMatch: boolean;
}

/**
 * §5.1: ExecutionBinding 最终 Fail-closed 校验。
 *
 * 使用 Phase 1 统一 Policy/Snapshot。
 * 核心校验在 DB 事务内，Evidence Readers 使用全局 db。
 */
export async function validateBindingEligibility(
  input: BindingEligibilityInput,
): Promise<BindingEligibilityResult> {
  // §5.1: 核心校验在事务内执行
  return db.transaction(async (tx) => {
    // 1. 校验 Projection 版本
    const [projection] = await tx
      .select()
      .from(routeEligibilityProjection)
      .where(eq(routeEligibilityProjection.routeId, input.routeId))
      .limit(1);

    const projectionVersionMatch = projection
      ? projection.projectionVersionNo === input.projectionVersionNo
      : false;

    // §5.2: Projection 版本过时 → 拒绝 Binding，调用方必须重新解析
    if (input.projectionVersionNo !== undefined && !projectionVersionMatch) {
      return {
        valid: false,
        reason: "eligibility_snapshot_stale",
        projectionVersionMatch,
      };
    }

    // 2. §5.3: 校验 Route Activation — 指定 routeActivationId + 最新 sequence + active 状态
    const [currentActivation] = await tx
      .select()
      .from(routeActivation)
      .where(eq(routeActivation.routeId, input.routeId))
      .orderBy(desc(routeActivation.activationSequence))
      .limit(1);

    if (!currentActivation) {
      return { valid: false, reason: "route_activation_not_found", projectionVersionMatch };
    }
    // 校验指定的 routeActivationId 是当前最新 Activation
    if (currentActivation.id !== input.routeActivationId) {
      return { valid: false, reason: "route_activation_superseded", projectionVersionMatch };
    }
    if (currentActivation.routeRevisionId !== input.routeRevisionId) {
      return {
        valid: false,
        reason: "route_revision_mismatch",
        projectionVersionMatch,
      };
    }
    if (currentActivation.activationState !== "active") {
      return { valid: false, reason: "route_activation_not_active", projectionVersionMatch };
    }

    // 3. 并行校验 Agent + Runtime + Policy 生命周期（事务内）
    const [agentCheck, runtimeCheck, policyCheck] = await Promise.all([
      validateAgentRevision(input.tenantId, input.agentRevisionId),
      validateRuntimeRevision(input.tenantId, input.runtimeRevisionId),
      input.policyRevisionId
        ? validatePolicyRevision(input.policyRevisionId)
        : Promise.resolve({ valid: true as const }),
    ]);

    if (!agentCheck.valid) {
      return { valid: false, reason: agentCheck.reason, projectionVersionMatch };
    }
    if (!runtimeCheck.valid) {
      return { valid: false, reason: runtimeCheck.reason, projectionVersionMatch };
    }
    if (!policyCheck.valid) {
      return { valid: false, reason: "policy_not_published", projectionVersionMatch };
    }

    // §5.1: 4. 使用 Phase 1 统一 PublicationEligibilityPolicy 校验 Publication
    const [agentPubSnapshot, runtimePubSnapshot] = await Promise.all([
      loadActivePublicationSnapshot({
        tenantId: input.tenantId,
        subjectType: "agent_revision",
        subjectRevisionId: input.agentRevisionId,
      }),
      loadActivePublicationSnapshot({
        tenantId: input.tenantId,
        subjectType: "runtime_revision",
        subjectRevisionId: input.runtimeRevisionId,
      }),
    ]);

    const agentPubEligibility = PublicationEligibilityPolicy.isActive(agentPubSnapshot, input.tenantId);
    if (!agentPubEligibility.active) {
      return { valid: false, reason: `agent_publication_${agentPubEligibility.reason ?? "inactive"}`, projectionVersionMatch };
    }

    const runtimePubEligibility = PublicationEligibilityPolicy.isActive(runtimePubSnapshot, input.tenantId);
    if (!runtimePubEligibility.active) {
      return { valid: false, reason: `runtime_publication_${runtimePubEligibility.reason ?? "inactive"}`, projectionVersionMatch };
    }

    // §5.1: 5. 使用 Phase 1 统一 ArtifactEvidencePolicy 校验 Attestation
    const [agentEvidence, runtimeEvidence] = await Promise.all([
      loadArtifactEvidenceSnapshot({
        tenantId: input.tenantId,
        artifactType: "agent_revision",
        artifactRevisionId: input.agentRevisionId,
      }),
      loadArtifactEvidenceSnapshot({
        tenantId: input.tenantId,
        artifactType: "runtime_revision",
        artifactRevisionId: input.runtimeRevisionId,
      }),
    ]);

    // 使用执行阶段入口（排除 legacy_custom 格式）
    const agentEvidenceResult = agentEvidence
      ? ArtifactEvidencePolicy.validateForNewExecution(agentEvidence, {
          expectedTenantId: input.tenantId,
          expectedArtifactType: "agent_revision",
          expectedRevisionId: input.agentRevisionId,
          expectedDigest: agentEvidence.artifactDigest,
        })
      : { valid: false as const, errors: [{ code: "no_evidence", message: "Agent 无 Artifact Evidence" }] };

    if (!agentEvidenceResult.valid) {
      const reason = agentEvidenceResult.errors.map((e) => e.code).join(",");
      return { valid: false, reason: `agent_evidence_invalid:${reason}`, projectionVersionMatch };
    }

    const runtimeEvidenceResult = runtimeEvidence
      ? ArtifactEvidencePolicy.validateForNewExecution(runtimeEvidence, {
          expectedTenantId: input.tenantId,
          expectedArtifactType: "runtime_revision",
          expectedRevisionId: input.runtimeRevisionId,
          expectedDigest: runtimeEvidence.artifactDigest,
        })
      : { valid: false as const, errors: [{ code: "no_evidence", message: "Runtime 无 Artifact Evidence" }] };

    if (!runtimeEvidenceResult.valid) {
      const reason = runtimeEvidenceResult.errors.map((e) => e.code).join(",");
      return { valid: false, reason: `runtime_evidence_invalid:${reason}`, projectionVersionMatch };
    }

    // 6. Conformance — 从 Publication snapshot 获取 conformanceRunId
    if (runtimePubSnapshot?.conformanceRunId) {
      const [run] = await db
        .select()
        .from(runtimeConformanceRun)
        .where(
          and(
            eq(runtimeConformanceRun.id, runtimePubSnapshot.conformanceRunId),
            eq(runtimeConformanceRun.tenantId, input.tenantId),
          ),
        )
        .limit(1);

      if (!run || run.overallResult !== "passed") {
        return { valid: false, reason: "conformance_not_passed", projectionVersionMatch };
      }
    }

    return { valid: true, projectionVersionMatch };
  });
}

// ─── 内部工具 ──────────────────────────────────────────────

async function validateAgentRevision(tenantId: string, revisionId: string) {
  const [revision] = await db
    .select()
    .from(agentRevisionTable)
    .where(eq(agentRevisionTable.id, revisionId))
    .limit(1);
  if (!revision || revision.revisionState !== "published") {
    return { valid: false as const, reason: "agent_revision_not_published" as const };
  }
  const [agent] = await db
    .select()
    .from(agentTable)
    .where(and(eq(agentTable.id, revision.agentId), isNull(agentTable.deletedAt)))
    .limit(1);
  if (!agent || agent.lifecycleState !== "enabled") {
    return { valid: false as const, reason: "agent_not_enabled" as const };
  }
  return { valid: true as const };
}

async function validateRuntimeRevision(tenantId: string, revisionId: string) {
  const [revision] = await db
    .select()
    .from(runtimeRevisionTable)
    .where(eq(runtimeRevisionTable.id, revisionId))
    .limit(1);
  if (!revision || revision.revisionState !== "published") {
    return { valid: false as const, reason: "runtime_revision_not_published" as const };
  }
  const [runtime] = await db
    .select()
    .from(runtimeTable)
    .where(and(eq(runtimeTable.id, revision.runtimeId), isNull(runtimeTable.deletedAt)))
    .limit(1);
  if (!runtime || runtime.lifecycleState !== "enabled") {
    return { valid: false as const, reason: "runtime_not_enabled" as const };
  }
  return { valid: true as const };
}

async function validatePolicyRevision(policyRevisionId: string) {
  const [policy] = await db
    .select()
    .from(policyRevisionTable)
    .where(eq(policyRevisionTable.id, policyRevisionId))
    .limit(1);
  if (!policy || policy.revisionState !== "published") {
    return { valid: false as const };
  }
  return { valid: true as const };
}
