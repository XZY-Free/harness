/**
 * V11 PendingInput 仓储（事务性，同事务写 Event）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §5.6（PendingInput 表，行 324-339）、§9.1（事务边界）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §3.14（创建 PendingInput 不生成 user_message Item）、§3.17（删除 PendingInput 不生成 user_message Item）
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §3.6-3.10（PendingInput API）
 *
 * 职责：
 * - listPendingInputs：查询 Thread 当前 pending 队列 + queue_etag。
 * - createPendingInput：事务内锁定 Thread → 计算 queue_position（max+1000 或 1000）→ INSERT → 递增 Thread.pendingQueueVersionNo → 写 pending_input.created Event。
 * - editPendingInput：事务内锁定 PendingInput + Thread → 校验 pending → 乐观锁 → 更新 inputJson/inputHash + 递增 versionNo → 递增 Thread.pendingQueueVersionNo → 写 pending_input.updated Event。
 * - reorderPendingInputs：事务内锁定 Thread → 校验队列 ETag → 校验 ordered_ids 集合一致 → 重新分配 queue_position → 递增 Thread.pendingQueueVersionNo → 写 pending_input.reordered Event。
 * - removePendingInput：事务内锁定 PendingInput + Thread → 校验 pending → 乐观锁 → 更新 input_state=removed → 递增 Thread.pendingQueueVersionNo → 写 pending_input.removed Event。
 *
 * 关键约束：
 * - 创建/删除 PendingInput 不生成 user_message Item（§3.14、§3.17）。
 * - admitted/removed 不可编辑/删除/重排（§5.6 行 339）。
 * - 每个 mutate 队列的操作都必须在锁定 Thread 行后递增 pendingQueueVersionNo。
 * - 重排必须校验 ordered_ids 集合与当前 pending 集合完全一致。
 * - 隐藏式 404：跨租户/非 owner 的 PendingInput 一律抛 PendingInputNotFoundError。
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  PendingInputNotFoundError,
  PendingInputNotPendingError,
  PendingInputReorderConflictError,
  PendingInputVersionConflictError,
  ThreadNotFoundError,
  ThreadVersionConflictError,
} from "@/lib/v11/conversation/errors";
import { allocateEventSequences, insertThreadEvent } from "@/lib/v11/conversation/thread-queries";
import type {
  PendingInputState,
  ThreadEventActorType,
  V11PendingInput,
  V11Thread,
  V11ThreadEvent,
} from "@/lib/v11/schema/conversation";
import { v11PendingInput, v11Thread } from "@/lib/v11/schema/conversation";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** PendingInput 结构化输入（{ type, text } 或类似）。 */
export type PendingInputContent = Record<string, unknown> & { type: string };

/** listPendingInputs 返回的单条 pending 输入投影。 */
export interface PendingInputListItem {
  id: string;
  queue_position: number;
  input: PendingInputContent;
  etag: string;
}

/** listPendingInputs 返回的队列快照。 */
export interface PendingInputListResult {
  thread_id: string;
  queue_etag: string;
  pending_inputs: PendingInputListItem[];
}

/** createPendingInput 返回的单条结果。 */
export interface CreatePendingInputResult {
  id: string;
  thread_id: string;
  input_state: PendingInputState;
  queue_position: number;
  input: PendingInputContent;
  etag: string;
  queue_etag: string;
}

/** editPendingInput 返回的结果。 */
export interface EditPendingInputResult {
  id: string;
  thread_id: string;
  input_state: PendingInputState;
  queue_position: number;
  input: PendingInputContent;
  etag: string;
  queue_etag: string;
}

/** reorderPendingInputs 返回的结果。 */
export interface ReorderPendingInputsResult {
  thread_id: string;
  queue_etag: string;
  pending_inputs: PendingInputListItem[];
}

/** removePendingInput 返回的结果。 */
export interface RemovePendingInputResult {
  id: string;
  thread_id: string;
  input_state: PendingInputState;
  removed_at: string;
  queue_etag: string;
}

/** 计算 PendingInput 内容 hash（sha256，递归排序 key 保证稳定）。 */
export function computePendingInputHash(input: PendingInputContent): string {
  const sorted = JSON.stringify(sortKeys(input));
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

/** 把 decimal 字符串转 number（队列位置都是整数，安全范围内）。 */
function positionToNumber(decimalStr: string): number {
  return Number.parseFloat(decimalStr);
}

/** 投影 V11PendingInput 行为 list item。 */
function projectListItem(row: V11PendingInput): PendingInputListItem {
  return {
    id: row.id,
    queue_position: positionToNumber(row.queuePosition),
    input: row.inputJson as PendingInputContent,
    etag: `pending-${row.versionNo}`,
  };
}

// ─── listPendingInputs ─────────────────────────────────────

/**
 * 查询 Thread 当前 pending 队列（按 queue_position 升序）+ queue_etag。
 *
 * 跨租户隔离：Thread 不存在或非 owner → 抛 ThreadNotFoundError（route 层映射 404）。
 */
export async function listPendingInputs(
  tenantId: string,
  threadId: string,
): Promise<PendingInputListResult> {
  // 先校验 Thread 存在且同租户（route 层已经校验 owner，这里只做 tenant 校验）
  const [thread] = await db
    .select({ id: v11Thread.id, queueVersionNo: v11Thread.pendingQueueVersionNo })
    .from(v11Thread)
    .where(and(eq(v11Thread.tenantId, tenantId), eq(v11Thread.id, threadId)))
    .limit(1);

  if (!thread) {
    throw new ThreadNotFoundError(threadId);
  }

  const rows = await db
    .select()
    .from(v11PendingInput)
    .where(and(eq(v11PendingInput.threadId, threadId), eq(v11PendingInput.inputState, "pending")))
    .orderBy(asc(v11PendingInput.queuePosition));

  return {
    thread_id: threadId,
    queue_etag: `pending-queue-${thread.queueVersionNo}`,
    pending_inputs: rows.map(projectListItem),
  };
}

// ─── createPendingInput ─────────────────────────────────────

/**
 * 事务内创建 PendingInput 并写 pending_input.created Event。
 *
 * 流程：
 * 1. SELECT FOR UPDATE Thread（校验 tenantId + active lifecycle）
 * 2. 计算 queue_position = max(existing pending) + 1000，无现有则 1000
 * 3. INSERT PendingInput (pending, versionNo=1)
 * 4. 递增 Thread.pendingQueueVersionNo
 * 5. 写 pending_input.created Event
 *
 * 关键约束：
 * - 创建 PendingInput 不生成 user_message Item（§3.14）。
 * - UNIQUE(thread_id, client_message_id) 防止重发；违反由 DB 唯一约束报错。
 */
export async function createPendingInput(params: {
  tenantId: string;
  threadId: string;
  ownerUserId: string;
  input: PendingInputContent;
  clientMessageId?: string;
  idempotencyKey?: string;
  correlationId?: string;
}): Promise<CreatePendingInputResult> {
  const inputHash = computePendingInputHash(params.input);
  const pendingInputId = randomUUID();
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE Thread
    const [thread] = await tx
      .select()
      .from(v11Thread)
      .where(and(eq(v11Thread.tenantId, params.tenantId), eq(v11Thread.id, params.threadId)))
      .for("update")
      .limit(1);

    if (!thread) {
      throw new ThreadNotFoundError(params.threadId);
    }
    // 创建 PendingInput 不要求 Thread active；archived 也允许（仅不允许新 Turn）
    // 但仍校验 owner（route 层已校验；仓储做防御性 tenant 校验）

    // 2. 计算 queue_position = max(pending) + 1000，无则 1000
    const [maxRow] = await tx
      .select({ maxPos: sql<string>`COALESCE(MAX(${v11PendingInput.queuePosition}), 0)` })
      .from(v11PendingInput)
      .where(
        and(
          eq(v11PendingInput.threadId, params.threadId),
          eq(v11PendingInput.inputState, "pending"),
        ),
      );
    const maxPos = maxRow?.maxPos ?? "0";
    const nextPosition = Number.parseFloat(maxPos) + 1000;

    // 3. INSERT PendingInput
    await tx.insert(v11PendingInput).values({
      id: pendingInputId,
      threadId: params.threadId,
      clientMessageId: params.clientMessageId ?? null,
      inputState: "pending",
      queuePosition: nextPosition.toString(),
      inputJson: params.input as unknown as Record<string, unknown>,
      inputHash,
      admittedTurnId: null,
      admittedItemId: null,
      versionNo: 1,
      createdAt: now,
      updatedAt: now,
      removedAt: null,
    });

    // 4. 递增 Thread.pendingQueueVersionNo
    const newQueueVersionNo = thread.pendingQueueVersionNo + 1;
    await tx
      .update(v11Thread)
      .set({
        pendingQueueVersionNo: newQueueVersionNo,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(v11Thread.id, params.threadId));

    // 5. 写 pending_input.created Event
    const startSequence = await allocateEventSequences(tx, params.threadId, 1);
    await insertThreadEvent(tx, params.threadId, startSequence, {
      eventType: "pending_input.created",
      actorType: "user" as ThreadEventActorType,
      actorId: params.ownerUserId,
      itemId: pendingInputId,
      payload: {
        pending_input_id: pendingInputId,
        input_hash: inputHash,
        queue_position: nextPosition,
        client_message_id: params.clientMessageId ?? null,
      },
      idempotencyKey: params.idempotencyKey,
      correlationId: params.correlationId,
    });

    return { thread, newQueueVersionNo, nextPosition };
  });

  // 事务外回读（事务内已写入，回读确认）
  const [created] = await db
    .select()
    .from(v11PendingInput)
    .where(eq(v11PendingInput.id, pendingInputId))
    .limit(1);
  if (!created) {
    throw new Error(`createPendingInput: 行未找到（id=${pendingInputId}）`);
  }

  return {
    id: created.id,
    thread_id: created.threadId,
    input_state: created.inputState,
    queue_position: result.nextPosition,
    input: created.inputJson as PendingInputContent,
    etag: `pending-${created.versionNo}`,
    queue_etag: `pending-queue-${result.newQueueVersionNo}`,
  };
}

// ─── editPendingInput ──────────────────────────────────────

/**
 * 事务内编辑 PendingInput 内容并写 pending_input.updated Event。
 *
 * 流程：
 * 1. SELECT FOR UPDATE PendingInput + Thread（隐藏式 404：跨租户/非 owner → NotFound）
 * 2. 校验 input_state=pending（admitted/removed → NotPending）
 * 3. 乐观锁校验 versionNo（不匹配 → VersionConflict）
 * 4. 更新 inputJson/inputHash + 递增 versionNo
 * 5. 递增 Thread.pendingQueueVersionNo
 * 6. 写 pending_input.updated Event
 *
 * 隐藏式 404：跨租户/非 owner 一律抛 PendingInputNotFoundError（不泄露存在）。
 */
export async function editPendingInput(params: {
  tenantId: string;
  ownerUserId: string;
  pendingInputId: string;
  expectedVersionNo: number;
  input: PendingInputContent;
  correlationId?: string;
}): Promise<EditPendingInputResult> {
  const inputHash = computePendingInputHash(params.input);
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE PendingInput
    const [row] = await tx
      .select()
      .from(v11PendingInput)
      .where(eq(v11PendingInput.id, params.pendingInputId))
      .for("update")
      .limit(1);

    if (!row) {
      throw new PendingInputNotFoundError(params.pendingInputId);
    }

    // 2. SELECT FOR UPDATE Thread（隐藏式 404：跨租户/非 owner → NotFound）
    const [thread] = await tx
      .select()
      .from(v11Thread)
      .where(eq(v11Thread.id, row.threadId))
      .for("update")
      .limit(1);

    if (
      !thread ||
      thread.tenantId !== params.tenantId ||
      thread.ownerUserId !== params.ownerUserId
    ) {
      throw new PendingInputNotFoundError(params.pendingInputId);
    }

    // 3. 校验 input_state=pending
    if (row.inputState !== "pending") {
      throw new PendingInputNotPendingError(params.pendingInputId, row.inputState, "edit");
    }

    // 4. 乐观锁校验 versionNo
    if (row.versionNo !== params.expectedVersionNo) {
      throw new PendingInputVersionConflictError(
        params.pendingInputId,
        params.expectedVersionNo,
        row.versionNo,
      );
    }

    // 5. 更新 inputJson/inputHash + 递增 versionNo
    const newVersionNo = row.versionNo + 1;
    await tx
      .update(v11PendingInput)
      .set({
        inputJson: params.input as unknown as Record<string, unknown>,
        inputHash,
        versionNo: newVersionNo,
        updatedAt: now,
      })
      .where(eq(v11PendingInput.id, params.pendingInputId));

    // 6. 递增 Thread.pendingQueueVersionNo
    const newQueueVersionNo = thread.pendingQueueVersionNo + 1;
    await tx
      .update(v11Thread)
      .set({
        pendingQueueVersionNo: newQueueVersionNo,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(v11Thread.id, thread.id));

    // 7. 写 pending_input.updated Event
    const startSequence = await allocateEventSequences(tx, thread.id, 1);
    await insertThreadEvent(tx, thread.id, startSequence, {
      eventType: "pending_input.updated",
      actorType: "user" as ThreadEventActorType,
      actorId: params.ownerUserId,
      itemId: params.pendingInputId,
      payload: {
        pending_input_id: params.pendingInputId,
        previous_input_hash: row.inputHash,
        new_input_hash: inputHash,
      },
      correlationId: params.correlationId,
    });

    return { thread, newQueueVersionNo, newVersionNo };
  });

  // 回读
  const [updated] = await db
    .select()
    .from(v11PendingInput)
    .where(eq(v11PendingInput.id, params.pendingInputId))
    .limit(1);
  if (!updated) {
    throw new Error(`editPendingInput: 行未找到（id=${params.pendingInputId}）`);
  }

  return {
    id: updated.id,
    thread_id: updated.threadId,
    input_state: updated.inputState,
    queue_position: positionToNumber(updated.queuePosition),
    input: updated.inputJson as PendingInputContent,
    etag: `pending-${result.newVersionNo}`,
    queue_etag: `pending-queue-${result.newQueueVersionNo}`,
  };
}

// ─── reorderPendingInputs ──────────────────────────────────

/**
 * 事务内重排 Thread 的 pending 队列并写 pending_input.reordered Event。
 *
 * 流程：
 * 1. SELECT FOR UPDATE Thread（校验 pendingQueueVersionNo 乐观锁）
 * 2. 查询所有 pending PendingInput
 * 3. 校验 ordered_ids 集合与 pending 集合完全一致（不完整 → incomplete；含非 pending → extra）
 * 4. 重新分配 queue_position（1000, 2000, 3000...）
 * 5. 批量 UPDATE PendingInput.queue_position
 * 6. 递增 Thread.pendingQueueVersionNo
 * 7. 写 pending_input.reordered Event
 *
 * 关键约束：
 * - ordered_ids 集合必须与当前 pending 集合完全一致（无遗漏、无多余）。
 * - 重排不修改 PendingInput.versionNo（只改 queue_position）。
 */
export async function reorderPendingInputs(params: {
  tenantId: string;
  threadId: string;
  ownerUserId: string;
  expectedQueueVersionNo: number;
  orderedIds: string[];
  idempotencyKey?: string;
  correlationId?: string;
}): Promise<ReorderPendingInputsResult> {
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE Thread（乐观锁校验 pendingQueueVersionNo）
    const [thread] = await tx
      .select()
      .from(v11Thread)
      .where(and(eq(v11Thread.tenantId, params.tenantId), eq(v11Thread.id, params.threadId)))
      .for("update")
      .limit(1);

    if (!thread) {
      throw new ThreadNotFoundError(params.threadId);
    }
    if (thread.ownerUserId !== params.ownerUserId) {
      // 非 owner：隐藏式 404
      throw new ThreadNotFoundError(params.threadId);
    }
    if (thread.pendingQueueVersionNo !== params.expectedQueueVersionNo) {
      throw new ThreadVersionConflictError(
        params.threadId,
        params.expectedQueueVersionNo,
        thread.pendingQueueVersionNo,
      );
    }

    // 2. 查询所有 pending PendingInput
    const pendingRows = await tx
      .select()
      .from(v11PendingInput)
      .where(
        and(
          eq(v11PendingInput.threadId, params.threadId),
          eq(v11PendingInput.inputState, "pending"),
        ),
      )
      .for("update");

    const pendingIds = new Set(pendingRows.map((r) => r.id));
    const orderedSet = new Set(params.orderedIds);

    // 3. 校验 ordered_ids 集合一致
    const missing = [...pendingIds].filter((id) => !orderedSet.has(id));
    const extra = [...orderedSet].filter((id) => !pendingIds.has(id));

    if (missing.length > 0 || extra.length > 0) {
      throw new PendingInputReorderConflictError(
        params.threadId,
        missing.length > 0 ? "incomplete" : "extra",
        [...pendingIds],
        params.orderedIds,
      );
    }

    // 4. 重新分配 queue_position（1000, 2000, 3000...）
    for (let i = 0; i < params.orderedIds.length; i++) {
      const id = params.orderedIds[i];
      if (!id) continue;
      const newPosition = (i + 1) * 1000;
      await tx
        .update(v11PendingInput)
        .set({
          queuePosition: newPosition.toString(),
          updatedAt: now,
        })
        .where(eq(v11PendingInput.id, id));
    }

    // 5. 递增 Thread.pendingQueueVersionNo
    const newQueueVersionNo = thread.pendingQueueVersionNo + 1;
    await tx
      .update(v11Thread)
      .set({
        pendingQueueVersionNo: newQueueVersionNo,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(v11Thread.id, params.threadId));

    // 6. 写 pending_input.reordered Event
    const startSequence = await allocateEventSequences(tx, params.threadId, 1);
    await insertThreadEvent(tx, params.threadId, startSequence, {
      eventType: "pending_input.reordered",
      actorType: "user" as ThreadEventActorType,
      actorId: params.ownerUserId,
      payload: {
        ordered_ids: params.orderedIds,
        previous_queue_version: thread.pendingQueueVersionNo,
        new_queue_version: newQueueVersionNo,
      },
      idempotencyKey: params.idempotencyKey,
      correlationId: params.correlationId,
    });

    return { thread, newQueueVersionNo };
  });

  // 回读所有 pending
  const rows = await db
    .select()
    .from(v11PendingInput)
    .where(
      and(eq(v11PendingInput.threadId, params.threadId), eq(v11PendingInput.inputState, "pending")),
    )
    .orderBy(asc(v11PendingInput.queuePosition));

  return {
    thread_id: params.threadId,
    queue_etag: `pending-queue-${result.newQueueVersionNo}`,
    pending_inputs: rows.map(projectListItem),
  };
}

// ─── removePendingInput ────────────────────────────────────

/**
 * 事务内移除 PendingInput 并写 pending_input.removed Event。
 *
 * 流程：
 * 1. SELECT FOR UPDATE PendingInput + Thread（隐藏式 404：跨租户/非 owner → NotFound）
 * 2. 校验 input_state=pending
 * 3. 乐观锁校验 versionNo
 * 4. 更新 input_state=removed + removed_at
 * 5. 递增 Thread.pendingQueueVersionNo
 * 6. 写 pending_input.removed Event
 *
 * 关键约束：
 * - 删除 PendingInput 不生成 user_message Item（§3.17）。
 */
export async function removePendingInput(params: {
  tenantId: string;
  ownerUserId: string;
  pendingInputId: string;
  expectedVersionNo: number;
  correlationId?: string;
}): Promise<RemovePendingInputResult> {
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE PendingInput
    const [row] = await tx
      .select()
      .from(v11PendingInput)
      .where(eq(v11PendingInput.id, params.pendingInputId))
      .for("update")
      .limit(1);

    if (!row) {
      throw new PendingInputNotFoundError(params.pendingInputId);
    }

    // 2. SELECT FOR UPDATE Thread（隐藏式 404：跨租户/非 owner → NotFound）
    const [thread] = await tx
      .select()
      .from(v11Thread)
      .where(eq(v11Thread.id, row.threadId))
      .for("update")
      .limit(1);

    if (
      !thread ||
      thread.tenantId !== params.tenantId ||
      thread.ownerUserId !== params.ownerUserId
    ) {
      throw new PendingInputNotFoundError(params.pendingInputId);
    }

    // 3. 校验 input_state=pending
    if (row.inputState !== "pending") {
      throw new PendingInputNotPendingError(params.pendingInputId, row.inputState, "remove");
    }

    // 4. 乐观锁校验 versionNo
    if (row.versionNo !== params.expectedVersionNo) {
      throw new PendingInputVersionConflictError(
        params.pendingInputId,
        params.expectedVersionNo,
        row.versionNo,
      );
    }

    // 5. 更新 input_state=removed + removed_at
    await tx
      .update(v11PendingInput)
      .set({
        inputState: "removed",
        removedAt: now,
        updatedAt: now,
      })
      .where(eq(v11PendingInput.id, params.pendingInputId));

    // 6. 递增 Thread.pendingQueueVersionNo
    const newQueueVersionNo = thread.pendingQueueVersionNo + 1;
    await tx
      .update(v11Thread)
      .set({
        pendingQueueVersionNo: newQueueVersionNo,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(v11Thread.id, thread.id));

    // 7. 写 pending_input.removed Event
    const startSequence = await allocateEventSequences(tx, thread.id, 1);
    await insertThreadEvent(tx, thread.id, startSequence, {
      eventType: "pending_input.removed",
      actorType: "user" as ThreadEventActorType,
      actorId: params.ownerUserId,
      itemId: params.pendingInputId,
      payload: {
        pending_input_id: params.pendingInputId,
        previous_input_hash: row.inputHash,
      },
      correlationId: params.correlationId,
    });

    return { thread, newQueueVersionNo };
  });

  return {
    id: params.pendingInputId,
    thread_id: result.thread.id,
    input_state: "removed",
    removed_at: now.toISOString(),
    queue_etag: `pending-queue-${result.newQueueVersionNo}`,
  };
}

// ─── 查询辅助 ───────────────────────────────────────────────

/**
 * 按 id 获取 PendingInput（跨租户隔离）。
 *
 * 隐藏式 404：Thread 跨租户/不存在 → 返回 null。
 */
export async function getPendingInputById(
  tenantId: string,
  pendingInputId: string,
): Promise<V11PendingInput | null> {
  const [row] = await db
    .select({ item: v11PendingInput })
    .from(v11PendingInput)
    .innerJoin(v11Thread, eq(v11PendingInput.threadId, v11Thread.id))
    .where(and(eq(v11Thread.tenantId, tenantId), eq(v11PendingInput.id, pendingInputId)))
    .limit(1);
  return row?.item ?? null;
}

/** 按 thread + clientMessageId 查找已存在的 PendingInput（用于幂等校验）。 */
export async function findPendingInputByClientMessageId(
  tenantId: string,
  threadId: string,
  clientMessageId: string,
): Promise<V11PendingInput | null> {
  const [row] = await db
    .select({ item: v11PendingInput })
    .from(v11PendingInput)
    .innerJoin(v11Thread, eq(v11PendingInput.threadId, v11Thread.id))
    .where(
      and(
        eq(v11Thread.tenantId, tenantId),
        eq(v11PendingInput.threadId, threadId),
        isNull(v11PendingInput.removedAt),
        eq(v11PendingInput.clientMessageId, clientMessageId),
      ),
    )
    .limit(1);
  return row?.item ?? null;
}

// 导出事务句柄类型供外部组合事务使用
export type { Tx };
export {
  allocateEventSequences,
  getLatestEventCursor,
} from "@/lib/v11/conversation/thread-queries";
