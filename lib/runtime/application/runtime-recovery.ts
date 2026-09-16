import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { transitionInvocation } from "@/lib/executions/application/transition-invocation";
import { threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import type { ThreadEvent, ThreadEventActorType } from "@/lib/persistence/schema/conversation";
import {
  type InvocationExecutionState,
  type RuntimeSessionBinding,
  executionOwnershipTable,
  invocationTable,
  runtimeEventIngressTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { InvocationAlreadyTerminalError, InvocationNotFoundError } from "@/lib/runtime/errors";
import { markSessionBindingLostInSession } from "@/lib/runtime/recovery-queries";
/** Durable recovery of an Invocation whose current ExecutionOwnership expired. */
import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const recoverableStates: readonly InvocationExecutionState[] = [
  "queued",
  "running",
  "waiting_user",
];
const terminalTurnStates = new Set(["completed", "failed", "cancelled", "interrupted"]);

export interface FindStaleInvocationsParams {
  tenantId: string;
  thresholdMs: number;
  now?: Date;
  limit?: number;
}

export interface StaleInvocationSummary {
  invocationId: string;
  tenantId: string;
  threadId: string | null;
  turnId: string | null;
  jobId: string | null;
  executionState: InvocationExecutionState;
  lastHeartbeatAt: Date | null;
  ownershipId: string | null;
  sessionBindingId: string | null;
}

export async function findStaleInvocations(
  input: FindStaleInvocationsParams,
): Promise<StaleInvocationSummary[]> {
  const now = input.now ?? new Date();
  const threshold = new Date(now.getTime() - input.thresholdMs);
  const rows = await db
    .select({
      invocationId: invocationTable.id,
      tenantId: invocationTable.tenantId,
      threadId: invocationTable.threadId,
      turnId: invocationTable.turnId,
      jobId: invocationTable.jobId,
      executionState: invocationTable.executionState,
      ownershipId: executionOwnershipTable.id,
      lastHeartbeatAt: executionOwnershipTable.lastHeartbeatAt,
      sessionBindingId: runtimeSessionBindingTable.id,
    })
    .from(invocationTable)
    .innerJoin(
      executionOwnershipTable,
      and(
        eq(executionOwnershipTable.invocationId, invocationTable.id),
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    )
    .leftJoin(
      runtimeSessionBindingTable,
      and(
        eq(runtimeSessionBindingTable.ownershipId, executionOwnershipTable.id),
        eq(runtimeSessionBindingTable.tenantId, input.tenantId),
      ),
    )
    .where(
      and(
        eq(invocationTable.tenantId, input.tenantId),
        inArray(invocationTable.executionState, [...recoverableStates]),
        isNotNull(executionOwnershipTable.lastHeartbeatAt),
        lt(executionOwnershipTable.lastHeartbeatAt, threshold),
      ),
    )
    .orderBy(asc(executionOwnershipTable.lastHeartbeatAt))
    .limit(Math.min(input.limit ?? 100, 500));
  return rows;
}

export interface MarkInvocationLostParams {
  tenantId: string;
  invocationId: string;
  reasonCode: string;
  errorSummary?: string | null;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
  idempotencyKey?: string | null;
}

export interface MarkInvocationLostResult {
  invocation: Awaited<ReturnType<typeof transitionInvocation>>;
  invocationLostEvent: ThreadEvent | null;
  turnFailedEvent: ThreadEvent | null;
  sessionBinding: RuntimeSessionBinding | null;
}

/** Close the expired authority and Invocation atomically; never infer success. */
export async function markInvocationLost(
  input: MarkInvocationLostParams,
): Promise<MarkInvocationLostResult> {
  const actorType = input.actorType ?? "system";
  const errorSummary = input.errorSummary ?? `Invocation 失联：${input.reasonCode}`;
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) throw new InvocationNotFoundError(input.invocationId);
    if (!recoverableStates.includes(current.executionState)) {
      throw new InvocationAlreadyTerminalError(
        input.invocationId,
        current.executionState,
        "mark_lost",
      );
    }

    const [owner] = await tx
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.invocationId, current.id),
          eq(executionOwnershipTable.ownershipState, "active"),
        ),
      )
      .for("update")
      .limit(1);
    const now = new Date();
    let sessionBinding: RuntimeSessionBinding | null = null;
    if (owner) {
      await tx
        .update(executionOwnershipTable)
        .set({
          ownershipState: "lost",
          releasedAt: now,
          reasonCode: input.reasonCode,
          versionNo: owner.versionNo + 1,
          updatedAt: now,
        })
        .where(eq(executionOwnershipTable.id, owner.id));
      sessionBinding = await markSessionBindingLostInSession(tx, {
        tenantId: input.tenantId,
        invocationId: current.id,
        ownershipId: owner.id,
      });
    }

    const invocation = await transitionInvocation(tx, {
      tenantId: input.tenantId,
      invocationId: current.id,
      nextState: "lost",
      errorCode: input.reasonCode,
      errorSummary,
      now,
    });

    let turnFailedEvent: ThreadEvent | null = null;
    let invocationLostEvent: ThreadEvent | null = null;
    if (invocation.threadId) {
      const [thread] = await tx
        .select({ id: threadTable.id })
        .from(threadTable)
        .where(eq(threadTable.id, invocation.threadId))
        .for("update")
        .limit(1);
      if (!thread) throw new Error(`Invocation Thread 不存在：${invocation.threadId}`);
      let turnFailed = false;
      if (invocation.turnId) {
        const [turn] = await tx
          .select()
          .from(turnTable)
          .where(eq(turnTable.id, invocation.turnId))
          .for("update")
          .limit(1);
        if (
          turn &&
          turn.activeInvocationId === invocation.id &&
          !terminalTurnStates.has(turn.turnState)
        ) {
          await tx
            .update(turnTable)
            .set({
              turnState: "failed",
              errorCode: input.reasonCode,
              finishedAt: now,
              activeInvocationId: null,
              versionNo: turn.versionNo + 1,
            })
            .where(eq(turnTable.id, turn.id));
          turnFailed = true;
        }
      }
      const sequence = await allocateEventSequences(tx, invocation.threadId, turnFailed ? 2 : 1);
      invocationLostEvent = await insertThreadEvent(tx, invocation.threadId, sequence, {
        eventType: "invocation.lost",
        turnId: invocation.turnId ?? undefined,
        invocationId: invocation.id,
        actorType,
        actorId: input.actorId ?? undefined,
        payload: { reasonCode: input.reasonCode, errorSummary, ownershipId: owner?.id ?? null },
        correlationId: input.correlationId ?? undefined,
        idempotencyKey: input.idempotencyKey ?? undefined,
      });
      if (turnFailed) {
        turnFailedEvent = await insertThreadEvent(tx, invocation.threadId, sequence + 1, {
          eventType: "turn.failed",
          turnId: invocation.turnId ?? undefined,
          invocationId: invocation.id,
          actorType,
          actorId: input.actorId ?? undefined,
          payload: { reasonCode: input.reasonCode, errorSummary },
          correlationId: input.correlationId ?? undefined,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:turn` : undefined,
        });
      }
    }
    return { invocation, invocationLostEvent, turnFailedEvent, sessionBinding };
  });
}

export async function getLatestProducerSequence(
  tenantId: string,
  invocationId: string,
): Promise<number | null> {
  const [invocation] = await db
    .select({ id: invocationTable.id })
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .limit(1);
  if (!invocation) return null;
  const [row] = await db
    .select({ maxSeq: sql<number>`COALESCE(MAX(${runtimeEventIngressTable.producerSequence}), 0)` })
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, tenantId),
        eq(runtimeEventIngressTable.invocationId, invocationId),
      ),
    );
  return row?.maxSeq ?? 0;
}

export type { Tx };
