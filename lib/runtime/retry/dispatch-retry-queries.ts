/** Durable dispatch retry state.
 *
 * Attempt preparation is an execution fact. Dispatch retry state belongs to
 * RuntimeSessionBinding (the stable start/resume intent), while control
 * command retry state belongs to InvocationCommand.
 */
import { db } from "@/lib/db/client";
import type { InvocationAttempt, InvocationCommand } from "@/lib/persistence/schema/executions";
import {
  invocationAttemptTable,
  invocationCommandTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import {
  type TransientDispatchErrorCode,
  backoffDelayMs,
  isRetryExhausted,
} from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function claimDueInvocationAttempts(params: {
  now: Date;
  leaseOwner: string;
  leaseDurationMs: number;
  limit: number;
}): Promise<InvocationAttempt[]> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ attempt: invocationAttemptTable, session: runtimeSessionBindingTable })
      .from(invocationAttemptTable)
      .innerJoin(
        runtimeSessionBindingTable,
        and(
          eq(runtimeSessionBindingTable.attemptId, invocationAttemptTable.id),
          eq(runtimeSessionBindingTable.bindingState, "dispatching"),
        ),
      )
      .where(
        and(
          eq(invocationAttemptTable.attemptState, "queued"),
          isNotNull(runtimeSessionBindingTable.nextDispatchAt),
          lte(runtimeSessionBindingTable.nextDispatchAt, params.now),
          or(
            isNull(runtimeSessionBindingTable.dispatchLeaseExpiresAt),
            lte(runtimeSessionBindingTable.dispatchLeaseExpiresAt, params.now),
          ),
        ),
      )
      .orderBy(asc(runtimeSessionBindingTable.nextDispatchAt))
      .limit(params.limit)
      .for("update", { skipLocked: true });
    const leaseExpiresAt = new Date(params.now.getTime() + params.leaseDurationMs);
    const claimed: InvocationAttempt[] = [];
    for (const candidate of candidates) {
      await tx
        .update(runtimeSessionBindingTable)
        .set({
          dispatchLeaseOwner: params.leaseOwner,
          dispatchLeaseExpiresAt: leaseExpiresAt,
          updatedAt: params.now,
          versionNo: candidate.session.versionNo + 1,
        })
        .where(eq(runtimeSessionBindingTable.id, candidate.session.id));
      claimed.push(candidate.attempt);
    }
    return claimed;
  });
}

/** Count a dispatch attempt on the stable session intent before transport. */
export async function recordAttemptDispatchAttemptStarted(params: {
  sessionBindingId: string;
  now: Date;
}): Promise<InvocationAttempt> {
  const [current] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(eq(runtimeSessionBindingTable.id, params.sessionBindingId))
    .limit(1);
  if (!current) throw new Error(`RuntimeSessionBinding 不存在（id=${params.sessionBindingId}）`);
  await db
    .update(runtimeSessionBindingTable)
    .set({
      dispatchCount: sql`${runtimeSessionBindingTable.dispatchCount} + 1`,
      lastDispatchAt: params.now,
      updatedAt: params.now,
      versionNo: current.versionNo + 1,
    })
    .where(eq(runtimeSessionBindingTable.id, current.id));
  const [attempt] = await db
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, current.attemptId))
    .limit(1);
  if (!attempt) throw new Error(`InvocationAttempt 不存在（id=${current.attemptId}）`);
  return attempt;
}

export async function claimDueInvocationCommands(params: {
  now: Date;
  leaseOwner: string;
  leaseDurationMs: number;
  limit: number;
}): Promise<InvocationCommand[]> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.commandState, "dispatched"),
          or(
            isNull(invocationCommandTable.dispatchLeaseExpiresAt),
            lte(invocationCommandTable.dispatchLeaseExpiresAt, params.now),
          ),
          or(
            and(
              isNotNull(invocationCommandTable.nextDispatchAt),
              lte(invocationCommandTable.nextDispatchAt, params.now),
            ),
            and(
              isNotNull(invocationCommandTable.dispatchLeaseExpiresAt),
              lte(invocationCommandTable.dispatchLeaseExpiresAt, params.now),
            ),
          ),
        ),
      )
      .orderBy(asc(invocationCommandTable.nextDispatchAt))
      .limit(params.limit)
      .for("update", { skipLocked: true });
    const leaseExpiresAt = new Date(params.now.getTime() + params.leaseDurationMs);
    const claimed: InvocationCommand[] = [];
    for (const candidate of candidates) {
      await tx
        .update(invocationCommandTable)
        .set({
          dispatchLeaseOwner: params.leaseOwner,
          dispatchLeaseExpiresAt: leaseExpiresAt,
          updatedAt: params.now,
          versionNo: candidate.versionNo + 1,
        })
        .where(eq(invocationCommandTable.id, candidate.id));
      claimed.push({
        ...candidate,
        dispatchLeaseOwner: params.leaseOwner,
        dispatchLeaseExpiresAt: leaseExpiresAt,
      });
    }
    return claimed;
  });
}

export type AttemptTransientFailureOutcome =
  | {
      outcome: "scheduled";
      dispatchCount: number;
      nextDispatchAt: Date;
      attempt: InvocationAttempt;
    }
  | { outcome: "exhausted"; dispatchCount: number; attempt: InvocationAttempt };

export async function recordAttemptDispatchTransientFailure(params: {
  attemptId: string;
  errorCode: TransientDispatchErrorCode;
  now: Date;
  retryReasonCode?: string | null;
  counted?: boolean;
}): Promise<AttemptTransientFailureOutcome> {
  return db.transaction(async (tx) => {
    const [currentAttempt] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.id, params.attemptId))
      .for("update")
      .limit(1);
    if (!currentAttempt) throw new Error(`InvocationAttempt 不存在（id=${params.attemptId}）`);
    if (currentAttempt.attemptState !== "queued")
      throw new Error(`Attempt 已非 queued（id=${params.attemptId}）`);
    const [session] = await tx
      .select()
      .from(runtimeSessionBindingTable)
      .where(eq(runtimeSessionBindingTable.attemptId, params.attemptId))
      .for("update")
      .limit(1);
    if (!session) throw new Error(`RuntimeSessionBinding 不存在（attemptId=${params.attemptId}）`);
    const dispatchCount = params.counted ? session.dispatchCount : session.dispatchCount + 1;
    const exhausted = isRetryExhausted(dispatchCount);
    const nextDispatchAt = exhausted
      ? null
      : new Date(params.now.getTime() + backoffDelayMs(dispatchCount));
    await tx
      .update(runtimeSessionBindingTable)
      .set({
        dispatchCount,
        nextDispatchAt,
        lastErrorCode: params.errorCode,
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        updatedAt: params.now,
        versionNo: session.versionNo + 1,
      })
      .where(eq(runtimeSessionBindingTable.id, session.id));
    if (exhausted) {
      await tx
        .update(invocationAttemptTable)
        .set({
          attemptState: "failed",
          finishedAt: params.now,
          errorCode: "dispatch_retry_exhausted",
          errorSummary: `Dispatch retry exhausted after ${dispatchCount} attempts`,
          retryReasonCode: currentAttempt.retryReasonCode ?? params.retryReasonCode ?? null,
          updatedAt: params.now,
          versionNo: currentAttempt.versionNo + 1,
        })
        .where(eq(invocationAttemptTable.id, params.attemptId));
    } else if (currentAttempt.retryReasonCode === null && params.retryReasonCode) {
      await tx
        .update(invocationAttemptTable)
        .set({ retryReasonCode: params.retryReasonCode, updatedAt: params.now })
        .where(eq(invocationAttemptTable.id, params.attemptId));
    }
    const [attempt] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.id, params.attemptId))
      .limit(1);
    if (!attempt) throw new Error(`InvocationAttempt 更新后回查失败（id=${params.attemptId}）`);
    return exhausted
      ? { outcome: "exhausted" as const, dispatchCount, attempt }
      : {
          outcome: "scheduled" as const,
          dispatchCount,
          nextDispatchAt: nextDispatchAt as Date,
          attempt,
        };
  });
}

export type CommandTransientRetryOutcome =
  | {
      outcome: "scheduled";
      dispatchCount: number;
      nextDispatchAt: Date;
      command: InvocationCommand;
    }
  | { outcome: "exhausted"; dispatchCount: number; command: InvocationCommand };

export async function scheduleCommandTransientRetry(params: {
  commandId: string;
  errorCode: TransientDispatchErrorCode;
  now: Date;
}): Promise<CommandTransientRetryOutcome> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, params.commandId))
      .for("update")
      .limit(1);
    if (!current) throw new Error(`InvocationCommand 不存在（id=${params.commandId}）`);
    if (current.commandState !== "dispatched")
      throw new Error(`Command 已非 dispatched（id=${params.commandId}）`);
    const exhausted = isRetryExhausted(current.dispatchCount);
    const nextDispatchAt = exhausted
      ? null
      : new Date(params.now.getTime() + backoffDelayMs(current.dispatchCount));
    await tx
      .update(invocationCommandTable)
      .set({
        commandState: exhausted ? "failed" : "dispatched",
        completedAt: exhausted ? params.now : null,
        lastErrorCode: params.errorCode,
        nextDispatchAt,
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        updatedAt: params.now,
        versionNo: current.versionNo + 1,
      })
      .where(eq(invocationCommandTable.id, params.commandId));
    const [command] = await tx
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, params.commandId))
      .limit(1);
    if (!command) throw new Error(`InvocationCommand 更新后回查失败（id=${params.commandId}）`);
    return exhausted
      ? { outcome: "exhausted" as const, dispatchCount: command.dispatchCount, command }
      : {
          outcome: "scheduled" as const,
          dispatchCount: command.dispatchCount,
          nextDispatchAt: nextDispatchAt as Date,
          command,
        };
  });
}

export async function recordCommandRetryAttemptStarted(params: {
  commandId: string;
  now: Date;
}): Promise<void> {
  const [current] = await db
    .select()
    .from(invocationCommandTable)
    .where(eq(invocationCommandTable.id, params.commandId))
    .limit(1);
  if (!current) throw new Error(`InvocationCommand 不存在（id=${params.commandId}）`);
  await db
    .update(invocationCommandTable)
    .set({
      dispatchCount: sql`${invocationCommandTable.dispatchCount} + 1`,
      lastErrorCode: null,
      updatedAt: params.now,
      versionNo: current.versionNo + 1,
    })
    .where(eq(invocationCommandTable.id, params.commandId));
}

export async function transitionCommandToDispatchedWithLease(params: {
  commandId: string;
  leaseOwner: string;
  now: Date;
  leaseDurationMs: number;
}): Promise<boolean> {
  const leaseExpiresAt = new Date(params.now.getTime() + params.leaseDurationMs);
  const result = await db
    .update(invocationCommandTable)
    .set({
      commandState: "dispatched",
      dispatchCount: 1,
      dispatchLeaseOwner: params.leaseOwner,
      dispatchLeaseExpiresAt: leaseExpiresAt,
      nextDispatchAt: null,
      updatedAt: params.now,
    })
    .where(
      and(
        eq(invocationCommandTable.id, params.commandId),
        eq(invocationCommandTable.commandState, "queued"),
      ),
    );
  return result[0].affectedRows > 0;
}

export async function clearCommandDispatchLease(params: {
  commandId: string;
  now: Date;
}): Promise<void> {
  await db
    .update(invocationCommandTable)
    .set({
      dispatchLeaseOwner: null,
      dispatchLeaseExpiresAt: null,
      nextDispatchAt: null,
      updatedAt: params.now,
    })
    .where(
      and(
        eq(invocationCommandTable.id, params.commandId),
        sql`${invocationCommandTable.commandState} IN ('acknowledged','failed')`,
      ),
    );
}

export type { Tx };
