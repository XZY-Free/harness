/**
 * Goal 仓储。
 *
 * 事实源：
 * - docs/architecture/persistence.md （Goal 表）
 * - docs/architecture/agent-control-plane.md §6（Goal 域模型）
 * - docs/architecture/conversations.md
 *
 * 职责：
 * - createGoal：创建 Goal（一个 Thread 最多一个 active）。
 * - getGoalById/getActiveGoalByThread：查询。
 * - updateGoalState：Goal 状态机转换。
 *
 * 约束（行 341-343）：
 * - 一个 Thread 最多一个 active Goal（应用层校验，不依赖生成列）。
 * - 状态：active → blocked → active/completed/cancelled。
 */
import { randomUUID } from "node:crypto";
import { GoalAlreadyActiveError } from "@/lib/conversations/errors";
import { db } from "@/lib/db/client";
import {
 type Goal,
 type GoalState,
 goalTable,
 threadTable,
} from "@/lib/persistence/schema/conversation";
import { and, eq } from "drizzle-orm";

/** 创建 Goal。若 Thread 已有 active Goal，抛 GoalAlreadyActiveError。 */
export async function createGoal(params: {
 threadId: string;
 objective: string;
 successCriteriaJson: Record<string, unknown>;
 constraintsJson?: Record<string, unknown> | null;
 currentStateJson?: Record<string, unknown> | null;
 createdBy: string;
}): Promise<Goal> {
 // 校验：一个 Thread 最多一个 active Goal
 const existing = await getActiveGoalByThread(params.threadId);
 if (existing) {
 throw new GoalAlreadyActiveError(params.threadId);
 }

 const id = randomUUID();
 await db.insert(goalTable).values({
 id,
 threadId: params.threadId,
 objective: params.objective,
 successCriteriaJson: params.successCriteriaJson,
 constraintsJson: params.constraintsJson ?? null,
 currentStateJson: params.currentStateJson ?? null,
 goalState: "active",
 createdBy: params.createdBy,
 });

 const [row] = await db.select().from(goalTable).where(eq(goalTable.id, id)).limit(1);
 if (!row) {
 throw new Error(`createGoal: 行未找到（id=${id}）`);
 }
 return row;
}

/** 按 id 获取 Goal。不存在返回 null。 */
export async function getGoalById(goalId: string): Promise<Goal | null> {
 const [row] = await db.select().from(goalTable).where(eq(goalTable.id, goalId)).limit(1);
 return row ?? null;
}

/** 获取 Thread 的 active Goal。不存在返回 null。 */
export async function getActiveGoalByThread(threadId: string): Promise<Goal | null> {
 const [row] = await db
 .select()
 .from(goalTable)
 .where(and(eq(goalTable.threadId, threadId), eq(goalTable.goalState, "active")))
 .limit(1);
 return row ?? null;
}

/** 列出 Thread 的所有 Goal（含历史）。 */
export async function getGoalsByThread(threadId: string): Promise<Goal[]> {
 return db.select().from(goalTable).where(eq(goalTable.threadId, threadId));
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
): Promise<Goal | null> {
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

 const setValues: Partial<typeof goalTable.$inferInsert> = {
 goalState: nextState,
 updatedAt: new Date(),
 };
 if (nextState === "completed" || nextState === "cancelled") {
 setValues.completedAt = new Date();
 }
 if (updates?.currentStateJson) {
 setValues.currentStateJson = updates.currentStateJson;
 }

 await db.update(goalTable).set(setValues).where(eq(goalTable.id, goalId));
 return getGoalById(goalId);
}
