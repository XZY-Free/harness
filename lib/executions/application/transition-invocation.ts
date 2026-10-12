import type { db } from "@/lib/db/client";
import { bridgeInvocationTerminalToJob } from "@/lib/job/job-terminal-bridge";
import {
  INVOCATION_TERMINAL_STATES,
  type Invocation,
  type InvocationExecutionState,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { InvocationNotFoundError, InvocationStateConflictError } from "@/lib/runtime/errors";
import { and, eq } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const terminalStates = new Set<InvocationExecutionState>(INVOCATION_TERMINAL_STATES);

/** The only application path that commits an Invocation terminal state. */
export async function transitionInvocation(
  tx: Tx,
  input: {
    tenantId: string;
    invocationId: string;
    nextState: Extract<InvocationExecutionState, "completed" | "failed" | "cancelled" | "lost">;
    resultRef?: string | null;
    resultDigest?: string | null;
    errorCode?: string | null;
    errorSummary?: string | null;
    now?: Date;
  },
): Promise<Invocation> {
  const [current] = await tx
    .select()
    .from(invocationTable)
    .where(
      and(eq(invocationTable.tenantId, input.tenantId), eq(invocationTable.id, input.invocationId)),
    )
    .for("update")
    .limit(1);
  if (!current) throw new InvocationNotFoundError(input.invocationId);
  if (terminalStates.has(current.executionState)) {
    if (current.executionState === input.nextState) return current;
    throw new InvocationStateConflictError(
      input.invocationId,
      current.executionState,
      `→ ${input.nextState}`,
    );
  }
  const now = input.now ?? new Date();
  await tx
    .update(invocationTable)
    .set({
      executionState: input.nextState,
      resultRef: input.resultRef ?? current.resultRef,
      resultDigest: input.resultDigest ?? current.resultDigest,
      errorCode: input.errorCode ?? current.errorCode,
      errorSummary: input.errorSummary ?? current.errorSummary,
      finishedAt: now,
      versionNo: current.versionNo + 1,
      updatedAt: now,
    })
    .where(eq(invocationTable.id, input.invocationId));
  const [updated] = await tx
    .select()
    .from(invocationTable)
    .where(eq(invocationTable.id, input.invocationId))
    .limit(1);
  if (!updated) throw new InvocationNotFoundError(input.invocationId);
  await bridgeInvocationTerminalToJob(tx, updated, now);
  return updated;
}
