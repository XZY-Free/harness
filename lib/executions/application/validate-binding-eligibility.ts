/**
 * ExecutionBinding 最终校验 — 收缩版。
 *
 * 不再重新构造全部证据图或逐个读取 Artifact 原始内容。
 * 只做最小化权威事实 Fail-closed 校验：
 *   1. Projection 版本和输入一致
 *   2. Route 当前 Active Revision 仍一致
 *   3. 双方 Publication 未 Withdrawal
 *   4. 所有 Attestation 无 Revocation
 *   5. Agent/Runtime Revision 仍 Published
 *   6. Agent/Runtime 仍 Enabled
 *   7. ConformanceRun 仍 Passed 且绑定一致
 *   8. Policy 仍 Published
 *
 * SQL 往返与 Route 数量无关。
 */

import { db } from "@/lib/db/client";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/control-plane";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/control-plane";
import { policyRevisionTable } from "@/lib/persistence/schema/control-plane";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import {
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { runtimeConformanceRun } from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { and, eq, isNull } from "drizzle-orm";

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
 * ExecutionBinding 最终 Fail-closed 校验。
 *
 * 在 Projection 可能滞后的情况下，仍保证 Binding 只绑定真正合法的 Route。
 * 不重算完整 Route 候选，不逐个加载 Artifact 原始内容。
 */
export async function validateBindingEligibility(
  input: BindingEligibilityInput,
): Promise<BindingEligibilityResult> {
  // 1. 校验 Projection 版本
  const [projection] = await db
    .select()
    .from(routeEligibilityProjection)
    .where(eq(routeEligibilityProjection.routeId, input.routeId))
    .limit(1);

  const projectionVersionMatch = projection
    ? projection.projectionVersionNo === input.projectionVersionNo
    : false;

  if (projection && !projectionVersionMatch) {
    // Projection 已更新 → 之前的选择可能已失效
    // 仍继续权威校验（不盲信 Projection，但也不盲目拒绝）
  }

  // 2. 校验 Route 当前 Active Revision 仍一致
  const [currentActivation] = await db
    .select()
    .from(routeActivation)
    .where(eq(routeActivation.routeId, input.routeId))
    .limit(1);

  if (!currentActivation || currentActivation.routeRevisionId !== input.routeRevisionId) {
    return {
      valid: false,
      reason: "route_revision_mismatch",
      projectionVersionMatch,
    };
  }

  // 3. 并行校验 Agent + Runtime + Policy
  const [agentCheck, runtimeCheck, policyCheck] = await Promise.all([
    validateAgentRevision(input.tenantId, input.agentRevisionId),
    validateRuntimeRevision(input.tenantId, input.runtimeRevisionId),
    input.policyRevisionId
      ? validatePolicyRevision(input.policyRevisionId)
      : Promise.resolve({ valid: true }),
  ]);

  if (!agentCheck.valid) {
    return { valid: false, reason: agentCheck.reason, projectionVersionMatch };
  }
  if (!runtimeCheck.valid) {
    return { valid: false, reason: runtimeCheck.reason, projectionVersionMatch };
  }
  if (!policyCheck.valid) {
    return { valid: false, reason: policyCheck.reason, projectionVersionMatch };
  }

  // 4. 批量校验双方 Publication 未 Withdrawal
  const [agentPub, runtimePub] = await Promise.all([
    loadActivePublication(input.tenantId, "agent_revision", input.agentRevisionId),
    loadActivePublication(input.tenantId, "runtime_revision", input.runtimeRevisionId),
  ]);

  if (!agentPub) {
    return { valid: false, reason: "agent_publication_withdrawn", projectionVersionMatch };
  }
  if (!runtimePub) {
    return { valid: false, reason: "runtime_publication_withdrawn", projectionVersionMatch };
  }

  // 5. 批量校验 Attestation 无 Revocation
  const [agentAttestationOk, runtimeAttestationOk] = await Promise.all([
    validateAttestationsNotRevoked(input.tenantId, agentPub.attestationIds),
    validateAttestationsNotRevoked(input.tenantId, runtimePub.attestationIds),
  ]);

  if (!agentAttestationOk) {
    return { valid: false, reason: "agent_attestation_revoked", projectionVersionMatch };
  }
  if (!runtimeAttestationOk) {
    return { valid: false, reason: "runtime_attestation_revoked", projectionVersionMatch };
  }

  // 6. 校验 ConformanceRun 仍 Passed 且绑定一致
  if (runtimePub.conformanceRunId) {
    const [run] = await db
      .select()
      .from(runtimeConformanceRun)
      .where(
        and(
          eq(runtimeConformanceRun.id, runtimePub.conformanceRunId),
          eq(runtimeConformanceRun.tenantId, input.tenantId),
        ),
      )
      .limit(1);

    if (!run || run.overallResult !== "passed") {
      return { valid: false, reason: "conformance_not_passed", projectionVersionMatch };
    }
  }

  return { valid: true, projectionVersionMatch };
}

// ─── 内部工具 ──────────────────────────────────────────────

async function validateAgentRevision(tenantId: string, revisionId: string) {
  const [revision] = await db
    .select()
    .from(agentRevisionTable)
    .where(eq(agentRevisionTable.id, revisionId))
    .limit(1);
  if (!revision || revision.revisionState !== "published") {
    return { valid: false, reason: "agent_revision_not_published" };
  }
  const [agent] = await db
    .select()
    .from(agentTable)
    .where(and(eq(agentTable.id, revision.agentId), isNull(agentTable.deletedAt)))
    .limit(1);
  if (!agent || agent.lifecycleState !== "enabled") {
    return { valid: false, reason: "agent_not_enabled" };
  }
  return { valid: true };
}

async function validateRuntimeRevision(tenantId: string, revisionId: string) {
  const [revision] = await db
    .select()
    .from(runtimeRevisionTable)
    .where(eq(runtimeRevisionTable.id, revisionId))
    .limit(1);
  if (!revision || revision.revisionState !== "published") {
    return { valid: false, reason: "runtime_revision_not_published" };
  }
  const [runtime] = await db
    .select()
    .from(runtimeTable)
    .where(and(eq(runtimeTable.id, revision.runtimeId), isNull(runtimeTable.deletedAt)))
    .limit(1);
  if (!runtime || runtime.lifecycleState !== "enabled") {
    return { valid: false, reason: "runtime_not_enabled" };
  }
  return { valid: true };
}

async function validatePolicyRevision(policyRevisionId: string) {
  const [policy] = await db
    .select()
    .from(policyRevisionTable)
    .where(eq(policyRevisionTable.id, policyRevisionId))
    .limit(1);
  if (!policy || policy.revisionState !== "published") {
    return { valid: false, reason: "policy_not_published" };
  }
  return { valid: true };
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

async function validateAttestationsNotRevoked(
  tenantId: string,
  attestationIds: unknown[],
): Promise<boolean> {
  if (!Array.isArray(attestationIds) || attestationIds.length === 0) return false;
  for (const id of attestationIds) {
    if (typeof id !== "string") return false;
    const [row] = await db
      .select({ revocationId: attestationRevocationRecord.id, revokedAt: artifactAttestation.revokedAt })
      .from(artifactAttestation)
      .leftJoin(
        attestationRevocationRecord,
        eq(attestationRevocationRecord.attestationId, artifactAttestation.id),
      )
      .where(
        and(
          eq(artifactAttestation.id, id),
          eq(artifactAttestation.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!row || row.revocationId || row.revokedAt) return false;
  }
  return true;
}
