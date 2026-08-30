/**
 * ExecutionBinding 最终校验 — 单事务内 Fail-closed 校验。
 *
 * 冻结架构：ExecutionBinding 只绑定 Harness Runtime，不再携带任何 Agent evidence。
 * 因此本校验是纯 Runtime 维度（Runtime Publication / Attestation / Conformance / Lifecycle +
 * Policy），不读取 AgentRevision、不检查 Agent Publication、不做 capability 交叉校验。
 *
 * tx 必须传入，不允许可选。该函数不从其他 Application 或 API 直接调用。
 * 禁止全局 db；所有读取使用 Binding Store 创建的同一事务。
 * Projection 冻结的证据 ID 必须与当前权威一致。
 */

import type { DbOrTx } from "@/lib/db/client";
import { routeActivation } from "@/lib/routes/persistence/route-revision-record";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { desc, eq } from "drizzle-orm";

// 统一 Policy + Reader
import { RevisionExecutionEligibilityPolicy } from "@/lib/control-plane/domain/revision-execution-eligibility";
import { createMySqlRevisionExecutionEvidenceReader } from "@/lib/control-plane/persistence/mysql-revision-execution-evidence-reader";

export interface BindingEligibilityInput {
  tenantId: string;
  routeId: string;
  /** Resolver 冻结的 RouteRevisionId。 */
  routeRevisionId: string;
  /** Resolver 冻结的 RouteActivationId。 */
  routeActivationId: string;
  /** Resolver 冻结的 RuntimeRevisionId。 */
  runtimeRevisionId: string;
  /** Resolver 冻结的 PolicyRevisionId（可 null）。 */
  policyRevisionId: string | null;
  /** Projection 版本号 — 用于检测 Projection 滞后。 */
  projectionVersionNo: number;
  /** Resolver 冻结的精确 Runtime 证据 ID。 */
  frozenEvidence: {
    runtimePublicationRecordId: string;
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

/** 事务类型 — 使用共享 DbOrTx（支持 db + tx）。 */

/**
 * ExecutionBinding 最终 Fail-closed 校验。
 *
 * tx 必须传入 — 不允许独立调用模式。
 * 所有 DB 读取使用 tx，不使用全局 db。
 */
export async function validateBindingEligibility(
  tx: DbOrTx,
  input: BindingEligibilityInput,
): Promise<BindingEligibilityResult> {
  // A. 校验 Projection — 读取其他权威之前，先 fail-closed 确认投影是精确 runtime target。
  const [projection] = await tx
    .select()
    .from(routeEligibilityProjection)
    .where(eq(routeEligibilityProjection.routeId, input.routeId))
    .limit(1);

  // ExecutionBinding 只绑定 Harness Runtime：Projection 必须 targetKind=runtime 且
  // Agent 目标事实全部不适用（null）。Agent/混合/缺失 runtime 事实一律拒绝，不用
  // nullable fallback。任何不一致都视为快照漂移，由 Dispatcher 重试。
  if (
    !projection ||
    projection.targetKind !== "runtime" ||
    // runtime target 稳定身份必须为 "runtime"，且归属 Agent ID 必须为 null。
    projection.targetIdentity !== "runtime" ||
    projection.agentId !== null ||
    projection.runtimeRevisionId === null ||
    projection.runtimeRevisionId !== input.runtimeRevisionId ||
    projection.agentRevisionId !== null ||
    projection.agentEndpointRef !== null ||
    projection.agentIdentityMode !== null ||
    projection.agentCredentialRefId !== null ||
    projection.agentNetworkZone !== null ||
    projection.agentRevisionState !== null ||
    projection.agentLifecycleState !== null ||
    projection.agentPublicationActive !== null ||
    projection.agentEvidenceValid !== null ||
    projection.agentPublicationRecordId !== null ||
    projection.agentContractSnapshotId !== null ||
    projection.agentContractDigest !== null ||
    projection.agentContextDigest !== null
  ) {
    return {
      valid: false,
      reason: "eligibility_snapshot_stale",
      projectionVersionMatch: false,
    };
  }

  const projectionVersionMatch = projection.projectionVersionNo === input.projectionVersionNo;

  // Projection 版本过时 → ELIGIBILITY_SNAPSHOT_STALE
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

  // C. 使用统一 Reader + tx 加载精确证据快照
  // ExecutionBinding 恒为 runtime target：不读取 Agent 维度。
  const evidenceReader = createMySqlRevisionExecutionEvidenceReader({ db: tx });
  const snapshot = await evidenceReader.loadExactEvidence({
    kind: "runtime",
    tenantId: input.tenantId,
    runtimeRevisionId: input.runtimeRevisionId,
    policyRevisionId: input.policyRevisionId,
    conformanceRunId: input.frozenEvidence.conformanceRunId,
  });
  if (snapshot.kind !== "runtime") {
    return { valid: false, reason: "eligibility_target_mismatch", projectionVersionMatch };
  }

  // D. 验证精确证据 ID — Projection 冻结的 Runtime 证据 ID 必须与当前权威一致
  {
    const fe = input.frozenEvidence;
    const currentRuntimePubId = snapshot.runtimePublication?.publicationRecordId ?? null;
    const currentConformanceRunId = snapshot.runtimePublication?.conformanceRunId ?? null;

    if (fe.runtimePublicationRecordId !== currentRuntimePubId) {
      return { valid: false, reason: "eligibility_snapshot_stale", projectionVersionMatch };
    }
    if (fe.conformanceRunId !== currentConformanceRunId) {
      return { valid: false, reason: "eligibility_snapshot_stale", projectionVersionMatch };
    }
    // Runtime Attestation IDs 必须与 Publication 绑定的完整集合精确相等。
    // external_endpoint Runtime 无 Artifact Attestation（不伪造）→ 空集合合法；
    // hosted_artifact 仍要求非空全集。
    const externalRuntime = snapshot.runtimeEvidenceKind === "external_endpoint";
    const runtimeAttestationsExact = externalRuntime
      ? exactEvidenceIdsAllowEmpty(
          fe.runtimeAttestationIds,
          snapshot.runtimePublication?.attestationIds ?? [],
        )
      : exactEvidenceIdsEqual(
          fe.runtimeAttestationIds,
          snapshot.runtimePublication?.attestationIds ?? [],
        );
    if (!runtimeAttestationsExact) {
      return { valid: false, reason: "eligibility_snapshot_stale", projectionVersionMatch };
    }
  }

  // E. 调用统一 Policy 校验（Runtime 维度 + Policy；无 Agent / capability 交叉校验）
  const eligibilityResult = RevisionExecutionEligibilityPolicy.isEligible(snapshot);

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

/**
 * external_endpoint 变体：Runtime Attestation 集合允许为空（无 Artifact，03 §3），
 * 但非空时仍要求元素非空且唯一，并与当前权威精确相等。
 */
export function exactEvidenceIdsAllowEmpty(frozenIds: string[], currentIds: string[]): boolean {
  if (frozenIds.length === 0 && currentIds.length === 0) return true;
  if (!validEvidenceIds(frozenIds) || !validEvidenceIds(currentIds)) return false;
  return exactEvidenceIdsEqual(frozenIds, currentIds);
}

function validEvidenceIds(ids: string[]): boolean {
  return ids.length > 0 && ids.every((id) => id.length > 0) && new Set(ids).size === ids.length;
}

/**
 * ELIGIBILITY_SNAPSHOT_STALE 错误；Dispatcher 可对此执行一次重新解析与重试。
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
