/**
 * §6.1: Hosted Provisioning Request AgentRevision 精确绑定验证。
 *
 * 创建 ProvisioningRequest 前必须验证：
 * 1. AgentRevision 存在
 * 2. 属于指定的 Agent
 * 3. 属于指定的 Tenant
 * 4. 是 Agent 当前期望供应的 Revision（currentRevisionId）
 *
 * 禁止 agentRevisionId = "unknown"。
 */

import { db } from "@/lib/db/client";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/control-plane";
import { and, eq } from "drizzle-orm";

/** 验证结果。 */
export interface RevisionValidationResult {
  valid: true;
  /** 验证通过的 AgentRevision 行。 */
  revisionId: string;
  /** Revision 所属 Agent 的当前 Revision ID（确认一致）。 */
  currentRevisionId: string;
}

export interface RevisionValidationFailure {
  valid: false;
  /** 错误码。 */
  code: "REVISION_NOT_FOUND" | "REVISION_NOT_BELONG_TO_AGENT" | "REVISION_NOT_CURRENT" | "AGENT_NOT_FOUND" | "REVISION_ID_UNKNOWN";
  /** 人类可读原因。 */
  reason: string;
}

/** AgentRevision 验证依赖（可测试）。 */
export interface RevisionValidationDeps {
  /** 查询 AgentRevision 行 + 归属 Agent 验证。 */
  validateRevision(params: {
    tenantId: string;
    agentId: string;
    agentRevisionId: string;
  }): Promise<RevisionValidationResult | RevisionValidationFailure>;
}

/**
 * 生产实现：从 DB 读取并验证 AgentRevision。
 */
export async function validateAgentRevisionForProvisioning(params: {
  tenantId: string;
  agentId: string;
  agentRevisionId: string;
}): Promise<RevisionValidationResult | RevisionValidationFailure> {
  const { tenantId, agentId, agentRevisionId } = params;

  // §6.1: 禁止 "unknown"
  if (agentRevisionId === "unknown" || !agentRevisionId) {
    return {
      valid: false,
      code: "REVISION_ID_UNKNOWN",
      reason: `agentRevisionId 不允许为 "unknown" 或空值`,
    };
  }

  // 查询 Agent（含租户隔离）
  const [agent] = await db
    .select({
      id: agentTable.id,
      currentRevisionId: agentTable.currentRevisionId,
    })
    .from(agentTable)
    .where(and(eq(agentTable.tenantId, tenantId), eq(agentTable.id, agentId)))
    .limit(1);

  if (!agent) {
    return {
      valid: false,
      code: "AGENT_NOT_FOUND",
      reason: `Agent ${agentId} 在租户 ${tenantId} 下不存在`,
    };
  }

  // 查询 AgentRevision 并验证归属
  const [revision] = await db
    .select({ id: agentRevisionTable.id, agentId: agentRevisionTable.agentId })
    .from(agentRevisionTable)
    .where(eq(agentRevisionTable.id, agentRevisionId))
    .limit(1);

  if (!revision) {
    return {
      valid: false,
      code: "REVISION_NOT_FOUND",
      reason: `AgentRevision ${agentRevisionId} 不存在`,
    };
  }

  if (revision.agentId !== agentId) {
    return {
      valid: false,
      code: "REVISION_NOT_BELONG_TO_AGENT",
      reason: `AgentRevision ${agentRevisionId} 属于 Agent ${revision.agentId}，不属于指定 Agent ${agentId}`,
    };
  }

  // §6.1: 验证是 Agent 当前期望供应的 Revision
  if (agent.currentRevisionId !== agentRevisionId) {
    return {
      valid: false,
      code: "REVISION_NOT_CURRENT",
      reason: `AgentRevision ${agentRevisionId} 不是 Agent ${agentId} 的当前期望 Revision（currentRevisionId=${agent.currentRevisionId ?? "null"}）`,
    };
  }

  return {
    valid: true,
    revisionId: agentRevisionId,
    currentRevisionId: agent.currentRevisionId,
  };
}

/** 创建可注入依赖的验证器工厂。 */
export function createRevisionValidator(
  impl: RevisionValidationDeps["validateRevision"] = validateAgentRevisionForProvisioning,
): RevisionValidationDeps {
  return { validateRevision: impl };
}
