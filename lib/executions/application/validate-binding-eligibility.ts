/**
 * ExecutionBinding 最终校验 — §07: 单事务内 Fail-closed 校验。
 *
 * : tx 必须传入，不允许可选。该函数不从其他 Application 或 API 直接调用。
 * : 禁止全局 db — 所有读取使用 Binding Store 创建的同一事务。
 * : 验证精确证据 — Projection 冻结的证据 ID 必须与当前权威一致。
 */

import { type DbOrTx, db } from "@/lib/db/client";
import { routeActivation } from "@/lib/routes/persistence/route-revision-record";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { desc, eq } from "drizzle-orm";

// §03: 统一 Policy + Reader
import { RevisionExecutionEligibilityPolicy } from "@/lib/control-plane/domain/revision-execution-eligibility";
import { createMySqlRevisionExecutionEvidenceReader } from "@/lib/control-plane/persistence/mysql-revision-execution-evidence-reader";

import { extractRequiredCapabilities } from "@/lib/control-plane/domain/revision-execution-eligibility";
// AgentRevision 读取 requiredCapabilities
import { agentRevisionTable } from "@/lib/persistence/schema/agents";

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
  /** : Resolver 冻结的精确证据 ID。 */
  frozenEvidence: {
    agentPublicationRecordId: string;
    runtimePublicationRecordId: string;
    agentAttestationIds: string[];
    runtimeAttestationIds: string[];
    conformanceRunId: string;
  };
}

export interface BindingEligibilityResult {
  valid: boolean;
  /** 校验失败原因。 */
  reason?: string;
  /** Projection 版本是否一致。 */
  projectionVersionMatch: boolean;
}

/** : 事务类型 — 使用共享 DbOrTx（支持 db + tx）。 */

/**
 * /: ExecutionBinding 最终 Fail-closed 校验。
 *
 * tx 必须传入 — 不允许独立调用模式。
 * 所有 DB 读取使用 tx，不使用全局 db。
 */
export async function validateBindingEligibility(
  tx: DbOrTx,
  input: BindingEligibilityInput,
): Promise<BindingEligibilityResult> {
  // A. 校验 Projection 版本
  const [projection] = await tx
    .select()
    .from(routeEligibilityProjection)
    .where(eq(routeEligibilityProjection.routeId, input.routeId))
    .limit(1);

  const projectionVersionMatch = projection
    ? projection.projectionVersionNo === input.projectionVersionNo
    : false;

  // : Projection 版本过时 → ELIGIBILITY_SNAPSHOT_STALE
  if (input.projectionVersionNo !== undefined && !projectionVersionMatch) {
    return {
      valid: false,
      reason: "eligibility_snapshot_stale",
      projectionVersionMatch,
    };
  }

  // B. 校验 Route Activation — 指定 routeActivationId + 最新 sequence + active 状态
  const [currentActivation] = await tx
    .select()
    .from(routeActivation)
    .where(eq(routeActivation.routeId, input.routeId))
    .orderBy(desc(routeActivation.activationSequence))
    .limit(1);

  if (!currentActivation) {
    return { valid: false, reason: "route_activation_not_found", projectionVersionMatch };
  }
  if (currentActivation.id !== input.routeActivationId) {
    return { valid: false, reason: "route_activation_superseded", projectionVersionMatch };
  }
  if (currentActivation.routeRevisionId !== input.routeRevisionId) {
    return { valid: false, reason: "route_revision_mismatch", projectionVersionMatch };
  }
  if (currentActivation.activationState !== "active") {
    return { valid: false, reason: "route_activation_not_active", projectionVersionMatch };
  }

  // : C. 使用统一 Reader + tx 加载精确证据快照
  const evidenceReader = createMySqlRevisionExecutionEvidenceReader({ db: tx });
  const [agentRevisionRow] = await tx
    .select()
    .from(agentRevisionTable)
    .where(eq(agentRevisionTable.id, input.agentRevisionId))
    .limit(1);

  const requiredCapabilities = extractRequiredCapabilities(
    agentRevisionRow?.agentInterfaceRequirementsJson,
  );

  const snapshot = await evidenceReader.loadExactEvidence({
    tenantId: input.tenantId,
    agentRevisionId: input.agentRevisionId,
    runtimeRevisionId: input.runtimeRevisionId,
    policyRevisionId: input.policyRevisionId,
    conformanceRunId: input.frozenEvidence.conformanceRunId,
  });

  // : D. 验证精确证据 ID — Projection 冻结的证据 ID 必须与当前权威一致
  {
    const fe = input.frozenEvidence;
    const currentAgentPubId = snapshot.agentPublication?.publicationRecordId ?? null;
    const currentRuntimePubId = snapshot.runtimePublication?.publicationRecordId ?? null;
    const currentConformanceRunId = snapshot.runtimePublication?.conformanceRunId ?? null;

    if (fe.agentPublicationRecordId !== currentAgentPubId) {
      return { valid: false, reason: "eligibility_snapshot_stale", projectionVersionMatch };
    }
    if (fe.runtimePublicationRecordId !== currentRuntimePubId) {
      return { valid: false, reason: "eligibility_snapshot_stale", projectionVersionMatch };
    }
    if (fe.conformanceRunId !== currentConformanceRunId) {
      return { valid: false, reason: "eligibility_snapshot_stale", projectionVersionMatch };
    }
    // Attestation IDs 必须与 Publication 绑定的完整集合精确相等。
    if (
      !exactEvidenceIdsEqual(
        fe.agentAttestationIds,
        snapshot.agentPublication?.attestationIds ?? [],
      )
    ) {
      return { valid: false, reason: "eligibility_snapshot_stale", projectionVersionMatch };
    }
    if (
      !exactEvidenceIdsEqual(
        fe.runtimeAttestationIds,
        snapshot.runtimePublication?.attestationIds ?? [],
      )
    ) {
      return { valid: false, reason: "eligibility_snapshot_stale", projectionVersionMatch };
    }
  }

  // §03: E. 调用统一 Policy 校验
  const eligibilityResult = RevisionExecutionEligibilityPolicy.isEligible(
    snapshot,
    requiredCapabilities,
  );

  if (!eligibilityResult.eligible) {
    const reason = eligibilityResult.errors.map((e) => e.code).join(",");
    return { valid: false, reason, projectionVersionMatch };
  }

  return { valid: true, projectionVersionMatch };
}

export function exactEvidenceIdsEqual(frozenIds: string[], currentIds: string[]): boolean {
  if (!validEvidenceIds(frozenIds) || !validEvidenceIds(currentIds)) return false;
  if (frozenIds.length !== currentIds.length) return false;
  const frozen = [...frozenIds].sort();
  const current = [...currentIds].sort();
  return frozen.every((id, index) => id === current[index]);
}

function validEvidenceIds(ids: string[]): boolean {
  return ids.length > 0 && ids.every((id) => id.length > 0) && new Set(ids).size === ids.length;
}

/**
 * : ELIGIBILITY_SNAPSHOT_STALE 错误 — Dispatcher 可对此执行一次重新解析 + 重试。
 */
export class EligibilitySnapshotStaleError extends Error {
  constructor(
    public readonly routeId: string,
    public readonly detail: string,
  ) {
    super(`Eligibility snapshot stale for route ${routeId}: ${detail}`);
    this.name = "EligibilitySnapshotStaleError";
  }
}
