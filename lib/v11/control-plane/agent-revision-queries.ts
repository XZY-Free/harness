/**
 * V11 AgentRevision 仓储。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §4.2、
 *         ../v11-agentkit-platform/09-unified-domain-model.md §3.1、
 *         ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md S03-W01。
 *
 * 职责：
 * - createDraftRevision：创建 draft Revision（revisionNo 在 Agent 内单调递增）。
 * - publishRevision：draft → published（业务内容固化，写 publishedAt，回填 Agent.currentRevisionId）。
 * - withdrawRevision：published → withdrawn（只阻止新发布/路由，不删除历史引用）。
 * - updateDraftContent：仅 draft 状态可编辑业务内容（published/withdrawn 不可改）。
 * - getRevision/getRevisionsByAgent/getLatestPublishedRevision：查询。
 *
 * 不可变性约束：
 * - published Revision 业务内容不可修改（model_policy/instruction_hash/artifact_ref 等）。
 * - withdrawn 只变更 revisionState，不删除行，不修改业务内容。
 * - revisionNo 由 UNIQUE(agentId, revisionNo) 约束保证唯一；并发冲突时 fail-loud。
 *
 * 以下变化不生成 AgentRevision（应用层判断，不在本模块约束）：
 * - Skill 正文、Tool 描述或 Schema、Knowledge 内容、Memory 内容变化。
 * - RuntimeRevision 独立发布；由 DeploymentRoute 决定新 Invocation 使用哪个组合。
 */
import { randomUUID } from "node:crypto";
import { createWithdrawAgentRevision } from "@/lib/agents/application/withdraw-agent-revision";
import {
  AgentPublicationVersionConflictError,
  AgentRevisionPublicationNotFoundError,
  AgentRevisionPublicationStateError,
} from "@/lib/agents/domain/agent-revision-publication-policy";
import {
  AgentRevisionWithdrawalNotFoundError,
  AgentRevisionWithdrawalPublicationNotFoundError,
  AgentRevisionWithdrawalStateError,
  AgentWithdrawalVersionConflictError,
} from "@/lib/agents/domain/agent-revision-withdrawal-policy";
import { createPublishLegacyAgentRevision } from "@/lib/compatibility/agents/publish-agent-revision";
import { db } from "@/lib/db/client";
import { mysqlAgentPublicationStore } from "@/lib/v11/control-plane/mysql-agent-publication-store";
import { mysqlAgentWithdrawalStore } from "@/lib/v11/control-plane/mysql-agent-withdrawal-store";
import {
  type AgentRevisionState,
  type V11AgentRevision,
  v11Agent,
  v11AgentRevision,
} from "@/lib/v11/schema/agent";
import { and, desc, eq, max } from "drizzle-orm";

const publishLegacyAgentRevisionApplication = createPublishLegacyAgentRevision({
  store: mysqlAgentPublicationStore,
});
const withdrawAgentRevisionApplication = createWithdrawAgentRevision({
  store: mysqlAgentWithdrawalStore,
});

/** 创建 draft Revision 的入参。 */
export interface CreateDraftRevisionParams {
  tenantId: string;
  agentId: string;
  sourceType: string;
  sourceRevision: string;
  instructionHash: string;
  agentArtifactRef: string;
  modelPolicyJson: unknown;
  permissionRequirementsJson: unknown;
  delegationPolicyJson: unknown;
  agentInterfaceRequirementsJson: unknown;
  createdBy: string;
}

/**
 * 创建 draft Revision。
 *
 * revisionNo 由 Agent 内最大值 +1 计算（并发冲突由 UNIQUE 约束 fail-loud）。
 * 业务内容在 draft 状态可编辑（updateDraftContent），published 后不可改。
 */
export async function createDraftRevision(
  params: CreateDraftRevisionParams,
): Promise<V11AgentRevision> {
  const revisionNo = await nextRevisionNo(params.agentId);
  const id = randomUUID();
  await db.insert(v11AgentRevision).values({
    id,
    agentId: params.agentId,
    revisionNo,
    sourceType: params.sourceType,
    sourceRevision: params.sourceRevision,
    instructionHash: params.instructionHash,
    agentArtifactRef: params.agentArtifactRef,
    modelPolicyJson: params.modelPolicyJson,
    permissionRequirementsJson: params.permissionRequirementsJson,
    delegationPolicyJson: params.delegationPolicyJson,
    agentInterfaceRequirementsJson: params.agentInterfaceRequirementsJson,
    revisionState: "draft",
    createdBy: params.createdBy,
  });

  const [row] = await db
    .select()
    .from(v11AgentRevision)
    .where(eq(v11AgentRevision.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`createDraftRevision: 行未找到（id=${id}）`);
  }
  return row;
}

/** 仅 draft 状态可编辑业务内容；published/withdrawn 抛错（不可变）。 */
export async function updateDraftContent(
  revisionId: string,
  patch: {
    sourceRevision?: string;
    instructionHash?: string;
    agentArtifactRef?: string;
    modelPolicyJson?: unknown;
    permissionRequirementsJson?: unknown;
    delegationPolicyJson?: unknown;
    agentInterfaceRequirementsJson?: unknown;
  },
): Promise<V11AgentRevision> {
  const current = await getRevisionById(revisionId);
  if (!current) {
    throw new RevisionNotFoundError(revisionId);
  }
  if (current.revisionState !== "draft") {
    throw new RevisionImmutableError(revisionId, current.revisionState);
  }

  const updates: Record<string, unknown> = {};
  if (patch.sourceRevision !== undefined) updates.sourceRevision = patch.sourceRevision;
  if (patch.instructionHash !== undefined) updates.instructionHash = patch.instructionHash;
  if (patch.agentArtifactRef !== undefined) updates.agentArtifactRef = patch.agentArtifactRef;
  if (patch.modelPolicyJson !== undefined) updates.modelPolicyJson = patch.modelPolicyJson;
  if (patch.permissionRequirementsJson !== undefined) {
    updates.permissionRequirementsJson = patch.permissionRequirementsJson;
  }
  if (patch.delegationPolicyJson !== undefined) {
    updates.delegationPolicyJson = patch.delegationPolicyJson;
  }
  if (patch.agentInterfaceRequirementsJson !== undefined) {
    updates.agentInterfaceRequirementsJson = patch.agentInterfaceRequirementsJson;
  }

  if (Object.keys(updates).length === 0) return current;

  await db.update(v11AgentRevision).set(updates).where(eq(v11AgentRevision.id, revisionId));
  return (await getRevisionById(revisionId)) as V11AgentRevision;
}

/**
 * 发布 Revision：draft → published。
 *
 * - publishedAt 写当前时间。
 * - 业务内容自此不可修改。
 * - 与 Agent.currentRevisionId 乐观锁更新在同一事务提交；任一步失败都回滚。
 *
 * @throws RevisionNotFoundError Revision 不存在
 * @throws RevisionStateError Revision 非 draft 状态
 */
export async function publishRevision(
  tenantId: string,
  revisionId: string,
  agentExpectedVersionNo: number,
): Promise<V11AgentRevision> {
  try {
    await publishLegacyAgentRevisionApplication({
      tenantId,
      revisionId,
      agentExpectedVersionNo,
      requestId: randomUUID(),
    });
    const published = await getRevisionById(revisionId);
    if (!published) throw new RevisionNotFoundError(revisionId);
    return published;
  } catch (error) {
    if (error instanceof AgentRevisionPublicationNotFoundError) {
      throw new RevisionNotFoundError(error.revisionId);
    }
    if (error instanceof AgentRevisionPublicationStateError) {
      throw new RevisionStateError(error.revisionId, error.fromState, "published", error.message);
    }
    if (error instanceof AgentPublicationVersionConflictError) {
      throw new AgentVersionConflictError(error.agentId, error.expectedVersionNo);
    }
    throw error;
  }
}

/**
 * 撤回 Revision：published → withdrawn。
 *
 * - 不删除行，不修改业务内容。
 * - 只阻止新发布或路由引用；已开始的 ExecutionBinding 不受影响。
 * - 兼容入口委托正式 Application Service，原子写 WithdrawalRecord、投影、当前指针、Audit 和 Outbox。
 *
 * @throws RevisionNotFoundError Revision 不存在
 * @throws RevisionStateError Revision 非 published 状态
 */
export async function withdrawRevision(revisionId: string): Promise<V11AgentRevision> {
  const [row] = await db
    .select({ revision: v11AgentRevision, agent: v11Agent })
    .from(v11AgentRevision)
    .innerJoin(v11Agent, eq(v11Agent.id, v11AgentRevision.agentId))
    .where(eq(v11AgentRevision.id, revisionId))
    .limit(1);
  if (!row) {
    throw new RevisionNotFoundError(revisionId);
  }
  try {
    const result = await withdrawAgentRevisionApplication({
      tenantId: row.agent.tenantId,
      revisionId,
      agentExpectedVersionNo: row.agent.versionNo,
      actor: {
        tenantId: row.agent.tenantId,
        actorType: "system",
        actorId: "legacy-agent-revision-queries",
      },
      reasonCode: "legacy_compatibility",
      reason: "由兼容入口撤回 AgentRevision",
      requestId: randomUUID(),
    });
    return result.revision as V11AgentRevision;
  } catch (error) {
    if (error instanceof AgentRevisionWithdrawalNotFoundError) {
      throw new RevisionNotFoundError(error.revisionId);
    }
    if (error instanceof AgentRevisionWithdrawalStateError) {
      throw new RevisionStateError(error.revisionId, error.fromState, "withdrawn", error.message);
    }
    if (error instanceof AgentRevisionWithdrawalPublicationNotFoundError) {
      throw new RevisionStateError(revisionId, "published", "withdrawn", error.message);
    }
    if (error instanceof AgentWithdrawalVersionConflictError) {
      throw new AgentVersionConflictError(error.agentId, error.expectedVersionNo);
    }
    throw error;
  }
}

/** 按 id 获取 Revision。不存在返回 null。 */
export async function getRevisionById(revisionId: string): Promise<V11AgentRevision | null> {
  const [row] = await db
    .select()
    .from(v11AgentRevision)
    .where(eq(v11AgentRevision.id, revisionId))
    .limit(1);
  return row ?? null;
}

/** 按 Agent 列出所有 Revision（按 revisionNo 降序）。 */
export async function getRevisionsByAgent(
  agentId: string,
  options?: { revisionState?: AgentRevisionState },
): Promise<V11AgentRevision[]> {
  const conditions = [eq(v11AgentRevision.agentId, agentId)];
  if (options?.revisionState) {
    conditions.push(eq(v11AgentRevision.revisionState, options.revisionState));
  }
  return db
    .select()
    .from(v11AgentRevision)
    .where(and(...conditions))
    .orderBy(desc(v11AgentRevision.revisionNo));
}

/** 获取 Agent 的最新 published Revision（用于路由查询）。 */
export async function getLatestPublishedRevision(
  agentId: string,
): Promise<V11AgentRevision | null> {
  const list = await db
    .select()
    .from(v11AgentRevision)
    .where(
      and(eq(v11AgentRevision.agentId, agentId), eq(v11AgentRevision.revisionState, "published")),
    )
    .orderBy(desc(v11AgentRevision.revisionNo))
    .limit(1);
  return list[0] ?? null;
}

/**
 * 计算 Agent 内下一个 revisionNo（max +1）。
 *
 * 并发安全：UNIQUE(agentId, revisionNo) 约束保证唯一；并发冲突时 fail-loud，
 * 调用方应重试或返回 409。
 */
async function nextRevisionNo(agentId: string): Promise<number> {
  const [row] = await db
    .select({ maxNo: max(v11AgentRevision.revisionNo) })
    .from(v11AgentRevision)
    .where(eq(v11AgentRevision.agentId, agentId));
  const currentMax = row?.maxNo;
  if (currentMax === null || currentMax === undefined) return 1;
  return currentMax + 1;
}

/** Revision 不存在错误。 */
export class RevisionNotFoundError extends Error {
  constructor(public readonly revisionId: string) {
    super(`Revision 不存在: ${revisionId}`);
    this.name = "RevisionNotFoundError";
  }
}

/** Revision 状态错误（如 draft 已 published 后再 publish，或修改 published 内容）。 */
export class RevisionStateError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly fromState: AgentRevisionState,
    public readonly toState: AgentRevisionState,
    message: string,
  ) {
    super(message);
    this.name = "RevisionStateError";
  }
}

/** Revision 不可变错误（修改 published/withdrawn 业务内容）。 */
export class RevisionImmutableError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly state: AgentRevisionState,
  ) {
    super(`Revision ${revisionId} 状态为 ${state}，业务内容不可修改`);
    this.name = "RevisionImmutableError";
  }
}

/** Agent 乐观锁冲突（publishRevision 事务整体回滚）。 */
export class AgentVersionConflictError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly expectedVersionNo: number,
  ) {
    super(`Agent ${agentId} versionNo 不匹配（期望 ${expectedVersionNo}），乐观锁冲突`);
    this.name = "AgentVersionConflictError";
  }
}

/** Re-export 供外部统一从本模块引入类型。 */
export type { AgentRevisionState, V11AgentRevision } from "@/lib/v11/schema/agent";
export { AGENT_REVISION_STATES, AGENT_REVISION_SOURCE_TYPES } from "@/lib/v11/schema/agent";
