/**
 * ThreadRelation 仓储。
 *
 * 事实源：
 * - docs/architecture/persistence.md （ThreadRelation 表）
 * - docs/architecture/conversations.md §4（Fork 语义）
 * - docs/architecture/conversations.md
 *
 * 职责：
 * - createThreadRelation：创建 fork/delegate/workflow_child 关系。
 * - getRelationById/getRelationsByParent/getRelationsByChild：查询。
 * - updateRelationState：关系状态机转换。
 *
 * 约束（行 231-243）：
 * - UNIQUE(parent_thread_id, child_thread_id, relation_type)。
 * - parent 与 child 不能相同。
 * - handoff 不创建 ThreadRelation（行 231）。
 * - delegate 的 child Thread 创建、relation、父 child_thread Item 和两条 ThreadEvent
 * 必须由应用服务原子协调，Runtime 不能直写（行 240）。
 */
import { randomUUID } from "node:crypto";
import { ThreadRelationConflictError } from "@/lib/conversations/errors";
import { db } from "@/lib/db/client";
import {
  type ThreadRelation,
  type ThreadRelationState,
  type ThreadRelationType,
  threadRelationTable,
} from "@/lib/persistence/schema/conversation";
import { and, eq } from "drizzle-orm";

/** 创建 Thread 关系。parent 与 child 不能相同。 */
export async function createThreadRelation(params: {
  parentThreadId: string;
  childThreadId: string;
  relationType: ThreadRelationType;
  sourceTurnId?: string | null;
  sourceItemId?: string | null;
  sourceInvocationId?: string | null;
  targetAgentId?: string | null;
  taskPayloadRef?: string | null;
  taskPayloadHash?: string | null;
  contextTransferPolicyJson?: Record<string, unknown> | null;
  budgetPolicyJson?: Record<string, unknown> | null;
  itemId?: string | null;
}): Promise<ThreadRelation> {
  if (params.parentThreadId === params.childThreadId) {
    throw new Error("ThreadRelation 的 parent 和 child 不能相同");
  }

  // 检查是否已存在同 parent/child/type 的关系
  const existing = await db
    .select()
    .from(threadRelationTable)
    .where(
      and(
        eq(threadRelationTable.parentThreadId, params.parentThreadId),
        eq(threadRelationTable.childThreadId, params.childThreadId),
        eq(threadRelationTable.relationType, params.relationType),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    throw new ThreadRelationConflictError(
      params.parentThreadId,
      params.childThreadId,
      params.relationType,
    );
  }

  const id = randomUUID();
  await db.insert(threadRelationTable).values({
    id,
    parentThreadId: params.parentThreadId,
    childThreadId: params.childThreadId,
    relationType: params.relationType,
    sourceTurnId: params.sourceTurnId ?? null,
    sourceItemId: params.sourceItemId ?? null,
    sourceInvocationId: params.sourceInvocationId ?? null,
    targetAgentId: params.targetAgentId ?? null,
    taskPayloadRef: params.taskPayloadRef ?? null,
    taskPayloadHash: params.taskPayloadHash ?? null,
    contextTransferPolicyJson: params.contextTransferPolicyJson ?? null,
    budgetPolicyJson: params.budgetPolicyJson ?? null,
    relationState: "creating",
    itemId: params.itemId ?? null,
  });

  const [row] = await db
    .select()
    .from(threadRelationTable)
    .where(eq(threadRelationTable.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`createThreadRelation: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 ThreadRelation。不存在返回 null。 */
export async function getRelationById(relationId: string): Promise<ThreadRelation | null> {
  const [row] = await db
    .select()
    .from(threadRelationTable)
    .where(eq(threadRelationTable.id, relationId))
    .limit(1);
  return row ?? null;
}

/** 列出 parent Thread 的所有关系。 */
export async function getRelationsByParent(parentThreadId: string): Promise<ThreadRelation[]> {
  return db
    .select()
    .from(threadRelationTable)
    .where(eq(threadRelationTable.parentThreadId, parentThreadId));
}

/** 列出 child Thread 的所有关系。 */
export async function getRelationsByChild(childThreadId: string): Promise<ThreadRelation[]> {
  return db
    .select()
    .from(threadRelationTable)
    .where(eq(threadRelationTable.childThreadId, childThreadId));
}

/**
 * 更新 ThreadRelation 状态。
 *
 * 状态机（行 237）：
 * - creating → active
 * - active → cancel_requested → cancelled
 * - active → completed / failed
 * - cancel_requested → cancelled
 */
export async function updateRelationState(
  relationId: string,
  nextState: ThreadRelationState,
  updates?: {
    resultItemId?: string | null;
    resultRef?: string | null;
    resultHash?: string | null;
  },
): Promise<ThreadRelation | null> {
  const current = await getRelationById(relationId);
  if (!current) return null;

  const allowedTransitions: Record<ThreadRelationState, ThreadRelationState[]> = {
    creating: ["active", "failed", "cancelled"],
    active: ["cancel_requested", "completed", "failed", "cancelled"],
    cancel_requested: ["cancelled", "completed"],
    completed: [],
    failed: [],
    cancelled: [],
  };

  if (!allowedTransitions[current.relationState].includes(nextState)) {
    throw new Error(
      `ThreadRelation ${relationId} 状态 ${current.relationState} 不允许 → ${nextState}`,
    );
  }

  const setValues: Partial<typeof threadRelationTable.$inferInsert> = {
    relationState: nextState,
  };
  if (nextState === "completed" || nextState === "failed" || nextState === "cancelled") {
    setValues.completedAt = new Date();
  }
  if (updates?.resultItemId !== undefined) {
    setValues.resultItemId = updates.resultItemId;
  }
  if (updates?.resultRef !== undefined) {
    setValues.resultRef = updates.resultRef;
  }
  if (updates?.resultHash !== undefined) {
    setValues.resultHash = updates.resultHash;
  }

  await db.update(threadRelationTable).set(setValues).where(eq(threadRelationTable.id, relationId));
  return getRelationById(relationId);
}
