/** Invocation persistence: the serialized root for every execution subject. */
import { createHash, randomUUID } from "node:crypto";
import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
import { type DbOrTx, db } from "@/lib/db/client";
import {
  type ThreadEvent,
  type ThreadEventActorType,
  threadTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import {
  INVOCATION_TERMINAL_STATES,
  type Invocation,
  type InvocationExecutionState,
  type InvocationKind,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { InvocationNotFoundError, InvocationStateConflictError } from "@/lib/runtime/errors";
import { and, asc, eq, sql } from "drizzle-orm";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const allowedTransitions: Record<InvocationExecutionState, InvocationExecutionState[]> = {
  queued: ["running", "cancelled", "failed", "lost"],
  running: ["waiting_user", "completed", "failed", "cancelled", "lost"],
  waiting_user: ["running", "cancelled", "failed", "lost"],
  completed: [],
  failed: [],
  cancelled: [],
  lost: [],
};

export interface CreateInvocationParams {
  tenantId: string;
  threadId?: string | null;
  turnId?: string | null;
  jobId?: string | null;
  invocationKind: InvocationKind;
  triggerItemId?: string | null;
  replacesInvocationId?: string | null;
  inputDigest?: string;
  correlationId?: string | null;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
}

export interface CreateInvocationResult {
  invocation: Invocation;
  event: ThreadEvent | null;
}

function digestInput(params: CreateInvocationParams): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        threadId: params.threadId ?? null,
        turnId: params.turnId ?? null,
        jobId: params.jobId ?? null,
        triggerItemId: params.triggerItemId ?? null,
        invocationKind: params.invocationKind,
      }),
    )
    .digest("hex")}`;
}

export async function allocateInvocationSequence(
  tx: Tx,
  threadId: string | null,
  jobId: string | null,
): Promise<number> {
  const owner = threadId
    ? eq(invocationTable.threadId, threadId)
    : jobId
      ? eq(invocationTable.jobId, jobId)
      : null;
  if (!owner) throw new InvocationStateConflictError("<new>", "queued", "缺少执行主体");
  const [row] = await tx
    .select({ maxSeq: sql<number>`COALESCE(MAX(${invocationTable.invocationSequence}), 0)` })
    .from(invocationTable)
    .where(owner);
  return threadId ? (row?.maxSeq ?? 0) + 1 : 1;
}

export async function createInvocation(
  params: CreateInvocationParams,
): Promise<CreateInvocationResult> {
  const hasTurn = Boolean(params.turnId);
  const hasJob = Boolean(params.jobId);
  if (hasTurn === hasJob) {
    throw new InvocationStateConflictError("<new>", "queued", "turnId/jobId 必须恰有一个非空");
  }
  if (hasTurn && !params.threadId) {
    throw new InvocationStateConflictError("<new>", "queued", "Thread 执行必须提供 threadId");
  }

  const invocationId = randomUUID();
  const inputDigest = params.inputDigest ?? digestInput(params);
  const result = await db.transaction(async (tx) => {
    if (params.threadId) {
      const [thread] = await tx
        .select({ id: threadTable.id })
        .from(threadTable)
        .where(and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, params.threadId)))
        .for("update")
        .limit(1);
      if (!thread) throw new InvocationStateConflictError(invocationId, "queued", "Thread 不存在");
    }
    const invocationSequence = await allocateInvocationSequence(
      tx,
      params.threadId ?? null,
      params.jobId ?? null,
    );
    await tx.insert(invocationTable).values({
      id: invocationId,
      tenantId: params.tenantId,
      subjectType: params.jobId ? "job" : "thread",
      threadId: params.threadId ?? null,
      turnId: params.turnId ?? null,
      jobId: params.jobId ?? null,
      triggerItemId: params.triggerItemId ?? null,
      replacesInvocationId: params.replacesInvocationId ?? null,
      outputItemId: null,
      invocationSequence,
      invocationKind: params.invocationKind,
      executionState: "queued",
      inputDigest,
      resultRef: null,
      resultDigest: null,
      lastOwnershipEpoch: 0n,
      lastProducerSequence: 0n,
      recoveryVersion: 0,
      checkpointGate: "open",
      checkpointIntentId: null,
      checkpointOwnerId: null,
      checkpointDeadline: null,
      checkpointProducerSequence: null,
      checkpointRecoveryVersion: null,
      checkpointAnchor: null,
      checkpointPreparedEvidence: null,
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorSummary: null,
    });

    let event: ThreadEvent | null = null;
    if (params.threadId) {
      const [thread] = await tx
        .select({ id: threadTable.id })
        .from(threadTable)
        .where(eq(threadTable.id, params.threadId))
        .for("update")
        .limit(1);
      if (thread) {
        const sequence = await allocateEventSequences(tx, thread.id, 1);
        event = await insertThreadEvent(tx, thread.id, sequence, {
          eventType: "invocation.queued",
          turnId: params.turnId ?? undefined,
          invocationId,
          actorType: params.actorType ?? "system",
          actorId: params.actorId ?? undefined,
          payload: {
            invocation_kind: params.invocationKind,
            trigger_item_id: params.triggerItemId ?? null,
            replaces_invocation_id: params.replacesInvocationId ?? null,
          },
          correlationId: params.correlationId ?? undefined,
        });
      }
    }
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, invocationId));
    if (!invocation) throw new Error(`Invocation 创建后回查失败: ${invocationId}`);
    return { invocation, event };
  });
  return result;
}

export async function getInvocationById(
  tenantId: string,
  invocationId: string,
  tx?: DbOrTx,
): Promise<Invocation | null> {
  const [row] = await (tx ?? db)
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .limit(1);
  return row ?? null;
}

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

export interface UpdateInvocationStateOptions {
  startedAt?: Date | null;
  finishedAt?: Date | null;
  errorCode?: string | null;
  errorSummary?: string | null;
  outputItemId?: string | null;
  resultRef?: string | null;
  resultDigest?: string | null;
}

export async function updateInvocationState(
  tx: Tx,
  tenantId: string,
  invocationId: string,
  newState: InvocationExecutionState,
  options: UpdateInvocationStateOptions = {},
): Promise<Invocation> {
  const [current] = await tx
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .for("update")
    .limit(1);
  if (!current) throw new InvocationNotFoundError(invocationId);
  if (!allowedTransitions[current.executionState].includes(newState)) {
    throw new InvocationStateConflictError(invocationId, current.executionState, `→ ${newState}`);
  }
  const terminal = INVOCATION_TERMINAL_STATES.includes(newState);
  await tx
    .update(invocationTable)
    .set({
      executionState: newState,
      startedAt:
        newState === "running"
          ? (options.startedAt ?? current.startedAt ?? new Date())
          : options.startedAt,
      finishedAt: terminal ? (options.finishedAt ?? new Date()) : options.finishedAt,
      errorCode: options.errorCode,
      errorSummary: options.errorSummary,
      outputItemId: options.outputItemId,
      resultRef: options.resultRef,
      resultDigest: options.resultDigest,
      versionNo: current.versionNo + 1,
      updatedAt: new Date(),
    })
    .where(eq(invocationTable.id, invocationId));
  const [updated] = await tx
    .select()
    .from(invocationTable)
    .where(eq(invocationTable.id, invocationId));
  if (!updated) throw new Error(`Invocation 更新后回查失败: ${invocationId}`);
  return updated;
}

export async function setInvocationOutputItem(
  tx: Tx,
  tenantId: string,
  invocationId: string,
  outputItemId: string,
): Promise<Invocation> {
  const [current] = await tx
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .for("update")
    .limit(1);
  if (!current) throw new InvocationNotFoundError(invocationId);
  if (INVOCATION_TERMINAL_STATES.includes(current.executionState)) {
    throw new InvocationStateConflictError(
      invocationId,
      current.executionState,
      "设置 outputItemId",
    );
  }
  await tx
    .update(invocationTable)
    .set({ outputItemId, versionNo: current.versionNo + 1, updatedAt: new Date() })
    .where(eq(invocationTable.id, invocationId));
  const [updated] = await tx
    .select()
    .from(invocationTable)
    .where(eq(invocationTable.id, invocationId));
  if (!updated) throw new Error(`Invocation 输出更新后回查失败: ${invocationId}`);
  return updated;
}

export async function getThreadIdByTurn(tenantId: string, turnId: string): Promise<string | null> {
  const [row] = await db
    .select({ threadId: turnTable.threadId })
    .from(turnTable)
    .innerJoin(threadTable, eq(threadTable.id, turnTable.threadId))
    .where(and(eq(turnTable.id, turnId), eq(threadTable.tenantId, tenantId)))
    .limit(1);
  return row?.threadId ?? null;
}

export async function listInvocationsByThread(
  tenantId: string,
  threadId: string,
): Promise<Invocation[]> {
  return db
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.threadId, threadId)))
    .orderBy(asc(invocationTable.invocationSequence));
}

export async function markBoundTurnRunning(tenantId: string, turnId: string): Promise<void> {
  await db
    .update(turnTable)
    .set({ turnState: "running" })
    .where(
      and(
        eq(turnTable.id, turnId),
        sql`EXISTS (SELECT 1 FROM Thread WHERE Thread.id = ${turnTable.threadId} AND Thread.tenantId = ${tenantId})`,
      ),
    );
}
