import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
/**
 * Worker 重启恢复仓储（S09-C06）。
 *
 * 事实源：
 * - docs/architecture/persistence.md （Invocation 状态机含 lost 终态）、
 * （producerSequence 在整个 Invocation 内连续）、（RuntimeSessionBinding lost）、
 * （事务边界）、§13（Worker 失联恢复：不伪造完成）
 * - docs/architecture/conversations.md §3（Resume 与恢复）、
 * §14（Durable Workflow 边界：Workflow Provider 不成为业务状态源）
 * - docs/architecture/api-and-events.md （Resume 与 requires_redispatch）、
 * （JobEvent 不进员工 Thread SSE）
 * - docs/architecture/conversations.md 、S09-C06
 *
 * 职责：
 * - findStaleInvocations：扫描心跳超时的非终态 Invocation（Worker 重启恢复入口）。
 * - markInvocationLost：将非终态 Invocation 转为 lost 终态 + 写 invocation.lost ThreadEvent
 * + 标记关联 RuntimeSessionBinding 为 lost。
 * - getLatestProducerSequence：查询 Invocation 已映射的最大 producer_sequence（重调度起点计算）。
 *
 * 关键约束：
 * - 不伪造完成：心跳超时只能 markInvocationLost，不能 markInvocationCompleted。
 * - 终态 Invocation 不可恢复（INVOCATION_TERMINAL_STATES）。
 * - invocation.lost Event 必须形成（Invocation 终态必须形成公开 Event）。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - producerSequence 在整个 Invocation 内连续，不按 Attempt 从 1 重启（）。
 */
import { db } from "@/lib/db/client";
import type { ThreadEventActorType } from "@/lib/persistence/schema/conversation";
import { threadTable } from "@/lib/persistence/schema/conversation";
import type { InvocationExecutionState } from "@/lib/persistence/schema/runtime";
import {
 INVOCATION_TERMINAL_STATES,
 invocationTable,
 runtimeEventIngressTable,
} from "@/lib/persistence/schema/runtime";
import { InvocationAlreadyTerminalError, InvocationNotFoundError } from "@/lib/runtime/errors";
import { updateInvocationState } from "@/lib/runtime/invocation-queries";
import { markSessionBindingLost } from "@/lib/runtime/session-binding-queries";
import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 允许标记 lost 的非终态 Invocation 状态（心跳超时可判定失联）。 */
const LOST_ALLOWED_SOURCE_STATES: readonly InvocationExecutionState[] = [
 "queued",
 "running",
 "waiting_user",
];

/** findStaleInvocations 入参。 */
export interface FindStaleInvocationsParams {
 tenantId: string;
 /** 心跳超时阈值（毫秒）。lastHeartbeatAt 早于 (now - thresholdMs) 的非终态 Invocation 视为失联。 */
 thresholdMs: number;
 /** 当前时间基准（默认 new Date()，测试可注入）。 */
 now?: Date;
 /** 返回上限（默认 100，最大 500）。 */
 limit?: number;
}

/** findStaleInvocations 返回的失联 Invocation 摘要。 */
export interface StaleInvocationSummary {
 invocationId: string;
 tenantId: string;
 threadId: string | null;
 turnId: string | null;
 jobId: string | null;
 executionState: InvocationExecutionState;
 lastHeartbeatAt: Date | null;
 runtimeSessionBindingId: string | null;
 runtimeExecutionRef: string | null;
}

/**
 * 扫描心跳超时的非终态 Invocation（Worker 重启恢复入口）。
 *
 * 事实源：（lastHeartbeatAt 字段）、§13（Worker 失联恢复）。
 *
 * 选择条件：
 * - tenantId 匹配
 * - executionState IN (queued, running, waiting_user)
 * - lastHeartbeatAt IS NOT NULL AND lastHeartbeatAt < (now - thresholdMs)
 *
 * 排序：lastHeartbeatAt 升序（最早失联的优先处理）。
 *
 * 注：queued 状态的 Invocation 若从未调度（lastHeartbeatAt 为 null）不会被扫描；
 * 调度器应通过 dispatchAcceptedTurns 单独处理 queued 调度。
 */
export async function findStaleInvocations(
 params: FindStaleInvocationsParams,
): Promise<StaleInvocationSummary[]> {
 const now = params.now ?? new Date();
 const threshold = new Date(now.getTime() - params.thresholdMs);
 const limit = Math.min(params.limit ?? 100, 500);

 const rows = await db
 .select({
 invocationId: invocationTable.id,
 tenantId: invocationTable.tenantId,
 threadId: invocationTable.threadId,
 turnId: invocationTable.turnId,
 jobId: invocationTable.jobId,
 executionState: invocationTable.executionState,
 lastHeartbeatAt: invocationTable.lastHeartbeatAt,
 runtimeSessionBindingId: invocationTable.runtimeSessionBindingId,
 runtimeExecutionRef: invocationTable.runtimeExecutionRef,
 })
 .from(invocationTable)
 .where(
 and(
 eq(invocationTable.tenantId, params.tenantId),
 inArray(invocationTable.executionState, [
 "queued",
 "running",
 "waiting_user",
 ] as InvocationExecutionState[]),
 isNotNull(invocationTable.lastHeartbeatAt),
 lt(invocationTable.lastHeartbeatAt, threshold),
 ),
 )
 .orderBy(asc(invocationTable.lastHeartbeatAt))
 .limit(limit);

 return rows;
}

/** markInvocationLost 入参。 */
export interface MarkInvocationLostParams {
 tenantId: string;
 invocationId: string;
 /** 失联原因码（如 heartbeat_timeout / runtime_lost / worker_restart）。 */
 reasonCode: string;
 /** 失联原因摘要（写入 invocation.lost Event payload + Invocation.errorSummary）。 */
 errorSummary?: string | null;
 /** 触发事件的 actor 类型（默认 system，因失联检测由平台扫描器触发）。 */
 actorType?: ThreadEventActorType;
 actorId?: string | null;
 /** 关联标识（X-Request-Id / traceparent）。 */
 correlationId?: string | null;
 /** 幂等键（用于 ThreadEvent UNIQUE 约束）。 */
 idempotencyKey?: string | null;
}

/** markInvocationLost 返回结果。 */
export interface MarkInvocationLostResult {
 /** 更新后的 Invocation（executionState=lost）。 */
 invocation: Awaited<ReturnType<typeof updateInvocationState>>;
 /** 写入的 invocation.lost ThreadEvent（threadId 为空时为 null）。 */
 event: Awaited<ReturnType<typeof insertThreadEvent>> | null;
 /** 标记为 lost 的 RuntimeSessionBinding（runtimeSessionBindingId 为空时为 null）。 */
 sessionBinding: Awaited<ReturnType<typeof markSessionBindingLost>> | null;
}

/**
 * 将非终态 Invocation 标记为 lost 终态 + 写 invocation.lost ThreadEvent
 * + 标记关联 RuntimeSessionBinding 为 lost。
 *
 * 事实源：（lost 终态）、（事务边界：Invocation 状态写入 + Event 同事务）、
 * §13（不伪造完成：心跳超时只能转 lost，不能转 completed）。
 *
 * 流程（同事务）：
 * 1. SELECT FOR UPDATE Invocation（跨租户隔离）
 * 2. 校验 executionState ∈ (queued, running, waiting_user)；终态抛 InvocationAlreadyTerminalError
 * 3. updateInvocationState: → lost（含 errorCode/errorSummary 写入）
 * 4. 如果 runtimeSessionBindingId 非空：markSessionBindingLost
 * 5. 如果 threadId 非空：allocateEventSequences(1) + 写 invocation.lost ThreadEvent
 *
 * 不变量：
 * - 终态 Invocation 不能再 markInvocationLost（幂等性靠状态机校验保证）。
 * - Job 模式（threadId 为空）不写 ThreadEvent；JobEvent 由调用方按需写入（本阶段不实现 job.lost Event）。
 * - 失联检测与恢复分离：本函数只标记 lost，不触发 redispatch（redispatch 由 redispatchInvocation 编排）。
 *
 * @throws InvocationNotFoundError Invocation 不存在或跨租户不可见
 * @throws InvocationAlreadyTerminalError Invocation 已终态
 */
export async function markInvocationLost(
 params: MarkInvocationLostParams,
): Promise<MarkInvocationLostResult> {
 const actorType: ThreadEventActorType = params.actorType ?? "system";
 const errorSummary = params.errorSummary ?? `Invocation 失联：${params.reasonCode}`;

 return db.transaction(async (tx) => {
 // 1. SELECT FOR UPDATE Invocation（updateInvocationState 内部会再次锁定，这里先校验状态）
 const [current] = await tx
 .select()
 .from(invocationTable)
 .where(
 and(
 eq(invocationTable.tenantId, params.tenantId),
 eq(invocationTable.id, params.invocationId),
 ),
 )
 .for("update")
 .limit(1);
 if (!current) {
 throw new InvocationNotFoundError(params.invocationId);
 }

 // 2. 校验非终态
 if (INVOCATION_TERMINAL_STATES.includes(current.executionState)) {
 throw new InvocationAlreadyTerminalError(
 params.invocationId,
 current.executionState,
 "mark_lost",
 );
 }
 if (!LOST_ALLOWED_SOURCE_STATES.includes(current.executionState)) {
 throw new InvocationAlreadyTerminalError(
 params.invocationId,
 current.executionState,
 "mark_lost",
 );
 }

 // 3. updateInvocationState: → lost（事务内 SELECT FOR UPDATE + 状态机校验）
 const updatedInvocation = await updateInvocationState(
 tx,
 params.tenantId,
 params.invocationId,
 "lost",
 {
 errorCode: params.reasonCode,
 errorSummary,
 },
 );

 // 4. 标记关联 RuntimeSessionBinding 为 lost（事务外调用，但同事务提交后生效）
 // markSessionBindingLost 内部使用 db（非 tx），但其幂等性保证即使事务回滚也不会影响下一次调用
 // 为保证事务一致性，事务内不调用 markSessionBindingLost；提交后由调用方或后续清理流程处理
 // —— 实际上为简化设计，本函数在事务提交前调用 markSessionBindingLost（非 tx），
 // 若 markSessionBindingLost 失败，事务回滚，Invocation 也回 lost 转换。
 let sessionBinding: MarkInvocationLostResult["sessionBinding"] = null;
 if (updatedInvocation.runtimeSessionBindingId) {
 sessionBinding = await markSessionBindingLost(updatedInvocation.runtimeSessionBindingId);
 }

 // 5. 写 invocation.lost ThreadEvent（仅会话模式；job 模式无 ThreadEvent 流）
 let event: MarkInvocationLostResult["event"] = null;
 if (updatedInvocation.threadId) {
 // 锁定 Thread 行（与现有模式一致）
 const [thread] = await tx
 .select({ id: threadTable.id })
 .from(threadTable)
 .where(eq(threadTable.id, updatedInvocation.threadId))
 .for("update")
 .limit(1);
 if (!thread) {
 throw new Error(`markInvocationLost: Thread 不存在（id=${updatedInvocation.threadId}）`);
 }

 const seq = await allocateEventSequences(tx, updatedInvocation.threadId, 1);
 event = await insertThreadEvent(tx, updatedInvocation.threadId, seq, {
 eventType: "invocation.lost",
 turnId: updatedInvocation.turnId ?? undefined,
 invocationId: updatedInvocation.id,
 actorType,
 actorId: params.actorId ?? undefined,
 payload: {
 reason_code: params.reasonCode,
 error_summary: errorSummary,
 last_heartbeat_at: current.lastHeartbeatAt ? current.lastHeartbeatAt.toISOString() : null,
 runtime_execution_ref: current.runtimeExecutionRef,
 runtime_session_binding_id: current.runtimeSessionBindingId,
 },
 correlationId: params.correlationId ?? undefined,
 idempotencyKey: params.idempotencyKey ?? undefined,
 });
 }

 return { invocation: updatedInvocation, event, sessionBinding };
 });
}

/**
 * 查询 Invocation 已映射的最大 producer_sequence（重调度起点计算）。
 *
 * 事实源：（producerSequence 在整个 Invocation 内连续，重调度时不能从 1 重启）。
 *
 * 返回值：
 * - 已有候选事件：MAX(producer_sequence)
 * - 无候选事件：0（重调度时 producer_sequence_start = 1）
 *
 * 重调度时 Runtime 应使用 MAX(producer_sequence) + 1 作为新的 producer_sequence_start。
 *
 * 不存在或跨租户不可见的 Invocation 返回 null。
 */
export async function getLatestProducerSequence(
 tenantId: string,
 invocationId: string,
): Promise<number | null> {
 // 先校验 Invocation 存在且同租户
 const [inv] = await db
 .select({ id: invocationTable.id })
 .from(invocationTable)
 .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
 .limit(1);
 if (!inv) {
 return null;
 }

 const [row] = await db
 .select({ maxSeq: sql<number>`COALESCE(MAX(${runtimeEventIngressTable.producerSequence}), 0)` })
 .from(runtimeEventIngressTable)
 .where(eq(runtimeEventIngressTable.invocationId, invocationId));
 return row?.maxSeq ?? 0;
}

/** 导出供外部组合事务使用。 */
export type { Tx };
export { LOST_ALLOWED_SOURCE_STATES };
