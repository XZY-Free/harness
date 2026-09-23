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
import {
  getAuthorityDatabaseTime,
  lockInvocationRootIfExists,
} from "@/lib/executions/persistence/execution-ownership-store";
import {
  executionOwnershipTable,
  invocationAttemptTable,
  invocationCommandTable,
  runtimeEventIngressTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { markRuntimeSessionLostByOwnershipInTransaction } from "@/lib/runtime/persistence/runtime-session-store";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
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
  return db.transaction(async (tx): Promise<ExecutionPreparationDecision> => {
    const now = input.now ?? (await getAuthorityDatabaseTime(tx));
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

    let suspensionPredecessor: ExecutionSourceSnapshot["predecessor"] = null;
    if (input.request.sourceKind === "user_resume") {
      if (input.request.recovery.kind !== "resume") {
        throw new ExecutionAuthorityError("NotCurrentExecutor", "Resume 缺少恢复锚点");
      }
      const anchorDigest = input.request.recovery.anchorDigest;
      const databaseNow = await getAuthorityDatabaseTime(tx);
      if (
        attempt.attemptState !== "suspended" ||
        (attempt.resumeAnchorDigest !== null && attempt.resumeAnchorDigest !== anchorDigest)
      ) {
        throw new ExecutionAuthorityError("NotCurrentExecutor", "Resume 来源与当前暂停前驱不匹配");
      }
      const commandId = input.request.sourceOperationKey.startsWith("command:")
        ? input.request.sourceOperationKey.slice("command:".length)
        : "";
      const [command] = commandId
        ? await tx
            .select()
            .from(invocationCommandTable)
            .where(
              and(
                eq(invocationCommandTable.tenantId, input.request.tenantId),
                eq(invocationCommandTable.invocationId, input.request.invocationId),
                eq(invocationCommandTable.id, commandId),
              ),
            )
            .for("update")
            .limit(1)
        : [];
      if (
        !command ||
        command.commandType !== "resume" ||
        !["queued", "dispatched"].includes(command.commandState) ||
        command.payloadDigest !== protocolDigest(command.payloadJson)
      ) {
        throw new ExecutionAuthorityError("NotCurrentExecutor", "Resume 命令不存在或已失效");
      }
      const acceptedPayload = command.payloadJson;
      if (
        acceptedPayload !== null &&
        typeof acceptedPayload === "object" &&
        !Array.isArray(acceptedPayload) &&
        (acceptedPayload as Record<string, unknown>).resume_source === "user_pause"
      ) {
        const acceptedPauseDigest = (acceptedPayload as Record<string, unknown>)
          .pause_source_digest;
        const currentPauseDigest = protocolDigest({
          attemptId: attempt.id,
          recoveryVersion: invocation.recoveryVersion,
          resumeAnchor: attempt.resumeAnchor,
          resumeAnchorDigest: attempt.resumeAnchorDigest,
        });
        if (acceptedPauseDigest !== currentPauseDigest) {
          throw new ExecutionAuthorityError("NotCurrentExecutor", "Resume 命令不属于当前暂停前驱");
        }
      }
      const healthyOwner = ownerships.find(
        (owner) => owner.ownershipState === "active" && owner.leaseExpiresAt > databaseNow,
      );
      if (
        healthyOwner &&
        (command.targetOwnershipId !== healthyOwner.id ||
          !command.targetSessionId ||
          !sessions.some(
            (session) =>
              session.id === command.targetSessionId && session.ownershipId === healthyOwner.id,
          ))
      ) {
        throw new ExecutionAuthorityError("NotCurrentExecutor", "Resume 来源与当前执行权不匹配");
      }
      const payload = command.payloadJson;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const requestId = (payload as Record<string, unknown>).request_id;
        if (requestId !== undefined) {
          const [action] =
            typeof requestId === "string"
              ? await tx
                  .select({ requestState: userActionRequestTable.requestState })
                  .from(userActionRequestTable)
                  .where(
                    and(
                      eq(userActionRequestTable.tenantId, input.request.tenantId),
                      eq(userActionRequestTable.invocationId, input.request.invocationId),
                      eq(userActionRequestTable.id, requestId),
                    ),
                  )
                  .limit(1)
              : [];
          if (action?.requestState !== "resolved") {
            throw new ExecutionAuthorityError("NotCurrentExecutor", "Resume 用户操作尚未完成");
          }
        }
      }
      const suspensionEvents = await tx
        .select()
        .from(runtimeEventIngressTable)
        .where(
          and(
            eq(runtimeEventIngressTable.tenantId, input.request.tenantId),
            eq(runtimeEventIngressTable.invocationId, input.request.invocationId),
            eq(runtimeEventIngressTable.acceptedAttemptId, input.request.attemptId),
            eq(runtimeEventIngressTable.candidateType, "execution.suspended"),
          ),
        )
        .orderBy(desc(runtimeEventIngressTable.producerSequence));
      const suspension = suspensionEvents.find((event) => {
        const eventPayload = event.payloadJson;
        return (
          eventPayload !== null &&
          typeof eventPayload === "object" &&
          !Array.isArray(eventPayload) &&
          (eventPayload as Record<string, unknown>).resumeAnchorDigest === anchorDigest
        );
      });
      const targetSession = sessions.find((session) => session.id === command.targetSessionId);
      if (
        healthyOwner &&
        targetSession?.intentType === "resume" &&
        suspension?.acceptedSessionId !== targetSession.id
      ) {
        throw new ExecutionAuthorityError("NotCurrentExecutor", "当前恢复来源尚未完成新的暂停");
      }
      if (suspension) {
        const owner = ownerships.find((row) => row.id === suspension.acceptedOwnershipId);
        const session = sessions.find((row) => row.id === suspension.acceptedSessionId);
        if (!owner || !session || session.ownershipId !== owner.id) {
          throw new ExecutionAuthorityError("NotCurrentExecutor", "Resume 暂停前驱已失效");
        }
        suspensionPredecessor = {
          attemptId: owner.attemptId,
          ownershipId: owner.id,
          leaseEpoch: String(owner.leaseEpoch),
          sessionBindingId: session.id,
        };
      } else if (healthyOwner && command.targetSessionId) {
        suspensionPredecessor = {
          attemptId: healthyOwner.attemptId,
          ownershipId: healthyOwner.id,
          leaseEpoch: String(healthyOwner.leaseEpoch),
          sessionBindingId: command.targetSessionId,
        };
      }
      if (
        (command.targetOwnershipId &&
          command.targetOwnershipId !== suspensionPredecessor?.ownershipId) ||
        (command.targetSessionId &&
          command.targetSessionId !== suspensionPredecessor?.sessionBindingId)
      ) {
        throw new ExecutionAuthorityError("NotCurrentExecutor", "Resume 命令目标与暂停前驱不匹配");
      }
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
        !sessions.some((session) => session.sourceOperationKey === attempt.preparationIntentKey)
      ) {
        throw new ExecutionAuthorityError(
          "NotCurrentExecutor",
          "原准备来源尚未登记 Session，不得被另一来源覆盖",
        );
      }
      const predecessorOwner =
        input.request.sourceKind === "user_resume" ? null : (ownerships[0] ?? null);
      const predecessorSession = predecessorOwner
        ? (sessions.find((session) => session.ownershipId === predecessorOwner.id) ?? null)
        : null;
      source = {
        ...input.request,
        predecessor:
          suspensionPredecessor ??
          (predecessorOwner && predecessorSession
            ? {
                attemptId: predecessorOwner.attemptId,
                ownershipId: predecessorOwner.id,
                leaseEpoch: String(predecessorOwner.leaseEpoch),
                sessionBindingId: predecessorSession.id,
              }
            : null),
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

    if (input.request.sourceKind === "continuation" && !samePersistedSource) {
      const currentOwner = ownerships.find((row) => row.ownershipState === "active");
      if (currentOwner) {
        const currentSession = sessions.find((row) => row.ownershipId === currentOwner.id);
        if (
          currentOwner.leaseExpiresAt <= now ||
          currentOwner.attemptId !== attempt.id ||
          !currentSession ||
          currentSession.bindingState === "closed" ||
          currentSession.bindingState === "lost"
        ) {
          throw new ExecutionAuthorityError(
            "NotCurrentExecutor",
            "Continuation 的前驱执行权已失效",
          );
        }
        if (currentSession.sourceOperationKey !== source.sourceOperationKey) {
          // External 的子结果要求一次真实 Resume。领取新来源之后、改 Lease 之前，
          // 在同一根锁事务中退休旧 O/S；后续 Start 只会为该来源取得新代际。
          await tx
            .update(executionOwnershipTable)
            .set({
              ownershipState: "released",
              releasedAt: now,
              reasonCode: "continuation_redispatch",
              versionNo: currentOwner.versionNo + 1,
              updatedAt: now,
            })
            .where(eq(executionOwnershipTable.id, currentOwner.id));
          await markRuntimeSessionLostByOwnershipInTransaction(
            tx,
            input.request.tenantId,
            currentOwner.id,
          );
        }
      }
    }

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
