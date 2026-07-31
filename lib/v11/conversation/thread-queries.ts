/**
 * V11 Thread 仓储。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §5.1（Thread 表）、§9.1（事务边界）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §5（Thread 容器）
 * - ../v11-agentkit-platform-development-plan/04-thread-turn-item-and-event-core.md S04-W01
 *
 * 职责：
 * - createThread：创建 Thread 绑定租户、所有者和主 Agent；同事务写 thread.created Event。
 * - getThreadById：跨租户隔离查询。
 * - updateThreadLifecycle：active → archived → deleted 状态机。
 * - updateThreadSettings：更新默认模型/Workspace/Environment；乐观锁。
 * - changePrimaryAgent：更换主 Agent；乐观锁。
 * - allocateSequences：锁定 Thread 行原子递增 turn/item/event sequence（SELECT FOR UPDATE）。
 *
 * sequence 分配策略（§9.1 行 633）：
 * - 锁定 Thread.last_event_sequence 原子递增，不用 max(sequence)+1。
 * - 在事务内 SELECT ... FOR UPDATE 锁定 Thread 行，递增 lastXxxSequence 后写入。
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  ThreadNotAcceptingTurnsError,
  ThreadNotFoundError,
  ThreadVersionConflictError,
} from "@/lib/v11/conversation/errors";
import {
  type ThreadEventActorType,
  type ThreadLifecycleState,
  type V11Thread,
  type V11ThreadEvent,
  v11Thread,
  v11ThreadEvent,
} from "@/lib/v11/schema/conversation";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

/** 创建 Thread 时的 Event 写入参数。 */
interface ThreadEventInput {
  eventType: string;
  turnId?: string;
  itemId?: string;
  invocationId?: string;
  actorType: ThreadEventActorType;
  actorId?: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
}

/**
 * 创建 Thread 绑定租户、所有者和主 Agent。
 *
 * 同事务写 thread.created Event（§9.1 行 608：接纳 Thread 创建 = Thread + thread.created）。
 * thread.created 事件 sequence = 1（首次分配）。
 */
export async function createThread(params: {
  tenantId: string;
  ownerUserId: string;
  primaryAgentId: string;
  title?: string | null;
  defaultWorkspaceId?: string | null;
  defaultModelRef?: string | null;
  defaultEnvironmentDefinitionId?: string | null;
  actorId: string;
  idempotencyKey?: string;
}): Promise<{ thread: V11Thread; event: V11ThreadEvent }> {
  const threadId = randomUUID();
  const eventId = randomUUID();
  const now = new Date();

  // 同事务：INSERT Thread (lastEventSequence=1) + INSERT ThreadEvent (sequence=1)
  await db.transaction(async (tx) => {
    await tx.insert(v11Thread).values({
      id: threadId,
      tenantId: params.tenantId,
      ownerUserId: params.ownerUserId,
      primaryAgentId: params.primaryAgentId,
      title: params.title ?? null,
      defaultWorkspaceId: params.defaultWorkspaceId ?? null,
      defaultModelRef: params.defaultModelRef ?? null,
      defaultEnvironmentDefinitionId: params.defaultEnvironmentDefinitionId ?? null,
      lifecycleState: "active",
      lastActivityAt: now,
      lastTurnSequence: 0,
      lastItemSequence: 0,
      lastEventSequence: 1, // thread.created 占 sequence 1
      pendingQueueVersionNo: 1,
      versionNo: 1,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(v11ThreadEvent).values({
      id: eventId,
      threadId,
      eventSequence: 1,
      eventType: "thread.created",
      schemaVersion: 1,
      actorType: "user",
      actorId: params.actorId,
      payloadJson: {
        // 投影上下文（thread_list_projection 需要 tenant_id/owner_user_id 创建行）
        tenant_id: params.tenantId,
        owner_user_id: params.ownerUserId,
        primary_agent_id: params.primaryAgentId,
        title: params.title ?? null,
        default_workspace_id: params.defaultWorkspaceId ?? null,
        default_model_ref: params.defaultModelRef ?? null,
      },
      idempotencyKey: params.idempotencyKey ?? null,
      occurredAt: now,
      ingestedAt: now,
    });
  });

  const [thread] = await db.select().from(v11Thread).where(eq(v11Thread.id, threadId)).limit(1);
  if (!thread) {
    throw new Error(`createThread: Thread 行未找到（id=${threadId}）`);
  }

  const [event] = await db
    .select()
    .from(v11ThreadEvent)
    .where(eq(v11ThreadEvent.id, eventId))
    .limit(1);
  if (!event) {
    throw new Error(`createThread: ThreadEvent 行未找到（id=${eventId}）`);
  }

  return { thread, event };
}

/** 按 id 获取 Thread（跨租户隔离）。不存在返回 null。 */
export async function getThreadById(tenantId: string, threadId: string): Promise<V11Thread | null> {
  const [row] = await db
    .select()
    .from(v11Thread)
    .where(and(eq(v11Thread.tenantId, tenantId), eq(v11Thread.id, threadId)))
    .limit(1);
  return row ?? null;
}

/** 按 id 获取 Thread，不存在抛 ThreadNotFoundError。 */
export async function requireThread(tenantId: string, threadId: string): Promise<V11Thread> {
  const thread = await getThreadById(tenantId, threadId);
  if (!thread) throw new ThreadNotFoundError(threadId);
  return thread;
}

/** 列出用户所有 Thread（跨租户隔离，默认不含 deleted）。 */
export async function listThreadsForUser(
  tenantId: string,
  ownerUserId: string,
  options?: { lifecycleState?: ThreadLifecycleState; includeDeleted?: boolean },
): Promise<V11Thread[]> {
  const conditions = [eq(v11Thread.tenantId, tenantId), eq(v11Thread.ownerUserId, ownerUserId)];
  if (options?.lifecycleState) {
    conditions.push(eq(v11Thread.lifecycleState, options.lifecycleState));
  }
  if (!options?.includeDeleted) {
    conditions.push(isNull(v11Thread.deletedAt));
  }
  return db
    .select()
    .from(v11Thread)
    .where(and(...conditions))
    .orderBy(desc(v11Thread.lastActivityAt));
}

/**
 * 变更 Thread lifecycle 状态。
 *
 * 约束：
 * - active → archived → deleted 单向流转。
 * - deleted 是终态。
 * - archived/deleted 禁止新 Turn（调用方校验）。
 * - 乐观锁：versionNo 不匹配返回 null。
 */
export async function updateThreadLifecycle(
  tenantId: string,
  threadId: string,
  nextState: ThreadLifecycleState,
  expectedVersionNo: number,
): Promise<V11Thread | null> {
  const current = await getThreadById(tenantId, threadId);
  if (!current) return null;
  if (current.versionNo !== expectedVersionNo) {
    throw new ThreadVersionConflictError(threadId, expectedVersionNo, current.versionNo);
  }

  // 状态机校验：active → archived → deleted
  const transitions: Record<ThreadLifecycleState, ThreadLifecycleState[]> = {
    active: ["archived", "deleted"],
    archived: ["deleted"],
    deleted: [],
  };
  if (!transitions[current.lifecycleState].includes(nextState)) {
    throw new ThreadNotAcceptingTurnsError(threadId, current.lifecycleState);
  }

  const result = await db
    .update(v11Thread)
    .set({
      lifecycleState: nextState,
      deletedAt: nextState === "deleted" ? new Date() : null,
      versionNo: expectedVersionNo + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(v11Thread.tenantId, tenantId),
        eq(v11Thread.id, threadId),
        eq(v11Thread.versionNo, expectedVersionNo),
      ),
    );

  if (result[0].affectedRows === 0) return null;
  return getThreadById(tenantId, threadId);
}

/**
 * 更新 Thread 默认设置（模型/Workspace/Environment）。
 *
 * 这些只表示下一 Invocation 偏好，不影响已有 Turn（§5 行 102-114）。
 * 乐观锁：versionNo 不匹配抛 ThreadVersionConflictError。
 *
 * 注意：本函数不写 Event；调用方应在同事务或紧接调用 writeEvent 写 thread.model_changed 等。
 * 完整的事件同事务写入在 S04-C02 的 allocateAndWriteEvents 中实现。
 */
export async function updateThreadSettings(
  tenantId: string,
  threadId: string,
  updates: {
    defaultModelRef?: string | null;
    defaultWorkspaceId?: string | null;
    defaultEnvironmentDefinitionId?: string | null;
  },
  expectedVersionNo: number,
): Promise<V11Thread | null> {
  const result = await db
    .update(v11Thread)
    .set({
      ...updates,
      versionNo: expectedVersionNo + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(v11Thread.tenantId, tenantId),
        eq(v11Thread.id, threadId),
        eq(v11Thread.versionNo, expectedVersionNo),
      ),
    );

  if (result[0].affectedRows === 0) {
    const current = await getThreadById(tenantId, threadId);
    if (!current) return null;
    throw new ThreadVersionConflictError(threadId, expectedVersionNo, current.versionNo);
  }
  return getThreadById(tenantId, threadId);
}

/**
 * 更换 Thread 主 Agent。
 *
 * 约束（§5.1 行 122-131）：
 * - 员工显式调用即是显式确认。
 * - 乐观锁。
 *
 * 注意：本函数不写 thread.primary_agent_changed Event；调用方负责。
 */
export async function changePrimaryAgent(
  tenantId: string,
  threadId: string,
  nextAgentId: string,
  expectedVersionNo: number,
): Promise<V11Thread | null> {
  const result = await db
    .update(v11Thread)
    .set({
      primaryAgentId: nextAgentId,
      versionNo: expectedVersionNo + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(v11Thread.tenantId, tenantId),
        eq(v11Thread.id, threadId),
        eq(v11Thread.versionNo, expectedVersionNo),
      ),
    );

  if (result[0].affectedRows === 0) {
    const current = await getThreadById(tenantId, threadId);
    if (!current) return null;
    throw new ThreadVersionConflictError(threadId, expectedVersionNo, current.versionNo);
  }
  return getThreadById(tenantId, threadId);
}

/** 更新 Thread.activeGoalId（乐观锁）。 */
export async function setActiveGoal(
  tenantId: string,
  threadId: string,
  goalId: string | null,
  expectedVersionNo: number,
): Promise<V11Thread | null> {
  const result = await db
    .update(v11Thread)
    .set({
      activeGoalId: goalId,
      versionNo: expectedVersionNo + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(v11Thread.tenantId, tenantId),
        eq(v11Thread.id, threadId),
        eq(v11Thread.versionNo, expectedVersionNo),
      ),
    );

  if (result[0].affectedRows === 0) return null;
  return getThreadById(tenantId, threadId);
}

// ─── Sequence 分配（SELECT FOR UPDATE）─────────────────────

/**
 * 锁定 Thread 行并原子分配 sequence。
 *
 * 事实源：§9.1 行 633 "锁定 Thread.last_event_sequence 原子递增，不用 max(sequence)+1"。
 *
 * 必须在 db.transaction 内调用，FOR UPDATE 锁定持续到事务提交。
 *
 * @param tx 事务句柄
 * @param threadId Thread id
 * @param count 要分配的 event sequence 数量（默认 1）
 * @returns 分配的起始 sequence（连续）
 */
export async function allocateEventSequences(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  threadId: string,
  count = 1,
): Promise<number> {
  // SELECT ... FOR UPDATE 锁定 Thread 行
  const [row] = await tx
    .select({ lastEventSequence: v11Thread.lastEventSequence })
    .from(v11Thread)
    .where(eq(v11Thread.id, threadId))
    .for("update")
    .limit(1);

  if (!row) {
    throw new ThreadNotFoundError(threadId);
  }

  const startSequence = row.lastEventSequence + 1;
  const newLast = row.lastEventSequence + count;

  await tx.update(v11Thread).set({ lastEventSequence: newLast }).where(eq(v11Thread.id, threadId));

  return startSequence;
}

/**
 * 锁定 Thread 行并原子分配 turn sequence（单个）。
 *
 * 必须在 db.transaction 内调用。
 */
export async function allocateTurnSequence(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  threadId: string,
): Promise<number> {
  const [row] = await tx
    .select({ lastTurnSequence: v11Thread.lastTurnSequence })
    .from(v11Thread)
    .where(eq(v11Thread.id, threadId))
    .for("update")
    .limit(1);

  if (!row) {
    throw new ThreadNotFoundError(threadId);
  }

  const nextSequence = row.lastTurnSequence + 1;
  await tx
    .update(v11Thread)
    .set({
      lastTurnSequence: nextSequence,
      lastActivityAt: new Date(),
    })
    .where(eq(v11Thread.id, threadId));

  return nextSequence;
}

/**
 * 锁定 Thread 行并原子分配 item sequence（单个）。
 *
 * 必须在 db.transaction 内调用。
 */
export async function allocateItemSequence(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  threadId: string,
): Promise<number> {
  const [row] = await tx
    .select({ lastItemSequence: v11Thread.lastItemSequence })
    .from(v11Thread)
    .where(eq(v11Thread.id, threadId))
    .for("update")
    .limit(1);

  if (!row) {
    throw new ThreadNotFoundError(threadId);
  }

  const nextSequence = row.lastItemSequence + 1;
  await tx
    .update(v11Thread)
    .set({ lastItemSequence: nextSequence })
    .where(eq(v11Thread.id, threadId));

  return nextSequence;
}

// ─── Event 写入 ────────────────────────────────────────────

/**
 * 在事务内写入单个 ThreadEvent。
 *
 * 调用方必须先通过 allocateEventSequences 获取 sequence。
 */
export async function insertThreadEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  threadId: string,
  sequence: number,
  input: ThreadEventInput,
): Promise<V11ThreadEvent> {
  const id = randomUUID();
  const now = new Date();
  await tx.insert(v11ThreadEvent).values({
    id,
    threadId,
    eventSequence: sequence,
    eventType: input.eventType,
    schemaVersion: 1,
    turnId: input.turnId ?? null,
    itemId: input.itemId ?? null,
    invocationId: input.invocationId ?? null,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    payloadJson: input.payload,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    occurredAt: now,
    ingestedAt: now,
  });

  const [row] = await tx.select().from(v11ThreadEvent).where(eq(v11ThreadEvent.id, id)).limit(1);
  if (!row) {
    throw new Error(`insertThreadEvent: 行未找到（id=${id}）`);
  }
  return row;
}

/** 查询 Thread Event（按 sequence 升序，从 afterSequence+1 开始）。 */
export async function listThreadEvents(
  tenantId: string,
  threadId: string,
  options?: { afterSequence?: number; limit?: number },
): Promise<V11ThreadEvent[]> {
  const limit = options?.limit ?? 100;
  const afterSeq = options?.afterSequence ?? 0;
  const [thread] = await db
    .select({ id: v11Thread.id })
    .from(v11Thread)
    .where(and(eq(v11Thread.tenantId, tenantId), eq(v11Thread.id, threadId)))
    .limit(1);
  if (!thread) return [];

  return db
    .select()
    .from(v11ThreadEvent)
    .where(
      and(
        eq(v11ThreadEvent.threadId, threadId),
        sql`${v11ThreadEvent.eventSequence} > ${afterSeq}`,
      ),
    )
    .orderBy(v11ThreadEvent.eventSequence)
    .limit(limit);
}

/** 获取 Thread 最新 event sequence（用于 latest_event_cursor）。 */
export async function getLatestEventSequence(
  tenantId: string,
  threadId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ lastEventSequence: v11Thread.lastEventSequence })
    .from(v11Thread)
    .where(and(eq(v11Thread.tenantId, tenantId), eq(v11Thread.id, threadId)))
    .limit(1);
  return row?.lastEventSequence ?? null;
}

// ─── 批量事件写入与 hash 工具 ─────────────────────────────

/**
 * 计算 Event payload 的稳定 hash（sha256）。
 *
 * 事实源：§14 §2.1 规则 2（幂等键包含 payload hash）、§8.1 event_delivery_failure.payload_hash。
 * 递归排序 JSON key 后 sha256，保证相同 payload 产生相同 hash。
 */
export function computeEventPayloadHash(payload: Record<string, unknown>): string {
  const sorted = JSON.stringify(sortKeys(payload));
  return `sha256:${createHash("sha256").update(sorted, "utf8").digest("hex")}`;
}

/** 递归排序对象 key，保证 hash 稳定。 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * 在事务内批量分配 sequence 并写入多个 ThreadEvent。
 *
 * 事实源：§9.1 行 633（锁定 Thread.last_event_sequence 原子递增）、§9.2 行 637（thread_event Outbox）。
 *
 * 必须在 db.transaction 内调用。流程：
 * 1. 调用 allocateEventSequences(tx, threadId, count) 分配连续 sequence
 * 2. 依次调用 insertThreadEvent(tx, threadId, sequence, input) 写入
 *
 * @returns 写入的 ThreadEvent 数组（按 sequence 升序）
 */
export async function allocateAndWriteEvents(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  threadId: string,
  inputs: ThreadEventInput[],
): Promise<V11ThreadEvent[]> {
  if (inputs.length === 0) return [];
  const startSequence = await allocateEventSequences(tx, threadId, inputs.length);
  const events: V11ThreadEvent[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    if (!input) continue;
    const event = await insertThreadEvent(tx, threadId, startSequence + i, input);
    events.push(event);
  }
  return events;
}

/**
 * 获取 Thread 的最新 event cursor（一致性读点）。
 *
 * 事实源：§11 行 297-301（latest_event_cursor = {sequence, event_id}）。
 * Item 列表与 latest_event_cursor 在同一一致性读点生成。
 */
export async function getLatestEventCursor(
  tenantId: string,
  threadId: string,
): Promise<{ sequence: number; eventId: string | null } | null> {
  const [row] = await db
    .select({
      lastEventSequence: v11Thread.lastEventSequence,
    })
    .from(v11Thread)
    .where(and(eq(v11Thread.tenantId, tenantId), eq(v11Thread.id, threadId)))
    .limit(1);
  if (!row) return null;

  // 查询该 sequence 对应的 event id
  const [event] = await db
    .select({ id: v11ThreadEvent.id })
    .from(v11ThreadEvent)
    .where(
      and(
        eq(v11ThreadEvent.threadId, threadId),
        eq(v11ThreadEvent.eventSequence, row.lastEventSequence),
      ),
    )
    .limit(1);

  return { sequence: row.lastEventSequence, eventId: event?.id ?? null };
}
