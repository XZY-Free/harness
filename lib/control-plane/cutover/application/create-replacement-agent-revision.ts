/**
 * CreateReplacementAgentRevision — 为历史 AgentRevision 创建替代版本。
 *
 * 流程：
 * 1. 读取源 AgentRevision（确认 tenant 一致）
 * 2. 锁定 Agent 的 Revision 序列（FOR UPDATE）
 * 3. 创建新 Revision，复制稳定业务配置：
 *    - modelPolicyJson
 *    - permissionRequirementsJson
 *    - delegationPolicyJson
 *    - agentInterfaceRequirementsJson
 *    - 新 agentArtifactRef（来自 Evidence Service）
 * 4. 新 Revision 随后走正式路径：Artifact → Attestation → PublishAgentRevision
 *
 * 冻结语义：不修改源 Revision，不删除任何历史事实。
 */

import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  agentRevisionTable,
  agentTable,
} from "@/lib/persistence/schema/agents";
import { and, desc, eq, max } from "drizzle-orm";

export interface ReplacementAgentRevisionResult {
  /** 新创建的 AgentRevision ID。 */
  replacementRevisionId: string;
  /** 新 Revision 的编号。 */
  replacementRevisionNo: number;
  /** 源 AgentRevision ID。 */
  sourceRevisionId: string;
  /** Agent ID。 */
  agentId: string;
}

export interface CreateReplacementAgentRevisionCommand {
  tenantId: string;
  /** 源 AgentRevision ID（需要重新认证的历史版本）。 */
  sourceRevisionId: string;
  /** 来自 Evidence Service 的新 Artifact Ref。 */
  newArtifactRef: string;
  /** 新 sourceRevision 标识。 */
  sourceRevision?: string;
  /** 创建者。 */
  createdBy: string;
}

export class ReplacementAgentRevisionSourceNotFoundError extends Error {
  constructor(public readonly revisionId: string) {
    super(`源 AgentRevision 不存在: ${revisionId}`);
    this.name = "ReplacementAgentRevisionSourceNotFoundError";
  }
}

export class ReplacementAgentRevisionTenantMismatchError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly expectedTenantId: string,
  ) {
    super(`AgentRevision ${revisionId} 不属于租户 ${expectedTenantId}`);
    this.name = "ReplacementAgentRevisionTenantMismatchError";
  }
}

/**
 * 创建 Replacement AgentRevision。
 *
 * 在事务内：
 * 1. FOR UPDATE 锁定 Agent
 * 2. 读取源 Revision 并验证 tenant
 * 3. 分配新 revisionNo
 * 4. 插入新 draft Revision，复制业务配置
 */
export async function createReplacementAgentRevision(
  command: CreateReplacementAgentRevisionCommand,
): Promise<ReplacementAgentRevisionResult> {
  return db.transaction(async (tx) => {
    // 1. 读取源 Revision
    const [sourceRevision] = await tx
      .select()
      .from(agentRevisionTable)
      .where(eq(agentRevisionTable.id, command.sourceRevisionId))
      .limit(1);

    if (!sourceRevision) {
      throw new ReplacementAgentRevisionSourceNotFoundError(command.sourceRevisionId);
    }

    // 2. 校验 tenant
    if (sourceRevision.agentId === null) {
      throw new ReplacementAgentRevisionSourceNotFoundError(command.sourceRevisionId);
    }

    const [agent] = await tx
      .select()
      .from(agentTable)
      .where(
        and(
          eq(agentTable.id, sourceRevision.agentId),
          eq(agentTable.tenantId, command.tenantId),
        ),
      )
      .limit(1)
      .for("update");

    if (!agent) {
      throw new ReplacementAgentRevisionTenantMismatchError(
        command.sourceRevisionId,
        command.tenantId,
      );
    }

    // 3. 分配新 revisionNo
    const [sequence] = await tx
      .select({ value: max(agentRevisionTable.revisionNo) })
      .from(agentRevisionTable)
      .where(eq(agentRevisionTable.agentId, agent.id));

    const replacementRevisionNo = (sequence?.value ?? 0) + 1;

    // 4. 创建新 draft Revision，复制业务配置
    const replacementId = randomUUID();
    await tx.insert(agentRevisionTable).values({
      id: replacementId,
      agentId: agent.id,
      revisionNo: replacementRevisionNo,
      sourceType: "code",
      sourceRevision: command.sourceRevision ?? `replacement:${command.sourceRevisionId}`,
      instructionHash: sourceRevision.instructionHash,
      agentArtifactRef: command.newArtifactRef,
      modelPolicyJson: sourceRevision.modelPolicyJson,
      permissionRequirementsJson: sourceRevision.permissionRequirementsJson,
      delegationPolicyJson: sourceRevision.delegationPolicyJson,
      agentInterfaceRequirementsJson: sourceRevision.agentInterfaceRequirementsJson,
      revisionState: "draft",
      createdBy: command.createdBy,
    });

    return {
      replacementRevisionId: replacementId,
      replacementRevisionNo,
      sourceRevisionId: command.sourceRevisionId,
      agentId: agent.id,
    };
  });
}
