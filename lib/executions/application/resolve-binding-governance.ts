/**
 * ExecutionBinding 的 Policy/Governance 冻结解析（ · 冻结方案 §10 / §11 / §42）。
 *
 * Binding 时把四字段解析为最终非空值（§9）：
 * - PolicyRevision：RouteRevision.policyRevisionId != null → 用 Route 显式指定的 Revision；
 *   否则 → Tenant PolicySet("tool-execution").currentRevisionId（§10，effectivePolicyRevisionId 永远非空）。
 * - GovernanceRevision：Tenant GovernanceConfigSet("runtime-execution").currentRevisionId（§11，不由 Route 选）。
 *
 * 本函数是 Resolver/Binding 阶段的「解析提示」（hint）；真正权威 fail-closed 校验由
 * Store 在事务内重读 RouteRevision/PolicySet/PolicyRevision/GovernanceSet/GovernanceRevision
 * 并重算 digest 完成（§42：Projection 不是 Authority）。
 */
import type { DbOrTx } from "@/lib/db/client";
import { GOVERNANCE_CONFIG_SET_KEY } from "@/lib/governance/config";
import {
  GovernanceLoadError,
  loadGovernanceSetAndRevision,
} from "@/lib/governance/governance-repository";
import {
  POLICY_SET_KEY,
  PolicyLoadError,
  loadPolicySetAndRevision,
} from "@/lib/permission/policy-queries";
import { policyRevisionTable, policySetTable } from "@/lib/persistence/schema/permission";
import { eq } from "drizzle-orm";

/** 解析出的四字段冻结值。 */
export interface ResolvedBindingGovernance {
  policyRevisionId: string;
  policyRulesDigest: string;
  governanceConfigRevisionId: string;
  governanceConfigDigest: string;
}

/** Binding 治理解析失败（fail-closed，§10/§11）。 */
export class BindingGovernanceResolutionError extends Error {
  constructor(message: string) {
    super(`Binding 治理解析失败：${message}`);
    this.name = "BindingGovernanceResolutionError";
  }
}

function assertEnabledSet(lifecycleState: string, setKey: string): void {
  if (lifecycleState !== "enabled") {
    throw new BindingGovernanceResolutionError(
      `${setKey} 生命周期 ${lifecycleState} 不允许 Binding`,
    );
  }
}

/**
 * 解析有效 PolicyRevision + GovernanceRevision 四字段（§10/§11）。
 *
 * @param tx 事务或 db（作为 hint；Store 会在事务内权威复验）。
 * @param tenantId Invocation 租户。
 * @param routePolicyRevisionId RouteRevision.policyRevisionId（可 null → Tenant baseline fallback）。
 */
export async function resolveBindingGovernance(
  tx: DbOrTx,
  tenantId: string,
  routePolicyRevisionId: string | null,
): Promise<ResolvedBindingGovernance> {
  // ── Policy：Route explicit → Tenant baseline fallback（§10）──
  let policyRevisionId: string;
  let policyRulesDigest: string;
  if (routePolicyRevisionId) {
    const [rev] = await tx
      .select()
      .from(policyRevisionTable)
      .where(eq(policyRevisionTable.id, routePolicyRevisionId))
      .limit(1);
    if (!rev) {
      throw new BindingGovernanceResolutionError(
        `Route 指定的 PolicyRevision 不存在: ${routePolicyRevisionId}`,
      );
    }
    const [set] = await tx
      .select()
      .from(policySetTable)
      .where(eq(policySetTable.id, rev.policySetId))
      .limit(1);
    if (!set || set.tenantId !== tenantId) {
      throw new BindingGovernanceResolutionError("Route 指定的 PolicyRevision 跨租户");
    }
    assertEnabledSet(set.lifecycleState, `PolicySet(${set.policySetKey})`);
    if (rev.revisionState !== "published") {
      throw new BindingGovernanceResolutionError(
        `PolicyRevision ${rev.id} 非 published（${rev.revisionState}）`,
      );
    }
    policyRevisionId = rev.id;
    policyRulesDigest = rev.rulesHash;
  } else {
    const { set, revision } = await loadPolicySetAndRevision(tx, tenantId, POLICY_SET_KEY);
    if (!revision) {
      throw new BindingGovernanceResolutionError(
        `PolicySet(${POLICY_SET_KEY}) 无 currentRevisionId`,
      );
    }
    assertEnabledSet(set.lifecycleState, `PolicySet(${set.policySetKey})`);
    if (revision.revisionState !== "published") {
      throw new BindingGovernanceResolutionError(
        `PolicyRevision ${revision.id} 非 published（${revision.revisionState}）`,
      );
    }
    policyRevisionId = revision.id;
    policyRulesDigest = revision.rulesHash;
  }

  // ── Governance：Tenant current（§11，不由 Route 选）──
  let governanceConfigRevisionId: string;
  let governanceConfigDigest: string;
  try {
    const { set, revision } = await loadGovernanceSetAndRevision(
      tx,
      tenantId,
      GOVERNANCE_CONFIG_SET_KEY,
    );
    assertEnabledSet(set.lifecycleState, `GovernanceConfigSet(${set.configSetKey})`);
    if (revision.revisionState !== "published") {
      throw new BindingGovernanceResolutionError(
        `GovernanceConfigRevision ${revision.id} 非 published（${revision.revisionState}）`,
      );
    }
    governanceConfigRevisionId = revision.id;
    governanceConfigDigest = revision.configDigest;
  } catch (err) {
    if (err instanceof GovernanceLoadError) {
      throw new BindingGovernanceResolutionError(err.message);
    }
    throw err;
  }

  return {
    policyRevisionId,
    policyRulesDigest,
    governanceConfigRevisionId,
    governanceConfigDigest,
  };
}

// 保留导出，便于应用层复用错误类型（如 dispatcher 包装）。
export { PolicyLoadError };
