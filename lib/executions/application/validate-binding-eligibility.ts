/**
 * ExecutionBinding 最终校验 — §5.1/§03: 使用统一 RevisionExecutionEligibilityPolicy + Reader。
 *
 * §6.1: 校验在 Store.create() 事务内执行（接受 tx 参数），不再独立开事务。
 *
 * Fail-closed 校验维度（统一 Policy 内）：
 *   1. Agent Publication Active
 *   2. Agent Attestation Verified & 未撤销
 *   3. Agent 生命周期 Active
 *   4. Runtime Publication Active
 *   5. Runtime Attestation Verified & 未撤销
 *   6. Runtime Conformance Passed & 完整
 *   7. Runtime 生命周期 Active
 *   8. Capability 兼容
 *   9. Policy 状态
 */

import { db } from "@/lib/db/client";
import { routeActivation } from "@/lib/routes/persistence/route-revision-record";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { desc, eq } from "drizzle-orm";

// §03: 统一 Policy + Reader（从 control-plane/domain 和 control-plane/application）
import {
  RevisionExecutionEligibilityPolicy,
} from "@/lib/control-plane/domain/revision-execution-eligibility";
import {
  createMySqlRevisionExecutionEvidenceReader,
} from "@/lib/control-plane/persistence/mysql-revision-execution-evidence-reader";

// AgentRevision 读取 requiredCapabilities
import { agentRevisionTable } from "@/lib/persistence/schema/agents";
import { extractRequiredCapabilities } from "@/lib/control-plane/domain/revision-execution-eligibility";

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

/** §6.1: 事务类型 — 与 db.transaction 回调签名一致。 */
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * §6.1: ExecutionBinding 最终 Fail-closed 校验。
 *
 * 接受可选的 tx 参数：
 * - tx 提供：在调用方事务内执行（统一事务模式）
 * - tx 未提供：自行开事务执行（独立调用模式，向后兼容）
 *
 * Evidence Readers 始终使用全局 db（不需要事务一致性）。
 */
export async function validateBindingEligibility(
  input: BindingEligibilityInput,
  tx?: Transaction,
): Promise<BindingEligibilityResult> {
  const execute = async (tx: Transaction): Promise<BindingEligibilityResult> => {
    // A. 校验 Projection 版本
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

    // B. §5.3: 校验 Route Activation — 指定 routeActivationId + 最新 sequence + active 状态
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

    // §03: C. 使用统一 Reader 加载精确证据快照（使用 Resolver 冻结的 conformanceRunId）
    const evidenceReader = createMySqlRevisionExecutionEvidenceReader({ db });
    // 读取 AgentRevision 获取 requiredCapabilities
    const [agentRevisionRow] = await db
      .select()
      .from(agentRevisionTable)
      .where(eq(agentRevisionTable.id, input.agentRevisionId))
      .limit(1);

    const requiredCapabilities = extractRequiredCapabilities(
      agentRevisionRow?.agentInterfaceRequirementsJson,
    );

    // 从 runtimePublication 读取 conformanceRunId 用于精确加载
    // 统一 Reader 的 loadExactEvidence 使用冻结的 conformanceRunId
    const snapshot = await evidenceReader.loadExactEvidence({
      tenantId: input.tenantId,
      agentRevisionId: input.agentRevisionId,
      runtimeRevisionId: input.runtimeRevisionId,
      policyRevisionId: input.policyRevisionId,
      // conformanceRunId 从 RouteActivation 冻结的 Revision 关联的 Publication 推导
      // 统一 Reader 内部从 runtimePublication.conformanceRunId 获取
      conformanceRunId: null, // Reader 内部从 Publication 获取
    });

    // §03: D. 调用统一 Policy 校验
    const eligibilityResult = RevisionExecutionEligibilityPolicy.isEligible(
      snapshot,
      requiredCapabilities,
    );

    if (!eligibilityResult.eligible) {
      const reason = eligibilityResult.errors.map((e) => e.code).join(",");
      return { valid: false, reason, projectionVersionMatch };
    }

    return { valid: true, projectionVersionMatch };
  };

  // §6.1: 统一事务模式 — tx 提供时直接复用
  if (tx) {
    return execute(tx);
  }
  // §6.1: 独立调用模式 — 自行开事务（向后兼容）
  return db.transaction(execute);
}
