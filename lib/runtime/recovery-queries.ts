import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
/**
 * Worker 重启恢复仓储。
 *
 * 事实源：
 * - docs/architecture/persistence.md （Invocation 状态机含 lost 终态）、
 * （producerSequence 在整个 Invocation 内连续）、（RuntimeSessionBinding lost）、
 * （事务边界）、§13（Worker 失联恢复：不伪造完成）
 * - docs/architecture/conversations.md §3（Resume 与恢复）、
 * §14（Durable Workflow 边界：Workflow Provider 不成为业务状态源）
 * - docs/architecture/api-and-events.md （Resume 与 requires_redispatch）、
 * （JobEvent 不进员工 Thread SSE）
 * - docs/architecture/conversations.md 、
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
 * - producerSequence 在整个 Invocation 内连续，不按 Attempt 从 1 重启。
 */
import { db } from "@/lib/db/client";
import type { ThreadEvent, ThreadEventActorType } from "@/lib/persistence/schema/conversation";
import { threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import type {
  InvocationExecutionState,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import {
  INVOCATION_TERMINAL_STATES,
  invocationTable,
  runtimeEventIngressTable,
} from "@/lib/persistence/schema/executions";
import { InvocationAlreadyTerminalError, InvocationNotFoundError } from "@/lib/runtime/errors";
import { updateInvocationState } from "@/lib/runtime/invocation-queries";
import { markSessionBindingLostInSession } from "@/lib/runtime/session-binding-queries";
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
  /** 失联原因码（如 heartbeat_timeout / runtime_lost / worker_restart / resume_retry_exhausted）。 */
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
  invocationLostEvent: ThreadEvent | null;
  /** 写入的 turn.failed ThreadEvent（active Turn 被收口时；否则 null）。 */
  turnFailedEvent: ThreadEvent | null;
  /** 标记为 lost 的 RuntimeSessionBinding（runtimeSessionBindingId 为空时为 null）。 */
  sessionBinding: RuntimeSessionBinding | null;
}

/** Turn 非终态集合（turn.failed 收口仅在非终态 active Turn 上执行）。 */
const TURN_TERMINAL_STATES: readonly string[] = ["completed", "failed", "cancelled", "interrupted"];

/**
 * 将 active Invocation 标记为 lost 终态 —— 唯一原子 Recovery Authority。
 *
 * 事实源：
 * - docs/architecture/runtime-control-plane.md
 * - docs/architecture/persistence.md （事务边界）、§13（不伪造完成）
 *
 * 同一 MySQL transaction 内：
 * 1. SELECT Invocation FOR UPDATE + 校验非终态
 * 2. load Turn FOR UPDATE（如 turnId）
 * 3. load RuntimeSessionBinding FOR UPDATE（如存在；caller-owned session 版本）
 * 4. Invocation → lost（errorCode/errorSummary/finishedAt）
 * 5. SessionBinding active → lost
 * 6. 仅当 Turn.activeInvocationId === Invocation.id 且 Turn 非终态：
 *    Turn → failed（errorCode/finishedAt/activeInvocationId=null；latest/adopted 保留）
 * 7. allocate ThreadEvent sequences + append invocation.lost（+ turn.failed，如第 6 步执行）
 *
 * 不变量：
 * - 不新增 Turn.lost 状态（Invocation 失联是基础设施事实，Turn 的用户语义是 failed）。
 * - 非 active（superseded/regenerate）Invocation lost 不改变 Turn。
 * - Job 模式（threadId=null）：只收口 Invocation/Session，不写 ThreadEvent、不操作 Turn。
 * - SessionBinding 更新必须走 caller-owned 事务版本（markSessionBindingLostInSession），
 *   禁止在事务内调用全局 db 版本。
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
    // 1. SELECT FOR UPDATE Invocation（跨租户隔离）
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

    // 3. load Turn FOR UPDATE（如 turnId；Turn 收口判定需要行锁防并发）
    let turnRow: typeof turnTable.$inferSelect | null = null;
    if (current.turnId) {
      const [t] = await tx
        .select()
        .from(turnTable)
        .where(eq(turnTable.id, current.turnId))
        .for("update")
        .limit(1);
      turnRow = t ?? null;
    }

    // 4. Invocation → lost（含 errorCode/errorSummary/finishedAt）
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

    // 5. SessionBinding active → lost（caller-owned session 版本，同事务）
    let sessionBinding: MarkInvocationLostResult["sessionBinding"] = null;
    if (updatedInvocation.runtimeSessionBindingId) {
      sessionBinding = await markSessionBindingLostInSession(
        tx,
        updatedInvocation.runtimeSessionBindingId,
      );
    }

    // 6. Turn 收口：仅当 Turn.activeInvocationId === Invocation.id 且 Turn 非终态
    let turnFailed = false;
    if (
      turnRow &&
      turnRow.activeInvocationId === params.invocationId &&
      !TURN_TERMINAL_STATES.includes(turnRow.turnState)
    ) {
      const now = new Date();
      await tx
        .update(turnTable)
        .set({
          turnState: "failed",
          errorCode: params.reasonCode,
          finishedAt: now,
          activeInvocationId: null,
          versionNo: turnRow.versionNo + 1,
        })
        .where(eq(turnTable.id, turnRow.id));
      turnFailed = true;
    }

    // 7. ThreadEvent：invocation.lost（+ turn.failed）
    let invocationLostEvent: ThreadEvent | null = null;
    let turnFailedEvent: ThreadEvent | null = null;
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

      const seq = await allocateEventSequences(tx, updatedInvocation.threadId, turnFailed ? 2 : 1);
      invocationLostEvent = await insertThreadEvent(tx, updatedInvocation.threadId, seq, {
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
      if (turnFailed) {
        turnFailedEvent = await insertThreadEvent(tx, updatedInvocation.threadId, seq + 1, {
          eventType: "turn.failed",
          turnId: updatedInvocation.turnId ?? undefined,
          invocationId: updatedInvocation.id,
          actorType,
          actorId: params.actorId ?? undefined,
          payload: {
            reason_code: params.reasonCode,
            error_summary: errorSummary,
          },
          correlationId: params.correlationId ?? undefined,
          idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}-turn` : undefined,
        });
      }
    }

    return { invocation: updatedInvocation, invocationLostEvent, turnFailedEvent, sessionBinding };
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
