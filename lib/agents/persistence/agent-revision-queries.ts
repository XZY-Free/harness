/**
 * AgentRevision 仓储。
 *
 * 事实源：docs/architecture/persistence.md 、
 * docs/architecture/domain-model.md 、
 * docs/architecture/agent-control-plane.md 。
 *
 * 职责：
 * - createDraftRevision：创建 draft Revision（revisionNo 在 Agent 内单调递增）。
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
import { db } from "@/lib/db/client";
import {
  type AgentRevisionRow,
  type AgentRevisionState,
  agentRevisionTable,
} from "@/lib/persistence/schema/agents";
import { and, desc, eq, max } from "drizzle-orm";

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
): Promise<AgentRevisionRow> {
  const revisionNo = await nextRevisionNo(params.agentId);
  const id = randomUUID();
  await db.insert(agentRevisionTable).values({
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
    .from(agentRevisionTable)
    .where(eq(agentRevisionTable.id, id))
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
): Promise<AgentRevisionRow> {
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
  if (patch.agentArtifactRef !== undefined) {
    updates.agentArtifactRef = patch.agentArtifactRef;
    updates.artifactId = null;
    updates.artifactDigest = null;
  }
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

  await db.update(agentRevisionTable).set(updates).where(eq(agentRevisionTable.id, revisionId));
  return (await getRevisionById(revisionId)) as AgentRevisionRow;
}

/** 按 id 获取 Revision。不存在返回 null。 */
export async function getRevisionById(revisionId: string): Promise<AgentRevisionRow | null> {
  const [row] = await db
    .select()
    .from(agentRevisionTable)
    .where(eq(agentRevisionTable.id, revisionId))
    .limit(1);
  return row ?? null;
}

/** 按 Agent 列出所有 Revision（按 revisionNo 降序）。 */
export async function getRevisionsByAgent(
  agentId: string,
  options?: { revisionState?: AgentRevisionState },
): Promise<AgentRevisionRow[]> {
  const conditions = [eq(agentRevisionTable.agentId, agentId)];
  if (options?.revisionState) {
    conditions.push(eq(agentRevisionTable.revisionState, options.revisionState));
  }
  return db
    .select()
    .from(agentRevisionTable)
    .where(and(...conditions))
    .orderBy(desc(agentRevisionTable.revisionNo));
}

/** 获取 Agent 的最新 published Revision（用于路由查询）。 */
export async function getLatestPublishedRevision(
  agentId: string,
): Promise<AgentRevisionRow | null> {
  const list = await db
    .select()
    .from(agentRevisionTable)
    .where(
      and(
        eq(agentRevisionTable.agentId, agentId),
        eq(agentRevisionTable.revisionState, "published"),
      ),
    )
    .orderBy(desc(agentRevisionTable.revisionNo))
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
    .select({ maxNo: max(agentRevisionTable.revisionNo) })
    .from(agentRevisionTable)
    .where(eq(agentRevisionTable.agentId, agentId));
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
export type { AgentRevisionState, AgentRevisionRow } from "@/lib/persistence/schema/agents";
export {
  AGENT_REVISION_STATES,
  AGENT_REVISION_SOURCE_TYPES,
} from "@/lib/persistence/schema/agents";
