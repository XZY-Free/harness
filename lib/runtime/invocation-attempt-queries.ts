/**
 * InvocationAttempt 仓储（S05-C01）。
 *
 * 事实源：
 * - docs/architecture/persistence.md （InvocationAttempt L389-403）
 * - docs/architecture/agent-control-plane.md §6（Attempt 基础设施重调度）
 * - docs/architecture/runtime-control-plane.md S05-C01
 *
 * 职责：
 * - createAttempt：分配 attemptNo（max+1）+ INSERT Attempt。
 * - getAttemptById / getLatestAttempt：查询（按 invocationId 维度）。
 * - updateAttemptState：状态机转换（queued → running → completed/failed/cancelled/lost）。
 *
 * 关键约束：
 * - attemptNo 从 1 开始递增（UNIQUE(invocationId, attemptNo)）。
 * - Attempt 只表示整个 Invocation 基础设施重调度，不表示模型 Span、ToolCall。
 * - 状态机非法转换 → InvocationAttemptStateConflictError。
 * - 本阶段不实现 EnvironmentLease，environmentLeaseId 先 NULL。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import type { InvocationAttempt, InvocationAttemptState } from "@/lib/persistence/schema/runtime";
import { invocationAttemptTable } from "@/lib/persistence/schema/runtime";
import {
 InvocationAttemptNotFoundError,
 InvocationAttemptStateConflictError,
} from "@/lib/runtime/errors";
import { desc, eq, sql } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** InvocationAttempt 状态机允许的转换。 */
const ATTEMPT_ALLOWED_TRANSITIONS: Record<InvocationAttemptState, InvocationAttemptState[]> = {
 queued: ["running", "cancelled", "failed", "lost"],
 running: ["completed", "failed", "cancelled", "lost"],
 completed: [],
 failed: [],
 cancelled: [],
 lost: [],
};

/** createAttempt 入参。 */
export interface CreateAttemptParams {
 invocationId: string;
 /** 重试原因码（如 infra_error / runtime_lost）。 */
 retryReasonCode?: string | null;
 /** 重试检查点引用（用于恢复执行）。 */
 checkpointRef?: string | null;
}

/**
 * 创建 Attempt（分配 attemptNo = max(attemptNo)+1，INSERT Attempt）。
 *
 * 不在事务内运行（单 INSERT + max 查询），attemptNo 唯一性由 DB UNIQUE 约束保证。
 * 若并发冲突，调用方应重试。
 *
 * @returns 新建的 Attempt（attemptState=queued）
 */
export async function createAttempt(params: CreateAttemptParams): Promise<InvocationAttempt> {
 // 分配 attemptNo（COALESCE(MAX(attemptNo), 0) + 1）
 const [maxRow] = await db
 .select({ maxNo: sql<number>`COALESCE(MAX(${invocationAttemptTable.attemptNo}), 0)` })
 .from(invocationAttemptTable)
 .where(eq(invocationAttemptTable.invocationId, params.invocationId));
 const attemptNo = (maxRow?.maxNo ?? 0) + 1;

 const attemptId = randomUUID();
 const now = new Date();
 await db.insert(invocationAttemptTable).values({
 id: attemptId,
 invocationId: params.invocationId,
 attemptNo,
 attemptState: "queued",
 environmentLeaseId: null,
 workerRef: null,
 runtimeExecutionRef: null,
 checkpointRef: params.checkpointRef ?? null,
 retryReasonCode: params.retryReasonCode ?? null,
 startedAt: null,
 finishedAt: null,
 lastHeartbeatAt: null,
 errorCode: null,
 errorSummary: null,
 createdAt: now,
 updatedAt: now,
 });

 const [row] = await db
 .select()
 .from(invocationAttemptTable)
 .where(eq(invocationAttemptTable.id, attemptId))
 .limit(1);
 if (!row) {
 throw new Error(`createAttempt: InvocationAttempt 行未找到（id=${attemptId}）`);
 }
 return row;
}

/**
 * 事务内创建 Attempt（与 createAttempt 行为一致，但接受外部事务句柄）。
 *
 * 事实源：docs/architecture/persistence.md （事务边界）。
 * 用于 redispatchInvocation 等需要在同事务内创建 Attempt + 调度 Runtime + 更新 Invocation 的场景。
 *
 * 必须在 db.transaction 内调用。attemptNo 唯一性由 DB UNIQUE 约束保证；
 * 并发冲突时会抛唯一约束异常，调用方应重试。
 */
export async function createAttemptInternal(
 tx: Tx,
 params: CreateAttemptParams,
): Promise<InvocationAttempt> {
 // 分配 attemptNo（COALESCE(MAX(attemptNo), 0) + 1）
 const [maxRow] = await tx
 .select({ maxNo: sql<number>`COALESCE(MAX(${invocationAttemptTable.attemptNo}), 0)` })
 .from(invocationAttemptTable)
 .where(eq(invocationAttemptTable.invocationId, params.invocationId));
 const attemptNo = (maxRow?.maxNo ?? 0) + 1;

 const attemptId = randomUUID();
 const now = new Date();
 await tx.insert(invocationAttemptTable).values({
 id: attemptId,
 invocationId: params.invocationId,
 attemptNo,
 attemptState: "queued",
 environmentLeaseId: null,
 workerRef: null,
 runtimeExecutionRef: null,
 checkpointRef: params.checkpointRef ?? null,
 retryReasonCode: params.retryReasonCode ?? null,
 startedAt: null,
 finishedAt: null,
 lastHeartbeatAt: null,
 errorCode: null,
 errorSummary: null,
 createdAt: now,
 updatedAt: now,
 });

 const [row] = await tx
 .select()
 .from(invocationAttemptTable)
 .where(eq(invocationAttemptTable.id, attemptId))
 .limit(1);
 if (!row) {
 throw new Error(`createAttemptInternal: InvocationAttempt 行未找到（id=${attemptId}）`);
 }
 return row;
}

/** 按 id 获取 Attempt。不存在返回 null。 */
export async function getAttemptById(attemptId: string): Promise<InvocationAttempt | null> {
 const [row] = await db
 .select()
 .from(invocationAttemptTable)
 .where(eq(invocationAttemptTable.id, attemptId))
 .limit(1);
 return row ?? null;
}

/** 按 invocationId 获取最新 Attempt（attemptNo 最大）。不存在返回 null。 */
export async function getLatestAttempt(invocationId: string): Promise<InvocationAttempt | null> {
 const [row] = await db
 .select()
 .from(invocationAttemptTable)
 .where(eq(invocationAttemptTable.invocationId, invocationId))
 .orderBy(desc(invocationAttemptTable.attemptNo))
 .limit(1);
 return row ?? null;
}

/** 列出 Invocation 的所有 Attempt（按 attemptNo 升序）。 */
export async function getAttemptsByInvocation(invocationId: string): Promise<InvocationAttempt[]> {
 return db
 .select()
 .from(invocationAttemptTable)
 .where(eq(invocationAttemptTable.invocationId, invocationId))
 .orderBy(invocationAttemptTable.attemptNo);
}

/** updateAttemptState 附加字段。 */
export interface UpdateAttemptStateOptions {
 workerRef?: string | null;
 runtimeExecutionRef?: string | null;
 environmentLeaseId?: string | null;
 startedAt?: Date | null;
 finishedAt?: Date | null;
 errorCode?: string | null;
 errorSummary?: string | null;
}

/**
 * 更新 Attempt 状态（事务内 SELECT FOR UPDATE + 状态机校验 + 递增 updatedAt）。
 *
 * 状态机（）：
 * - queued → running / cancelled / failed / lost
 * - running → completed / failed / cancelled / lost
 * - completed / failed / cancelled / lost：终态，不可恢复
 *
 * 必须在 db.transaction 内调用。
 *
 * @throws InvocationAttemptNotFoundError Attempt 不存在
 * @throws InvocationAttemptStateConflictError 状态机非法转换
 */
export async function updateAttemptState(
 tx: Tx,
 attemptId: string,
 newState: InvocationAttemptState,
 options?: UpdateAttemptStateOptions,
): Promise<InvocationAttempt> {
 // SELECT FOR UPDATE Attempt
 const [current] = await tx
 .select()
 .from(invocationAttemptTable)
 .where(eq(invocationAttemptTable.id, attemptId))
 .for("update")
 .limit(1);

 if (!current) {
 throw new InvocationAttemptNotFoundError(attemptId);
 }

 // 状态机校验
 const allowed = ATTEMPT_ALLOWED_TRANSITIONS[current.attemptState];
 if (!allowed.includes(newState)) {
 throw new InvocationAttemptStateConflictError(attemptId, current.attemptState, `→ ${newState}`);
 }

 const now = new Date();
 const updates: Partial<typeof invocationAttemptTable.$inferInsert> = {
 attemptState: newState,
 updatedAt: now,
 };

 // 状态相关的字段更新
 if (newState === "running") {
 updates.startedAt = options?.startedAt ?? current.startedAt ?? now;
 updates.lastHeartbeatAt = now;
 if (options?.workerRef !== undefined) {
 updates.workerRef = options.workerRef;
 }
 if (options?.runtimeExecutionRef !== undefined) {
 updates.runtimeExecutionRef = options.runtimeExecutionRef;
 }
 if (options?.environmentLeaseId !== undefined) {
 updates.environmentLeaseId = options.environmentLeaseId;
 }
 }
 if (
 newState === "completed" ||
 newState === "failed" ||
 newState === "cancelled" ||
 newState === "lost"
 ) {
 updates.finishedAt = options?.finishedAt ?? now;
 if (newState === "failed" || newState === "lost") {
 if (options?.errorCode !== undefined) {
 updates.errorCode = options.errorCode;
 }
 if (options?.errorSummary !== undefined) {
 updates.errorSummary = options.errorSummary;
 }
 }
 }
 // 非 running 状态也允许更新 workerRef / runtimeExecutionRef（如 lost 时记录最后 worker）
 if (newState !== "running") {
 if (options?.workerRef !== undefined) {
 updates.workerRef = options.workerRef;
 }
 if (options?.runtimeExecutionRef !== undefined) {
 updates.runtimeExecutionRef = options.runtimeExecutionRef;
 }
 }

 await tx
 .update(invocationAttemptTable)
 .set(updates)
 .where(eq(invocationAttemptTable.id, attemptId));

 const [updated] = await tx
 .select()
 .from(invocationAttemptTable)
 .where(eq(invocationAttemptTable.id, attemptId))
 .limit(1);
 if (!updated) {
 throw new Error(`updateAttemptState: InvocationAttempt 行未找到（id=${attemptId}）`);
 }
 return updated;
}

/** 记录 Attempt 心跳（更新 lastHeartbeatAt，轻量更新，不在事务内）。 */
export async function recordAttemptHeartbeat(
 attemptId: string,
 at: Date = new Date(),
): Promise<InvocationAttempt | null> {
 await db
 .update(invocationAttemptTable)
 .set({ lastHeartbeatAt: at, updatedAt: at })
 .where(eq(invocationAttemptTable.id, attemptId));

 const [row] = await db
 .select()
 .from(invocationAttemptTable)
 .where(eq(invocationAttemptTable.id, attemptId))
 .limit(1);
 return row ?? null;
}

/** 导出事务句柄类型与状态机常量供外部组合事务使用。 */
export type { Tx };
export { ATTEMPT_ALLOWED_TRANSITIONS };
