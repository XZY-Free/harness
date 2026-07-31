/**
 * V11 Goal 仓储。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §5.7（Goal 表）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §6（Goal 域模型）
 * - ../v11-agentkit-platform-development-plan/04-thread-turn-item-and-event-core.md S04-W01
 *
 * 职责：
 * - createGoal：创建 Goal（一个 Thread 最多一个 active）。
 * - getGoalById/getActiveGoalByThread：查询。
 * - updateGoalState：Goal 状态机转换。
 *
 * 约束（§5.7 行 341-343）：
 * - 一个 Thread 最多一个 active Goal（应用层校验，不依赖生成列）。
 * - 状态：active → blocked → active/completed/cancelled。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { GoalAlreadyActiveError } from "@/lib/v11/conversation/errors";
import { type GoalState, type V11Goal, v11Goal, v11Thread } from "@/lib/v11/schema/conversation";
import { and, eq } from "drizzle-orm";

/** 创建 Goal。若 Thread 已有 active Goal，抛 GoalAlreadyActiveError。 */
export async function createGoal(params: {
  threadId: string;
  objective: string;
  successCriteriaJson: Record<string, unknown>;
  constraintsJson?: Record<string, unknown> | null;
  currentStateJson?: Record<string, unknown> | null;
  createdBy: string;
}): Promise<V11Goal> {
  // 校验：一个 Thread 最多一个 active Goal
  const existing = await getActiveGoalByThread(params.threadId);
  if (existing) {
    throw new GoalAlreadyActiveError(params.threadId);
  }

  const id = randomUUID();
  await db.insert(v11Goal).values({
    id,
    threadId: params.threadId,
    objective: params.objective,
    successCriteriaJson: params.successCriteriaJson,
    constraintsJson: params.constraintsJson ?? null,
    currentStateJson: params.currentStateJson ?? null,
    goalState: "active",
    createdBy: params.createdBy,
  });

  const [row] = await db.select().from(v11Goal).where(eq(v11Goal.id, id)).limit(1);
  if (!row) {
    throw new Error(`createGoal: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 Goal。不存在返回 null。 */
export async function getGoalById(goalId: string): Promise<V11Goal | null> {
  const [row] = await db.select().from(v11Goal).where(eq(v11Goal.id, goalId)).limit(1);
  return row ?? null;
}

/** 获取 Thread 的 active Goal。不存在返回 null。 */
export async function getActiveGoalByThread(threadId: string): Promise<V11Goal | null> {
  const [row] = await db
    .select()
    .from(v11Goal)
    .where(and(eq(v11Goal.threadId, threadId), eq(v11Goal.goalState, "active")))
    .limit(1);
  return row ?? null;
}

/** 列出 Thread 的所有 Goal（含历史）。 */
export async function getGoalsByThread(threadId: string): Promise<V11Goal[]> {
  return db.select().from(v11Goal).where(eq(v11Goal.threadId, threadId));
}

/**
 * 更新 Goal 状态。
 *
 * 状态机：
 * - active → blocked / completed / cancelled
 * - blocked → active / cancelled
 * - completed/cancelled 是终态
 */
export async function updateGoalState(
  goalId: string,
  nextState: GoalState,
  updates?: {
    currentStateJson?: Record<string, unknown>;
  },
): Promise<V11Goal | null> {
  const current = await getGoalById(goalId);
  if (!current) return null;

  const allowedTransitions: Record<GoalState, GoalState[]> = {
    active: ["blocked", "completed", "cancelled"],
    blocked: ["active", "cancelled"],
    completed: [],
    cancelled: [],
  };

  if (!allowedTransitions[current.goalState].includes(nextState)) {
    throw new Error(`Goal ${goalId} 状态 ${current.goalState} 不允许 → ${nextState}`);
  }

  const setValues: Partial<typeof v11Goal.$inferInsert> = {
    goalState: nextState,
    updatedAt: new Date(),
  };
  if (nextState === "completed" || nextState === "cancelled") {
    setValues.completedAt = new Date();
  }
  if (updates?.currentStateJson) {
    setValues.currentStateJson = updates.currentStateJson;
  }

  await db.update(v11Goal).set(setValues).where(eq(v11Goal.id, goalId));
  return getGoalById(goalId);
}
