/**
 * Turn 仓储。
 *
 * 事实源：
 * - docs/architecture/persistence.md （Turn 表）、（接纳事务边界）
 * - docs/architecture/agent-control-plane.md §7（Turn 接纳周期）
 * - docs/architecture/api-and-events.md （创建 Turn API）
 * - docs/architecture/conversations.md
 *
 * 职责：
 * - acceptUserMessageTurn：原子接纳用户消息 + Turn + item.created + turn.accepted（同事务）。
 * - acceptJobResultTurn：job_result_projection Turn 允许无 Invocation 从 accepted 直接 completed。
 * - updateTurnState：Turn 状态机转换（乐观锁）。
 * - getTurnById/getTurnsByThread：查询。
 *
 * 接纳事务边界（行 608-633）：
 * - 用户消息、Turn、item.created 和 turn.accepted 在一个事务提交。
 * - Runtime 暂不可用不回滚用户消息（Turn 从 accepted 开始）。
 * - user_message 在 Regenerate 和网络重发时保持唯一（由 Idempotency-Key 保证）。
 * - 只有 job_result_projection Turn 允许无 Invocation 从 accepted 直接 completed。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  ThreadNotAcceptingTurnsError,
  ThreadNotFoundError,
  TurnNotFoundError,
  TurnStateConflictError,
} from "@/lib/conversations/errors";
import {
  allocateEventSequences,
  allocateItemSequence,
  allocateTurnSequence,
} from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import {
  TURN_TERMINAL_STATES,
  type Thread,
  type ThreadEvent,
  type ThreadEventActorType,
  type ThreadItem,
  type Turn,
  type TurnState,
  type TurnTriggerType,
  threadEventTable,
  threadItemTable,
  threadTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import { and, asc, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** user_message Item 内容。 */
export interface UserMessageContent {
  /** 文本内容（非空）。 */
  text: string;
  /** 附件引用列表（可为空）。 */
  attachments?: Array<{
    workspace_attachment_id: string;
    resource_type: string;
    resource_ref: string;
  }>;
  /** 客户端消息 id（用于重发幂等）。 */
  client_message_id?: string;
}

/** 计算 user_message 内容 hash（sha256，递归排序 key 保证稳定）。 */
export function computeUserMessageHash(content: UserMessageContent): string {
  const sorted = JSON.stringify(sortKeys(content));
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
 * 原子接纳用户消息 Turn。
 *
 * 事务内（行 608-633）：
 * 1. SELECT FOR UPDATE 锁定 Thread 行
 * 2. 校验 lifecycleState == active
 * 3. 分配 turnSequence、itemSequence、2 个 eventSequences
 * 4. INSERT ThreadItem (user_message, completed)
 * 5. INSERT Turn (accepted, triggerItemId 指向 user_message Item)
 * 6. INSERT ThreadEvent (item.created)
 * 7. INSERT ThreadEvent (turn.accepted)
 * 8. UPDATE Thread (lastTurnSequence, lastItemSequence, lastEventSequence, lastActivityAt)
 *
 * Runtime 暂不可用不回滚（行 256）：Turn 从 accepted 开始，后续由阶段 5 接入 Runtime。
 */
export async function acceptUserMessageTurn(params: {
  tenantId: string;
  threadId: string;
  ownerUserId: string;
  content: UserMessageContent;
  triggerRef?: string;
  actorId: string;
  idempotencyKey?: string;
  correlationId?: string;
}): Promise<{
  thread: Thread;
  turn: Turn;
  item: ThreadItem;
  events: ThreadEvent[];
}> {
  const turnId = randomUUID();
  const itemId = randomUUID();
  const itemCreatedEventId = randomUUID();
  const turnAcceptedEventId = randomUUID();
  const now = new Date();
  const contentHash = computeUserMessageHash(params.content);

  const result = await db.transaction(async (tx) => {
    // 1. 锁定 Thread 行
    const [thread] = await tx
      .select()
      .from(threadTable)
      .where(and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, params.threadId)))
      .for("update")
      .limit(1);

    if (!thread) {
      throw new ThreadNotFoundError(params.threadId);
    }
    if (thread.lifecycleState !== "active") {
      throw new ThreadNotAcceptingTurnsError(params.threadId, thread.lifecycleState);
    }

    // 2. 分配 sequence（所有 sequence 在同一锁定事务内分配）
    // 事件顺序：turn.accepted 先于 item.created，确保投影时 Turn 行先创建（projector 按序消费）
    const turnSequence = thread.lastTurnSequence + 1;
    const itemSequence = thread.lastItemSequence + 1;
    const turnAcceptedSeq = thread.lastEventSequence + 1;
    const itemCreatedSeq = thread.lastEventSequence + 2;

    // 3. INSERT ThreadItem (user_message)
    await tx.insert(threadItemTable).values({
      id: itemId,
      threadId: params.threadId,
      turnId: turnId,
      itemSequence,
      itemType: "user_message",
      itemState: "completed",
      authorType: "user",
      authorId: params.ownerUserId,
      contentJson: params.content as unknown as Record<string, unknown>,
      contentHash,
      contextPolicy: "include",
      createdAt: now,
      updatedAt: now,
    });

    // 4. INSERT Turn (accepted)
    await tx.insert(turnTable).values({
      id: turnId,
      threadId: params.threadId,
      turnSequence,
      triggerType: "user_message",
      triggerRef: params.triggerRef ?? null,
      triggerItemId: itemId,
      turnState: "accepted",
      acceptedAt: now,
      versionNo: 1,
    });

    // 5. INSERT ThreadEvent (turn.accepted) —— 先于 item.created，投影器按序消费时 Turn 行先创建
    await tx.insert(threadEventTable).values({
      id: turnAcceptedEventId,
      threadId: params.threadId,
      eventSequence: turnAcceptedSeq,
      eventType: "turn.accepted",
      schemaVersion: 1,
      turnId,
      itemId,
      actorType: "user",
      actorId: params.ownerUserId,
      payloadJson: {
        // 投影上下文（turn_timeline_projection 需要 tenant_id 创建行）
        tenant_id: params.tenantId,
        turn_sequence: turnSequence,
        trigger_type: "user_message",
        trigger_item_id: itemId,
      },
      correlationId: params.correlationId ?? null,
      occurredAt: now,
      ingestedAt: now,
    });

    // 6. INSERT ThreadEvent (item.created)
    await tx.insert(threadEventTable).values({
      id: itemCreatedEventId,
      threadId: params.threadId,
      eventSequence: itemCreatedSeq,
      eventType: "item.created",
      schemaVersion: 1,
      turnId,
      itemId,
      actorType: "user",
      actorId: params.ownerUserId,
      payloadJson: {
        item_type: "user_message",
        content_hash: contentHash,
      },
      correlationId: params.correlationId ?? null,
      idempotencyKey: params.idempotencyKey ?? null,
      occurredAt: now,
      ingestedAt: now,
    });

    // 7. UPDATE Thread (sequence 基线 + lastActivityAt)
    await tx
      .update(threadTable)
      .set({
        lastTurnSequence: turnSequence,
        lastItemSequence: itemSequence,
        lastEventSequence: itemCreatedSeq,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(threadTable.id, params.threadId));

    return { thread, turnSequence, itemSequence, itemCreatedSeq, turnAcceptedSeq };
  });

  // 读取最终状态（事务外）
  const [updatedThread] = await db
    .select()
    .from(threadTable)
    .where(eq(threadTable.id, params.threadId))
    .limit(1);

  const [turn] = await db.select().from(turnTable).where(eq(turnTable.id, turnId)).limit(1);
  if (!turn) throw new Error(`acceptUserMessageTurn: Turn 行未找到（id=${turnId}）`);

  const [item] = await db
    .select()
    .from(threadItemTable)
    .where(eq(threadItemTable.id, itemId))
    .limit(1);
  if (!item) throw new Error(`acceptUserMessageTurn: ThreadItem 行未找到（id=${itemId}）`);

  const events = await db
    .select()
    .from(threadEventTable)
    .where(eq(threadEventTable.turnId, turnId))
    .orderBy(asc(threadEventTable.eventSequence));

  if (!updatedThread) {
    throw new Error("acceptUserMessageTurn: Thread 行未找到（事务后）");
  }

  return { thread: updatedThread, turn, item, events };
}

/**
 * 接纳 job_result_projection Turn（允许无 Invocation 从 accepted 直接 completed）。
 *
 * §7 行 176-187："只有 job_result_projection Turn 允许无 Invocation 从 accepted 直接 completed"。
 */
export async function acceptJobResultTurn(params: {
  tenantId: string;
  threadId: string;
  triggerRef: string;
  actorId: string;
  idempotencyKey?: string;
}): Promise<{ turn: Turn; events: ThreadEvent[] }> {
  const turnId = randomUUID();
  const turnAcceptedEventId = randomUUID();
  const turnCompletedEventId = randomUUID();
  const now = new Date();

  await db.transaction(async (tx) => {
    const [thread] = await tx
      .select()
      .from(threadTable)
      .where(and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, params.threadId)))
      .for("update")
      .limit(1);

    if (!thread) throw new ThreadNotFoundError(params.threadId);
    if (thread.lifecycleState !== "active") {
      throw new ThreadNotAcceptingTurnsError(params.threadId, thread.lifecycleState);
    }

    const turnSequence = thread.lastTurnSequence + 1;
    const acceptedSeq = thread.lastEventSequence + 1;
    const completedSeq = thread.lastEventSequence + 2;

    await tx.insert(turnTable).values({
      id: turnId,
      threadId: params.threadId,
      turnSequence,
      triggerType: "job_result_projection",
      triggerRef: params.triggerRef,
      turnState: "completed",
      acceptedAt: now,
      finishedAt: now,
      versionNo: 1,
    });

    await tx.insert(threadEventTable).values({
      id: turnAcceptedEventId,
      threadId: params.threadId,
      eventSequence: acceptedSeq,
      eventType: "turn.accepted",
      schemaVersion: 1,
      turnId,
      actorType: "system",
      payloadJson: {
        // 投影上下文（turn_timeline_projection 需要 tenant_id 创建行）
        tenant_id: params.tenantId,
        turn_sequence: turnSequence,
        trigger_type: "job_result_projection",
      },
      idempotencyKey: params.idempotencyKey ?? null,
      occurredAt: now,
      ingestedAt: now,
    });

    await tx.insert(threadEventTable).values({
      id: turnCompletedEventId,
      threadId: params.threadId,
      eventSequence: completedSeq,
      eventType: "turn.completed",
      schemaVersion: 1,
      turnId,
      actorType: "system",
      payloadJson: { turn_sequence: turnSequence },
      occurredAt: now,
      ingestedAt: now,
    });

    await tx
      .update(threadTable)
      .set({
        lastTurnSequence: turnSequence,
        lastEventSequence: completedSeq,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(threadTable.id, params.threadId));
  });

  const [turn] = await db.select().from(turnTable).where(eq(turnTable.id, turnId)).limit(1);
  if (!turn) throw new Error(`acceptJobResultTurn: Turn 行未找到（id=${turnId}）`);

  const events = await db
    .select()
    .from(threadEventTable)
    .where(eq(threadEventTable.turnId, turnId))
    .orderBy(asc(threadEventTable.eventSequence));

  return { turn, events };
}

/** child task Turn 的 trigger Item 内容（与 UserMessageContent 同构，但由平台注入）。 */
export interface ChildTaskContent {
  /** 委派任务描述文本（非空）。 */
  text: string;
  /** 关联 delegate ThreadRelation id（供 child task 溯源）。 */
  relationId?: string;
  /** 父 Invocation id（委派源）。 */
  parentInvocationId?: string;
}

/**
 * 原子接纳 child task Turn（S09-C02 子任务正式接纳端口）。
 *
 * 子 Thread 由 `delegateChildThread` 建出后无 Turn（lastTurnSequence=0）。本端口在子
 * Thread 内正式接纳一个系统触发的 child task Turn + trigger Item，使子 Thread 具备可被
 * 生产 Dispatcher 调度（dispatchInvocationForTurn / dispatchEmployeeTurn）的 accepted Turn。
 *
 * 语义：
 * - triggerType="system"（子任务由平台委派，非用户消息）。
 * - trigger Item 为 itemType="user_message"、authorType="system"（携带任务文本，作为
 *   子 Thread 的触发输入）。child task 与用户消息同构（都是进入子 Agent 上下文的输入），
 *   只是作者为平台而非员工。
 * - 事务内写 trigger Item + Turn(accepted) + turn.accepted + item.created Event，并更新
 *   Thread 的 turn/item/event sequence 基线。
 *
 * @throws ThreadNotFoundError 子 Thread 不存在
 * @throws ThreadNotAcceptingTurnsError 子 Thread 非 active
 */
export async function acceptChildTaskTurn(params: {
  tenantId: string;
  threadId: string;
  ownerUserId: string;
  content: ChildTaskContent;
  actorId?: string;
  correlationId?: string;
  idempotencyKey?: string;
}): Promise<{
  thread: Thread;
  turn: Turn;
  item: ThreadItem;
  events: ThreadEvent[];
}> {
  const turnId = randomUUID();
  const itemId = randomUUID();
  const itemCreatedEventId = randomUUID();
  const turnAcceptedEventId = randomUUID();
  const now = new Date();
  const contentHash = computeUserMessageHash(params.content);
  const actorId = params.actorId ?? params.ownerUserId;

  const result = await db.transaction(async (tx) => {
    const [thread] = await tx
      .select()
      .from(threadTable)
      .where(and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, params.threadId)))
      .for("update")
      .limit(1);

    if (!thread) {
      throw new ThreadNotFoundError(params.threadId);
    }
    if (thread.lifecycleState !== "active") {
      throw new ThreadNotAcceptingTurnsError(params.threadId, thread.lifecycleState);
    }

    const turnSequence = thread.lastTurnSequence + 1;
    const itemSequence = thread.lastItemSequence + 1;
    const turnAcceptedSeq = thread.lastEventSequence + 1;
    const itemCreatedSeq = thread.lastEventSequence + 2;

    // trigger Item：child task 文本（系统作者，itemType=user_message）。
    await tx.insert(threadItemTable).values({
      id: itemId,
      threadId: params.threadId,
      turnId: turnId,
      itemSequence,
      itemType: "user_message",
      itemState: "completed",
      authorType: "system",
      authorId: actorId,
      contentJson: params.content as unknown as Record<string, unknown>,
      contentHash,
      contextPolicy: "include",
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(turnTable).values({
      id: turnId,
      threadId: params.threadId,
      turnSequence,
      triggerType: "system",
      triggerRef: null,
      triggerItemId: itemId,
      turnState: "accepted",
      acceptedAt: now,
      versionNo: 1,
    });

    await tx.insert(threadEventTable).values({
      id: turnAcceptedEventId,
      threadId: params.threadId,
      eventSequence: turnAcceptedSeq,
      eventType: "turn.accepted",
      schemaVersion: 1,
      turnId,
      itemId,
      actorType: "system",
      actorId,
      payloadJson: {
        tenant_id: params.tenantId,
        turn_sequence: turnSequence,
        trigger_type: "system",
        trigger_item_id: itemId,
      },
      correlationId: params.correlationId ?? null,
      occurredAt: now,
      ingestedAt: now,
    });

    await tx.insert(threadEventTable).values({
      id: itemCreatedEventId,
      threadId: params.threadId,
      eventSequence: itemCreatedSeq,
      eventType: "item.created",
      schemaVersion: 1,
      turnId,
      itemId,
      actorType: "system",
      actorId,
      payloadJson: {
        item_type: "user_message",
        content_hash: contentHash,
      },
      correlationId: params.correlationId ?? null,
      idempotencyKey: params.idempotencyKey ?? null,
      occurredAt: now,
      ingestedAt: now,
    });

    await tx
      .update(threadTable)
      .set({
        lastTurnSequence: turnSequence,
        lastItemSequence: itemSequence,
        lastEventSequence: itemCreatedSeq,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(threadTable.id, params.threadId));

    return { thread, turnSequence, itemSequence, itemCreatedSeq, turnAcceptedSeq };
  });

  const [updatedThread] = await db
    .select()
    .from(threadTable)
    .where(eq(threadTable.id, params.threadId))
    .limit(1);
  const [turn] = await db.select().from(turnTable).where(eq(turnTable.id, turnId)).limit(1);
  if (!turn) throw new Error(`acceptChildTaskTurn: Turn 行未找到（id=${turnId}）`);
  const [item] = await db
    .select()
    .from(threadItemTable)
    .where(eq(threadItemTable.id, itemId))
    .limit(1);
  if (!item) throw new Error(`acceptChildTaskTurn: ThreadItem 行未找到（id=${itemId}）`);
  const events = await db
    .select()
    .from(threadEventTable)
    .where(eq(threadEventTable.turnId, turnId))
    .orderBy(asc(threadEventTable.eventSequence));
  if (!updatedThread) throw new Error("acceptChildTaskTurn: Thread 行未找到（事务后）");

  return { thread: updatedThread, turn, item, events };
}

/** 按 id 获取 Turn（跨租户隔离）。不存在返回 null。 */
export async function getTurnById(tenantId: string, turnId: string): Promise<Turn | null> {
  const [row] = await db
    .select()
    .from(turnTable)
    .innerJoin(threadTable, eq(turnTable.threadId, threadTable.id))
    .where(and(eq(threadTable.tenantId, tenantId), eq(turnTable.id, turnId)))
    .limit(1);
  return row?.Turn ?? null;
}

/** 列出 Thread 的 Turn（按 turn_sequence 升序）。 */
export async function getTurnsByThread(tenantId: string, threadId: string): Promise<Turn[]> {
  const rows = await db
    .select({ turn: turnTable })
    .from(turnTable)
    .innerJoin(threadTable, eq(turnTable.threadId, threadTable.id))
    .where(and(eq(threadTable.tenantId, tenantId), eq(turnTable.threadId, threadId)))
    .orderBy(asc(turnTable.turnSequence));
  return rows.map((r) => r.turn);
}

/**
 * 更新 Turn 状态。
 *
 * 状态机（行 255-267）：
 * - accepted → queued → running → completed
 * - accepted/queued/running → failed/cancelled
 * - running → waiting_user → running
 * - running → interrupted
 * - completed/interrupted/failed → regenerating → completed（成功）/ 原终态（失败）
 * - cancelled 不可恢复
 *
 * 乐观锁：versionNo 不匹配返回 null。
 */
export async function updateTurnState(
  tenantId: string,
  turnId: string,
  nextState: TurnState,
  expectedVersionNo: number,
  options?: {
    activeInvocationId?: string | null;
    latestInvocationId?: string | null;
    adoptedInvocationId?: string | null;
    finalItemId?: string | null;
    errorCode?: string | null;
    regenerationBaseState?: "completed" | "interrupted" | "failed" | null;
  },
): Promise<Turn | null> {
  const current = await getTurnById(tenantId, turnId);
  if (!current) return null;
  if (current.versionNo !== expectedVersionNo) {
    throw new TurnStateConflictError(turnId, current.turnState, "version_conflict");
  }

  // 状态机校验
  const allowedTransitions: Record<TurnState, TurnState[]> = {
    accepted: ["queued", "running", "completed", "failed", "cancelled"],
    queued: ["running", "failed", "cancelled"],
    running: ["completed", "failed", "cancelled", "interrupted", "waiting_user"],
    waiting_user: ["running", "failed", "cancelled"],
    regenerating: ["completed", "failed", "interrupted"],
    completed: ["regenerating"],
    interrupted: ["regenerating"],
    failed: ["regenerating"],
    cancelled: [],
  };

  if (!allowedTransitions[current.turnState].includes(nextState)) {
    throw new TurnStateConflictError(turnId, current.turnState, `→ ${nextState}`);
  }

  const now = new Date();
  const updates: Partial<typeof turnTable.$inferInsert> = {
    turnState: nextState,
    versionNo: expectedVersionNo + 1,
  };

  // 状态相关的字段更新
  if (nextState === "queued" && options?.activeInvocationId) {
    updates.activeInvocationId = options.activeInvocationId;
    updates.latestInvocationId = options.activeInvocationId;
  }
  if (nextState === "running") {
    updates.startedAt = current.startedAt ?? now;
    if (options?.activeInvocationId) {
      updates.activeInvocationId = options.activeInvocationId;
      updates.latestInvocationId = options.activeInvocationId;
    }
  }
  if (nextState === "waiting_user") {
    updates.waitingAt = now;
    if (options?.activeInvocationId !== undefined) {
      updates.activeInvocationId = options.activeInvocationId;
    }
  }
  if (nextState === "completed") {
    updates.finishedAt = now;
    updates.activeInvocationId = null;
    if (options?.adoptedInvocationId !== undefined) {
      updates.adoptedInvocationId = options.adoptedInvocationId;
    }
    if (options?.finalItemId !== undefined) {
      updates.finalItemId = options.finalItemId;
    }
    if (options?.regenerationBaseState !== undefined) {
      updates.regenerationBaseState = null;
    }
  }
  if (nextState === "failed") {
    updates.finishedAt = now;
    updates.activeInvocationId = null;
    if (options?.errorCode !== undefined) {
      updates.errorCode = options.errorCode;
    }
    if (options?.regenerationBaseState !== undefined) {
      updates.regenerationBaseState = null;
    }
  }
  if (nextState === "interrupted" || nextState === "cancelled") {
    updates.finishedAt = now;
    updates.activeInvocationId = null;
  }
  if (nextState === "regenerating") {
    updates.regenerationNo = current.regenerationNo + 1;
    if (options?.regenerationBaseState !== undefined) {
      updates.regenerationBaseState = options.regenerationBaseState;
    }
    if (options?.latestInvocationId !== undefined) {
      updates.latestInvocationId = options.latestInvocationId;
      updates.activeInvocationId = options.latestInvocationId;
    }
  }

  const result = await db
    .update(turnTable)
    .set(updates)
    .where(and(eq(turnTable.id, turnId), eq(turnTable.versionNo, expectedVersionNo)));

  if (result[0].affectedRows === 0) return null;
  return getTurnById(tenantId, turnId);
}

/** Turn 是否处于终态。 */
export function isTerminalTurn(turn: Turn): boolean {
  return TURN_TERMINAL_STATES.includes(turn.turnState);
}

// 导出事务句柄类型和 sequence 分配函数供外部组合事务使用
export type { Tx };
export { allocateEventSequences, allocateItemSequence, allocateTurnSequence };
export {
  allocateAndWriteEvents,
  computeEventPayloadHash,
  getLatestEventCursor,
} from "@/lib/conversations/thread-queries";
