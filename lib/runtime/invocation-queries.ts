/**
 * Invocation 仓储（S05-C01）。
 *
 * 事实源：
 * - docs/architecture/persistence.md （Invocation L366-387）、（事务边界）
 * - docs/architecture/agent-control-plane.md §6（Invocation 生命周期）
 * - docs/architecture/runtime-control-plane.md S05-C01
 *
 * 职责：
 * - createInvocation：事务内分配 invocationSequence + INSERT Invocation + 写 invocation.queued Event。
 * - getInvocationById / getInvocationsByTurn：查询（跨租户隔离）。
 * - updateInvocationState：状态机转换（queued → running → completed/failed/cancelled/lost）。
 * - recordInvocationHeartbeat：更新 lastHeartbeatAt。
 *
 * 关键约束：
 * - turnId/jobId 恰有一个非空（应用层校验，DB 不加 CHECK）。
 * - invocationSequence 在 Turn 或 Job 内单调递增（UNIQUE(threadId, invocationSequence) / UNIQUE(jobId, invocationSequence)）。
 * - ThreadEvent sequence 通过锁定 Thread.last_event_sequence 原子递增（不用 max+1）。
 * - 状态机非法转换 → InvocationStateConflictError。
 */
import { randomUUID } from "node:crypto";
import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import {
  type ThreadEvent,
  type ThreadEventActorType,
  threadTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import {
  type Invocation,
  type InvocationExecutionState,
  type InvocationKind,
  invocationTable,
} from "@/lib/persistence/schema/runtime";
import { InvocationNotFoundError, InvocationStateConflictError } from "@/lib/runtime/errors";
import { and, asc, eq, sql } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Invocation 状态机允许的转换。 */
const INVOCATION_ALLOWED_TRANSITIONS: Record<InvocationExecutionState, InvocationExecutionState[]> =
  {
    queued: ["running", "cancelled", "failed", "lost"],
    running: ["waiting_user", "completed", "failed", "cancelled", "lost"],
    waiting_user: ["running", "cancelled", "failed", "lost"],
    completed: [],
    failed: [],
    cancelled: [],
    lost: [],
  };

/** createInvocation 入参。 */
export interface CreateInvocationParams {
  tenantId: string;
  /** 会话执行时存在；后台 Job 执行时为空。 */
  threadId?: string | null;
  /** 会话执行时存在；后台 Job 执行时为空。 */
  turnId?: string | null;
  /** 后台执行时存在；会话执行时为空。 */
  jobId?: string | null;
  invocationKind: InvocationKind;
  /** 输入 Item（通常是 user_message）。 */
  triggerItemId?: string | null;
  /** Regenerate 替代的原 Invocation id。 */
  replacesInvocationId?: string | null;
  /** 关联标识（X-Request-Id / traceparent）。 */
  correlationId?: string | null;
  /** 触发事件的 actor 类型（默认 system）。 */
  actorType?: ThreadEventActorType;
  /** 触发事件的 actor id。 */
  actorId?: string | null;
}

/** createInvocation 返回结果。 */
export interface CreateInvocationResult {
  invocation: Invocation;
  event: ThreadEvent;
}

/**
 * 创建 Invocation 并写 invocation.queued Event。
 *
 * 事务内（）：
 * 1. 校验 turnId/jobId 恰有一个非空。
 * 2. 如果 threadId 存在：SELECT FOR UPDATE Thread 行（防止并发分配 sequence 冲突）。
 * 3. 分配 invocationSequence（COALESCE(MAX(invocationSequence), 0) + 1，按 threadId 或 jobId 维度）。
 * 4. INSERT Invocation（executionState=queued）。
 * 5. 如果 threadId 存在：分配 event sequence 并写 invocation.queued ThreadEvent。
 * 6. 返回 Invocation + Event（job 模式无 ThreadEvent，Event 为 null 占位由调用方处理）。
 *
 * @throws InvocationStateConflictError turnId/jobId 都为空或都非空
 */
export async function createInvocation(
  params: CreateInvocationParams,
): Promise<CreateInvocationResult> {
  // 1. 校验 turnId/jobId 恰有一个非空
  const hasTurn = params.turnId !== null && params.turnId !== undefined;
  const hasJob = params.jobId !== null && params.jobId !== undefined;
  if (hasTurn === hasJob) {
    throw new InvocationStateConflictError("<new>", "queued", "turnId/jobId 必须恰有一个非空");
  }
  if (hasTurn && !params.threadId) {
    throw new InvocationStateConflictError("<new>", "queued", "会话执行必须提供 threadId");
  }

  const invocationId = randomUUID();
  const now = new Date();
  const actorType: ThreadEventActorType = params.actorType ?? "system";

  const result = await db.transaction(async (tx) => {
    // 2. SELECT FOR UPDATE Thread（如果 threadId 存在）
    let threadRow: { id: string } | null = null;
    if (params.threadId) {
      const [thread] = await tx
        .select({ id: threadTable.id })
        .from(threadTable)
        .where(and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, params.threadId)))
        .for("update")
        .limit(1);
      if (!thread) {
        throw new InvocationStateConflictError(
          invocationId,
          "queued",
          `Thread 不存在或跨租户不可见: ${params.threadId}`,
        );
      }
      threadRow = thread;
    }

    // 3. 分配 invocationSequence（COALESCE(MAX(invocationSequence), 0) + 1）
    const invocationSequence = await allocateInvocationSequence(
      tx,
      params.threadId ?? null,
      params.jobId ?? null,
    );

    // 4. INSERT Invocation
    await tx.insert(invocationTable).values({
      id: invocationId,
      tenantId: params.tenantId,
      threadId: params.threadId ?? null,
      turnId: params.turnId ?? null,
      jobId: params.jobId ?? null,
      invocationSequence,
      invocationKind: params.invocationKind,
      executionState: "queued",
      triggerItemId: params.triggerItemId ?? null,
      replacesInvocationId: params.replacesInvocationId ?? null,
      outputItemId: null,
      resultRef: null,
      runtimeSessionBindingId: null,
      runtimeExecutionRef: null,
      startedAt: null,
      finishedAt: null,
      lastHeartbeatAt: null,
      errorCode: null,
      errorSummary: null,
      versionNo: 1,
      createdAt: now,
      updatedAt: now,
    });

    // 5. 写 invocation.queued Event（仅会话模式；job 模式无 ThreadEvent 流）
    let eventRow: ThreadEvent | null = null;
    if (threadRow) {
      const eventSeq = await allocateEventSequences(tx, threadRow.id, 1);
      eventRow = await insertThreadEvent(tx, threadRow.id, eventSeq, {
        eventType: "invocation.queued",
        turnId: params.turnId ?? undefined,
        invocationId,
        actorType,
        actorId: params.actorId ?? undefined,
        payload: {
          invocation_kind: params.invocationKind,
          trigger_item_id: params.triggerItemId ?? null,
          replaces_invocation_id: params.replacesInvocationId ?? null,
          thread_id: params.threadId ?? null,
          turn_id: params.turnId ?? null,
          job_id: params.jobId ?? null,
        },
        correlationId: params.correlationId ?? undefined,
      });
    }

    return { invocationSequence, eventRow };
  });

  // 回读 Invocation
  const [invocation] = await db
    .select()
    .from(invocationTable)
    .where(eq(invocationTable.id, invocationId))
    .limit(1);
  if (!invocation) {
    throw new Error(`createInvocation: Invocation 行未找到（id=${invocationId}）`);
  }

  return {
    invocation,
    event: result.eventRow as ThreadEvent,
  };
}

/**
 * 锁定 Thread 行后分配 invocationSequence（COALESCE(MAX(invocationSequence), 0) + 1）。
 *
 * 必须在 db.transaction 内调用。调用方应先 SELECT FOR UPDATE Thread 行（会话模式）。
 * job 模式下 threadId 为空，按 jobId 维度分配（无 Thread 行需要锁定）。
 */
export async function allocateInvocationSequence(
  tx: Tx,
  threadId: string | null,
  jobId: string | null,
): Promise<number> {
  if (threadId) {
    const [row] = await tx
      .select({ maxSeq: sql<number>`COALESCE(MAX(${invocationTable.invocationSequence}), 0)` })
      .from(invocationTable)
      .where(eq(invocationTable.threadId, threadId));
    return (row?.maxSeq ?? 0) + 1;
  }
  if (jobId) {
    const [row] = await tx
      .select({ maxSeq: sql<number>`COALESCE(MAX(${invocationTable.invocationSequence}), 0)` })
      .from(invocationTable)
      .where(eq(invocationTable.jobId, jobId));
    return (row?.maxSeq ?? 0) + 1;
  }
  throw new Error("allocateInvocationSequence: threadId 和 jobId 都为空");
}

/** 按 id 获取 Invocation（跨租户隔离）。不存在返回 null。 */
export async function getInvocationById(
  tenantId: string,
  invocationId: string,
): Promise<Invocation | null> {
  const [row] = await db
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .limit(1);
  return row ?? null;
}

/** 列出 Turn 的所有 Invocation（按 invocationSequence 升序，跨租户隔离）。 */
export async function getInvocationsByTurn(
  tenantId: string,
  turnId: string,
): Promise<Invocation[]> {
  return db
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.turnId, turnId)))
    .orderBy(asc(invocationTable.invocationSequence));
}

/** updateInvocationState 附加字段。 */
export interface UpdateInvocationStateOptions {
  startedAt?: Date | null;
  finishedAt?: Date | null;
  errorCode?: string | null;
  errorSummary?: string | null;
  outputItemId?: string | null;
  runtimeExecutionRef?: string | null;
  resultRef?: string | null;
}

/**
 * 更新 Invocation 状态（事务内 SELECT FOR UPDATE + 状态机校验 + 递增 versionNo）。
 *
 * 状态机（）：
 * - queued → running / cancelled / failed / lost
 * - running → waiting_user / completed / failed / cancelled / lost
 * - waiting_user → running / cancelled / failed / lost
 * - completed / failed / cancelled / lost：终态，不可恢复
 *
 * @throws InvocationNotFoundError Invocation 不存在或跨租户不可见
 * @throws InvocationStateConflictError 状态机非法转换
 */
export async function updateInvocationState(
  tx: Tx,
  tenantId: string,
  invocationId: string,
  newState: InvocationExecutionState,
  options?: UpdateInvocationStateOptions,
): Promise<Invocation> {
  // SELECT FOR UPDATE Invocation
  const [current] = await tx
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .for("update")
    .limit(1);

  if (!current) {
    throw new InvocationNotFoundError(invocationId);
  }

  // 状态机校验
  const allowed = INVOCATION_ALLOWED_TRANSITIONS[current.executionState];
  if (!allowed.includes(newState)) {
    throw new InvocationStateConflictError(invocationId, current.executionState, `→ ${newState}`);
  }

  const now = new Date();
  const updates: Partial<typeof invocationTable.$inferInsert> = {
    executionState: newState,
    versionNo: current.versionNo + 1,
    updatedAt: now,
  };

  // 状态相关的字段更新
  if (newState === "running") {
    updates.startedAt = options?.startedAt ?? current.startedAt ?? now;
    updates.lastHeartbeatAt = now;
    if (options?.runtimeExecutionRef !== undefined) {
      updates.runtimeExecutionRef = options.runtimeExecutionRef;
    }
  }
  if (newState === "waiting_user") {
    updates.lastHeartbeatAt = now;
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
  if (options?.outputItemId !== undefined) {
    updates.outputItemId = options.outputItemId;
  }
  if (options?.runtimeExecutionRef !== undefined && newState !== "running") {
    updates.runtimeExecutionRef = options.runtimeExecutionRef;
  }
  if (options?.resultRef !== undefined) {
    updates.resultRef = options.resultRef;
  }

  await tx.update(invocationTable).set(updates).where(eq(invocationTable.id, invocationId));

  const [updated] = await tx
    .select()
    .from(invocationTable)
    .where(eq(invocationTable.id, invocationId))
    .limit(1);
  if (!updated) {
    throw new Error(`updateInvocationState: Invocation 行未找到（id=${invocationId}）`);
  }
  return updated;
}

/**
 * 记录 Invocation 心跳（更新 lastHeartbeatAt）。
 *
 * 不在事务内运行（轻量更新），用于 Runtime worker 心跳上报。
 */
export async function recordInvocationHeartbeat(
  tenantId: string,
  invocationId: string,
  at: Date = new Date(),
): Promise<Invocation | null> {
  await db
    .update(invocationTable)
    .set({ lastHeartbeatAt: at, updatedAt: at })
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)));

  const [row] = await db
    .select()
    .from(invocationTable)
    .where(eq(invocationTable.id, invocationId))
    .limit(1);
  return row ?? null;
}

/** 导出事务句柄类型与状态机常量供外部组合事务使用。 */
export type { Tx };
export { INVOCATION_ALLOWED_TRANSITIONS };

/** 通过 turnId 查询所属 threadId（内部 helper，跨租户隔离）。 */
export async function getThreadIdByTurn(tenantId: string, turnId: string): Promise<string | null> {
  const [row] = await db
    .select({ threadId: turnTable.threadId })
    .from(turnTable)
    .innerJoin(threadTable, eq(turnTable.threadId, threadTable.id))
    .where(and(eq(threadTable.tenantId, tenantId), eq(turnTable.id, turnId)))
    .limit(1);
  return row?.threadId ?? null;
}

/**
 * 列出 Thread 下所有 Invocation（按 invocationSequence 升序，跨租户隔离）。
 *
 * 事实源：S11-W04 管理面排障端点 /admin/api/v1/threads/[thread_id]/invocations 使用本函数。
 *
 * Invocation 表存在 threadId 直接字段（schema/runtime.ts L249），无需通过 turn 关联子查询。
 *
 * 选项：
 * - limit：默认 100，最大 500。
 * - afterSequence：游标分页（invocationSequence > afterSequence）。
 */
export async function listInvocationsByThread(
  tenantId: string,
  threadId: string,
  options?: { limit?: number; afterSequence?: number },
): Promise<Invocation[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions = [
    eq(invocationTable.tenantId, tenantId),
    eq(invocationTable.threadId, threadId),
  ];
  if (options?.afterSequence !== undefined) {
    conditions.push(sql`${invocationTable.invocationSequence} > ${options.afterSequence}`);
  }

  return db
    .select()
    .from(invocationTable)
    .where(and(...conditions))
    .orderBy(asc(invocationTable.invocationSequence))
    .limit(limit);
}
