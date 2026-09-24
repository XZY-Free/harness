import { db } from "@/lib/db/client";
import { registerEnvironmentLeaseCleanupForAttemptInTransaction } from "@/lib/environment/environment-lease-store";
import {
  type AttemptPreparationClaim,
  assertAttemptPreparationClaimHeldInTransaction,
  createAttemptInternal,
  updateAttemptState,
} from "@/lib/executions/persistence/attempt-store";
import { lockInvocationRootIfExists } from "@/lib/executions/persistence/execution-ownership-store";
import {
  INVOCATION_TERMINAL_STATES,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { InvocationAttemptStateConflictError } from "@/lib/runtime/errors";
import { DISPATCH_STUCK_GRACE_MS } from "@/lib/runtime/retry/dispatch-retry-queries";
import { and, asc, eq } from "drizzle-orm";

const RETRY_REASON = "environment_provision_retry";
const MAX_PROVISION_ATTEMPTS = 3;

/** 后端实例化失败后，在原准备身份下留下唯一、到期可领取的同 Revision 新 Attempt。 */
export async function scheduleEnvironmentProvisionRetry(input: {
  claim: AttemptPreparationClaim;
  errorSummary: string;
  now: Date;
}): Promise<
  | { status: "scheduled"; successorAttemptId: string; nextPreparationAt: Date }
  | { status: "exhausted" }
  | { status: "superseded" }
> {
  return db.transaction(async (tx) => {
    const invocation = await lockInvocationRootIfExists(
      tx,
      input.claim.tenantId,
      input.claim.invocationId,
    );
    if (
      !invocation ||
      INVOCATION_TERMINAL_STATES.includes(invocation.executionState) ||
      invocation.executionState !== "queued"
    ) {
      return { status: "superseded" };
    }
    const attempt = await assertAttemptPreparationClaimHeldInTransaction(tx, input.claim).catch(
      (error: unknown) => {
        if (
          error instanceof InvocationAttemptStateConflictError &&
          error.attemptedAction === "PreparationClaimSuperseded"
        ) {
          return null;
        }
        throw error;
      },
    );
    if (!attempt) return { status: "superseded" };
    if (attempt.attemptState !== "queued") return { status: "superseded" };
    const [owner] = await tx
      .select({ id: executionOwnershipTable.id })
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.invocationId, invocation.id),
          eq(executionOwnershipTable.ownershipState, "active"),
        ),
      )
      .limit(1);
    const [session] = await tx
      .select({ id: runtimeSessionBindingTable.id })
      .from(runtimeSessionBindingTable)
      .where(eq(runtimeSessionBindingTable.invocationId, invocation.id))
      .limit(1);
    if (owner || session) return { status: "superseded" };
    const attempts = await tx
      .select({
        id: invocationAttemptTable.id,
        retryReasonCode: invocationAttemptTable.retryReasonCode,
      })
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.invocationId, invocation.id))
      .orderBy(asc(invocationAttemptTable.attemptNo))
      .for("update");
    if (attempts.at(-1)?.id !== attempt.id) return { status: "superseded" };
    let round = 1;
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      if (attempts[index]?.retryReasonCode !== RETRY_REASON) break;
      round += 1;
    }
    if (round >= MAX_PROVISION_ATTEMPTS) return { status: "exhausted" };

    await updateAttemptState(tx, attempt.id, "failed", {
      preparationState: "failed",
      finishedAt: input.now,
      errorCode: "EnvironmentInstanceUnavailable",
      errorSummary: input.errorSummary,
    });
    await registerEnvironmentLeaseCleanupForAttemptInTransaction(tx, {
      tenantId: input.claim.tenantId,
      invocationId: invocation.id,
      attemptId: attempt.id,
      errorCode: "EnvironmentInstanceUnavailable",
      now: input.now,
    });
    const successor = await createAttemptInternal(tx, {
      tenantId: input.claim.tenantId,
      invocationId: invocation.id,
      retryReasonCode: RETRY_REASON,
    });
    const nextPreparationAt = new Date(input.now.getTime() + DISPATCH_STUCK_GRACE_MS);
    await tx
      .update(invocationAttemptTable)
      .set({ nextPreparationAt })
      .where(eq(invocationAttemptTable.id, successor.id));
    await tx
      .update(invocationTable)
      .set({ updatedAt: input.now, versionNo: invocation.versionNo + 1 })
      .where(eq(invocationTable.id, invocation.id));
    return { status: "scheduled", successorAttemptId: successor.id, nextPreparationAt };
  });
}
