import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { beginEnvironmentLeaseReprepareInTransaction } from "@/lib/environment/environment-lease-store";
import { ExecutionAuthorityError } from "@/lib/executions/domain/execution-authority";
import {
  type ExecutionSourceRequest,
  type ExecutionSourceSnapshot,
  assertExecutionSourceSnapshot,
  executionSourceDigest,
  executionSourceRequestOf,
  sameExecutionSourceRequest,
} from "@/lib/executions/domain/preparation-source";
import {
  type AttemptPreparationClaim,
  claimAttemptPreparationInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { lockInvocationRootIfExists } from "@/lib/executions/persistence/execution-ownership-store";
import { getAuthorityDatabaseTime } from "@/lib/executions/persistence/execution-ownership-store";
import {
  executionOwnershipTable,
  invocationAttemptTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { and, desc, eq } from "drizzle-orm";

export type ExecutionPreparationDecision =
  | {
      disposition: "claimed";
      stage: "prepare" | "register_execution" | "activate";
      claim: AttemptPreparationClaim;
      source: ExecutionSourceSnapshot;
    }
  | { disposition: "busy" }
  | {
      disposition: "dispatch";
      source: ExecutionSourceSnapshot;
      sessionBindingId: string;
      ownershipId: string;
    }
  | {
      disposition: "receipt";
      source: ExecutionSourceSnapshot;
      sessionBindingId: string;
      ownershipId: string;
    };

/**
 * 准备/激活的唯一写边界（TX-A）：在 Invocation 根锁下同时裁决历史来源、
 * 冻结快照、取得有限期 claim，并可选地把同一 Lease 切换到该恢复水位。
 */
export async function acceptExecutionPreparation(input: {
  request: ExecutionSourceRequest;
  claimId?: string;
  environmentReprepare?: {
    leaseId: string;
    recoveryAnchorDigest: string | null;
  };
  now?: Date;
}): Promise<ExecutionPreparationDecision> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx): Promise<ExecutionPreparationDecision> => {
    const invocation = await lockInvocationRootIfExists(
      tx,
      input.request.tenantId,
      input.request.invocationId,
    );
    if (!invocation) throw new ExecutionAuthorityError("NotCurrentExecutor", "Invocation 不存在");
    const [attempt] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.tenantId, input.request.tenantId),
          eq(invocationAttemptTable.invocationId, input.request.invocationId),
          eq(invocationAttemptTable.id, input.request.attemptId),
        ),
      )
      .for("update")
      .limit(1);
    if (!attempt) throw new ExecutionAuthorityError("AttemptMismatch", "Attempt 不属于 Invocation");

    // I → A 后按 O → S 锁序读出全部代际。来源历史不按 latest Attempt 猜测。
    const ownerships = await tx
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.request.tenantId),
          eq(executionOwnershipTable.invocationId, input.request.invocationId),
        ),
      )
      .orderBy(desc(executionOwnershipTable.leaseEpoch))
      .for("update");
    const sessions = await tx
      .select()
      .from(runtimeSessionBindingTable)
      .where(
        and(
          eq(runtimeSessionBindingTable.tenantId, input.request.tenantId),
          eq(runtimeSessionBindingTable.invocationId, input.request.invocationId),
        ),
      )
      .orderBy(desc(runtimeSessionBindingTable.createdAt))
      .for("update");
    if (attempt.attemptState === "suspended" && input.request.intentType !== "resume") {
      throw new ExecutionAuthorityError(
        "NotCurrentExecutor",
        "已暂停 Attempt 只能由持久 Resume 来源继续",
      );
    }
    const sourceSession = sessions.find(
      (session) =>
        session.attemptId === input.request.attemptId &&
        session.intentType === input.request.intentType &&
        session.sourceOperationKey === input.request.sourceOperationKey,
    );
    if (sourceSession) {
      const source = assertExecutionSourceSnapshot(sourceSession.sourceRequestJson);
      if (
        sourceSession.sourceRequestDigest !== executionSourceDigest(source) ||
        !sameExecutionSourceRequest(executionSourceRequestOf(source), input.request)
      ) {
        throw new Error("StartIntentConflict");
      }
      const owner = ownerships.find((candidate) => candidate.id === sourceSession.ownershipId);
      if (!owner) throw new Error("RuntimeSessionMismatch");
      const databaseNow = await getAuthorityDatabaseTime(tx);
      if (owner.ownershipState === "active" && owner.leaseExpiresAt <= databaseNow) {
        throw new ExecutionAuthorityError(
          "AttemptMismatch",
          "原执行权已过期；必须由恢复权威建立新 Attempt",
        );
      }
      if (
        sourceSession.bindingState === "closed" ||
        sourceSession.bindingState === "lost" ||
        owner.ownershipState !== "active"
      ) {
        return {
          disposition: "receipt",
          source,
          sessionBindingId: sourceSession.id,
          ownershipId: owner.id,
        };
      }
      if (owner.executionPhase === "executing" || sourceSession.bindingState === "active") {
        return {
          disposition: "receipt",
          source,
          sessionBindingId: sourceSession.id,
          ownershipId: owner.id,
        };
      }
      if (owner.executionPhase !== "activating") {
        return {
          disposition: "dispatch",
          source,
          sessionBindingId: sourceSession.id,
          ownershipId: owner.id,
        };
      }
      const claimed = await claimAttemptPreparationInTransaction(tx, {
        source,
        claimId: input.claimId ?? randomUUID(),
        now,
      });
      if (!claimed.claim) return { disposition: "busy" };
      return { disposition: "claimed", stage: "activate", claim: claimed.claim, source };
    }

    let source: ExecutionSourceSnapshot;
    if (
      attempt.preparationIntentKey === input.request.sourceOperationKey &&
      attempt.preparationSourceJson !== null
    ) {
      source = assertExecutionSourceSnapshot(attempt.preparationSourceJson);
      if (
        attempt.preparationRequestDigest !== executionSourceDigest(source) ||
        !sameExecutionSourceRequest(executionSourceRequestOf(source), input.request)
      ) {
        throw new Error("StartIntentConflict");
      }
    } else {
      if (
        attempt.preparationIntentKey !== null &&
        attempt.preparationIntentKey !== input.request.sourceOperationKey &&
        attempt.attemptState !== "suspended" &&
        !sessions.some((session) => session.sourceOperationKey === attempt.preparationIntentKey)
      ) {
        throw new ExecutionAuthorityError(
          "NotCurrentExecutor",
          "原准备来源尚未登记 Session，不得被另一来源覆盖",
        );
      }
      const predecessorOwner = ownerships[0] ?? null;
      const predecessorSession = predecessorOwner
        ? (sessions.find((session) => session.ownershipId === predecessorOwner.id) ?? null)
        : null;
      source = {
        ...input.request,
        predecessor:
          predecessorOwner && predecessorSession
            ? {
                attemptId: predecessorOwner.attemptId,
                ownershipId: predecessorOwner.id,
                leaseEpoch: String(predecessorOwner.leaseEpoch),
                sessionBindingId: predecessorSession.id,
              }
            : null,
      };
    }
    const samePersistedSource =
      attempt.preparationIntentKey === source.sourceOperationKey &&
      attempt.preparationRequestDigest === executionSourceDigest(source);
    const claimed = await claimAttemptPreparationInTransaction(tx, {
      source,
      claimId: input.claimId ?? randomUUID(),
      now,
    });
    if (!claimed.claim) return { disposition: "busy" };

    if (input.environmentReprepare && !samePersistedSource) {
      await beginEnvironmentLeaseReprepareInTransaction(tx, {
        preparationClaim: claimed.claim,
        leaseId: input.environmentReprepare.leaseId,
        recoveryAnchorDigest: input.environmentReprepare.recoveryAnchorDigest,
        now,
      });
    }
    return {
      disposition: "claimed",
      stage: claimed.attempt.preparationState === "prepared" ? "register_execution" : "prepare",
      claim: claimed.claim,
      source,
    };
  });
}
