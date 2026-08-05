/**
 * Agent 仓储。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §4.1-4.2、
 *         ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md S03-W01。
 *
 * 职责：
 * - createAgent：创建稳定 Agent 身份（租户内 agentKey 唯一）。
 * - updateAgentLifecycle：变更 lifecycle 状态（draft/enabled/disabled/retired 终态）。
 * - setCurrentRevision：设置 currentRevisionId（必须指向同 Agent 的 published Revision）。
 * - getAgent/getAgentByKey/listAgents：查询。
 *
 * AgentRevision 仓储（agent-revision-queries.ts）：
 * - createDraftRevision：创建 draft Revision（revisionNo 单调递增）。
 * - publishRevision：draft → published（业务内容固化，写 publishedAt）。
 * - withdrawRevision：published → withdrawn（只阻止新发布/路由，不删除历史引用）。
 * - getRevision/getRevisionsByAgent/getPublishedRevision：查询。
 *
 * 跨租户隔离：所有查询按 tenantId 过滤。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  type AgentLifecycleState,
  type AgentRow,
  agentTable,
} from "@/lib/persistence/schema/agents";
import { and, eq, isNull } from "drizzle-orm";

/** 创建稳定 Agent 身份。 */
export async function createAgent(params: {
  tenantId: string;
  agentKey: string;
  displayName: string;
  description?: string | null;
  ownerUserId: string;
  visibilityPolicyId?: string | null;
  lifecycleState?: AgentLifecycleState;
}): Promise<AgentRow> {
  const id = randomUUID();
  await db.insert(agentTable).values({
    id,
    tenantId: params.tenantId,
    agentKey: params.agentKey,
    displayName: params.displayName,
    description: params.description ?? null,
    ownerUserId: params.ownerUserId,
    visibilityPolicyId: params.visibilityPolicyId ?? null,
    lifecycleState: params.lifecycleState ?? "draft",
  });
  const [row] = await db.select().from(agentTable).where(eq(agentTable.id, id)).limit(1);
  if (!row) {
    throw new Error(`createAgent: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 Agent。不存在返回 null。 */
export async function getAgentById(tenantId: string, agentId: string): Promise<AgentRow | null> {
  const [row] = await db
    .select()
    .from(agentTable)
    .where(and(eq(agentTable.tenantId, tenantId), eq(agentTable.id, agentId)))
    .limit(1);
  return row ?? null;
}

/** 按 agentKey 获取 Agent。不存在返回 null。 */
export async function getAgentByKey(tenantId: string, agentKey: string): Promise<AgentRow | null> {
  const [row] = await db
    .select()
    .from(agentTable)
    .where(and(eq(agentTable.tenantId, tenantId), eq(agentTable.agentKey, agentKey)))
    .limit(1);
  return row ?? null;
}

/** 列出租户内 Agent（含 lifecycle 过滤；不含软删）。 */
export async function listAgents(
  tenantId: string,
  options?: { lifecycleState?: AgentLifecycleState; includeDeleted?: boolean },
): Promise<AgentRow[]> {
  const conditions = [eq(agentTable.tenantId, tenantId)];
  if (options?.lifecycleState) {
    conditions.push(eq(agentTable.lifecycleState, options.lifecycleState));
  }
  if (!options?.includeDeleted) {
    conditions.push(isNull(agentTable.deletedAt));
  }
  return db
    .select()
    .from(agentTable)
    .where(and(...conditions));
}

/**
 * 变更 Agent lifecycle 状态。
 *
 * 约束：
 * - retired 是终态，不可再变更（fail-closed）。
 * - draft → enabled/disabled、enabled ↔ disabled 均允许。
 * - 状态变更通过乐观锁：versionNo 不匹配返回 false。
 */
export async function updateAgentLifecycle(
  tenantId: string,
  agentId: string,
  nextState: AgentLifecycleState,
  expectedVersionNo: number,
): Promise<AgentRow | null> {
  const current = await getAgentById(tenantId, agentId);
  if (!current) return null;
  if (current.lifecycleState === "retired") {
    throw new AgentLifecycleError(
      agentId,
      current.lifecycleState,
      nextState,
      "retired 是终态，不可再变更",
    );
  }
  if (current.versionNo !== expectedVersionNo) {
    return null; // 乐观锁冲突，调用方应返回 412
  }

  const result = await db
    .update(agentTable)
    .set({
      lifecycleState: nextState,
      versionNo: current.versionNo + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentTable.tenantId, tenantId),
        eq(agentTable.id, agentId),
        eq(agentTable.versionNo, expectedVersionNo),
      ),
    );

  if (result[0].affectedRows === 0) return null;
  return getAgentById(tenantId, agentId);
}

/**
 * 设置 currentRevisionId（必须在同事务或调用方保证 Revision 属于同 Agent 且 published）。
 *
 * 注意：本函数只更新字段，不校验 Revision 归属与状态；调用方（agent-revision-queries.publishRevision）
 * 必须先校验 Revision 状态后调用本函数。
 */
export async function setCurrentRevision(
  tenantId: string,
  agentId: string,
  revisionId: string | null,
  expectedVersionNo: number,
): Promise<AgentRow | null> {
  const result = await db
    .update(agentTable)
    .set({
      currentRevisionId: revisionId,
      versionNo: expectedVersionNo + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentTable.tenantId, tenantId),
        eq(agentTable.id, agentId),
        eq(agentTable.versionNo, expectedVersionNo),
      ),
    );

  if (result[0].affectedRows === 0) return null;
  return getAgentById(tenantId, agentId);
}

/** 软删除 Agent（仅 draft/disabled 允许；enabled/retired 拒绝）。 */
export async function softDeleteAgent(
  tenantId: string,
  agentId: string,
  expectedVersionNo: number,
): Promise<boolean> {
  const current = await getAgentById(tenantId, agentId);
  if (!current) return false;
  if (current.lifecycleState === "enabled" || current.lifecycleState === "retired") {
    throw new AgentLifecycleError(
      agentId,
      current.lifecycleState,
      current.lifecycleState,
      `${current.lifecycleState} 状态不允许软删除，请先 disable`,
    );
  }
  if (current.versionNo !== expectedVersionNo) return false;

  const result = await db
    .update(agentTable)
    .set({
      deletedAt: new Date(),
      versionNo: expectedVersionNo + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentTable.tenantId, tenantId),
        eq(agentTable.id, agentId),
        eq(agentTable.versionNo, expectedVersionNo),
        isNull(agentTable.deletedAt),
      ),
    );

  return result[0].affectedRows > 0;
}

/** Agent 生命周期错误。 */
export class AgentLifecycleError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly fromState: AgentLifecycleState,
    public readonly toState: AgentLifecycleState,
    message: string,
  ) {
    super(message);
    this.name = "AgentLifecycleError";
  }
}

/** Re-export 供外部统一从本模块引入类型。 */
export type { AgentLifecycleState, AgentRow } from "@/lib/persistence/schema/agents";
export { AGENT_LIFECYCLE_STATES } from "@/lib/persistence/schema/agents";
