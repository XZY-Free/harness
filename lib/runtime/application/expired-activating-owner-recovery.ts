import { db } from "@/lib/db/client";
import {
  type ExecutionSourceSnapshot,
  assertExecutionSourceSnapshot,
  executionSourceDigest,
} from "@/lib/executions/domain/preparation-source";
import { createAttemptInternal } from "@/lib/executions/persistence/attempt-store";
import {
  getAuthorityDatabaseTime,
  lockInvocationRootIfExists,
} from "@/lib/executions/persistence/execution-ownership-store";
import {
  executionOwnershipTable,
  invocationAttemptTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { acceptExecutionPreparation } from "@/lib/runtime/application/execution-preparation";
import type { StaleInvocationSummary } from "@/lib/runtime/application/runtime-recovery";
import { executionSourceRequestForStart } from "@/lib/runtime/application/runtime-start";
import { buildGatewayEndpoints } from "@/lib/runtime/gateway-endpoints";
import {
  dispatchQueuedInvocationAttempt,
  failAttemptAndInvokeRecoveryAuthority,
} from "@/lib/runtime/retry/dispatch-queued-invocation-attempt";
import {
  requireExecutionBinding,
  resolveBoundExecutionResources,
  resolveRuntimeTransportFromBinding,
} from "@/lib/runtime/retry/runtime-transport-from-binding";
import { and, eq } from "drizzle-orm";

class StaleActivatingOwnerObservation extends Error {}

type RecoveryClaim =
  | { kind: "not_applicable" }
  | {
      kind: "claimed";
      invocation: NonNullable<Awaited<ReturnType<typeof lockInvocationRootIfExists>>>;
      attempt: typeof invocationAttemptTable.$inferSelect;
      source: ExecutionSourceSnapshot;
    };

/**
 * 尚未向 Runtime 发出 Start/Resume 的 activating Owner 失效时，重建一份基础设施 Attempt。
 * 原 O/S 的失权、旧资源清理由后续 Acquire 在同一根锁事务中处理；这里绝不续旧 epoch。
 */
export async function recoverExpiredActivatingOwner(
  candidate: StaleInvocationSummary,
): Promise<"not_applicable" | "stale" | "recovered"> {
  const observedOwner = candidate.observedOwner;
  if (!observedOwner) return "not_applicable";
  const retryReasonCode = `owner_expired:${observedOwner.ownershipId}`;
  const sourceOperationKey = `owner-expired:${observedOwner.ownershipId}`;
  let claim: RecoveryClaim;
  try {
    claim = await db.transaction(async (tx): Promise<RecoveryClaim> => {
      const invocation = await lockInvocationRootIfExists(
        tx,
        candidate.tenantId,
        candidate.invocationId,
      );
      if (!invocation || !["queued", "running", "waiting_user"].includes(invocation.executionState))
        throw new StaleActivatingOwnerObservation();
      const [observed] = await tx
        .select()
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, candidate.tenantId),
            eq(executionOwnershipTable.id, observedOwner.ownershipId),
          ),
        )
        .limit(1);
      if (!observed || observed.executionPhase !== "activating")
        return { kind: "not_applicable" as const };
      // 固定锁图 I→A→O→S：新 Attempt 在 O/S 行锁前创建。观察若已变化则整事务回滚。
      const attempts = await tx
        .select()
        .from(invocationAttemptTable)
        .where(eq(invocationAttemptTable.invocationId, candidate.invocationId))
        .for("update");
      const existing = attempts.find((row) => row.retryReasonCode === retryReasonCode);
      if (existing && existing.attemptState !== "queued")
        return { kind: "not_applicable" as const };
      const attempt =
        existing ??
        (await createAttemptInternal(tx, {
          tenantId: candidate.tenantId,
          invocationId: candidate.invocationId,
          retryReasonCode,
        }));
      const [owner] = await tx
        .select()
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, candidate.tenantId),
            eq(executionOwnershipTable.id, observedOwner.ownershipId),
            eq(executionOwnershipTable.ownershipState, "active"),
          ),
        )
        .for("update")
        .limit(1);
      const now = await getAuthorityDatabaseTime(tx);
      if (
        !owner ||
        owner.invocationId !== candidate.invocationId ||
        owner.executionPhase !== "activating" ||
        owner.attemptId !== observedOwner.attemptId ||
        owner.leaseEpoch !== observedOwner.leaseEpoch ||
        owner.leaseExpiresAt.getTime() !== observedOwner.leaseExpiresAt.getTime() ||
        owner.lastHeartbeatAt.getTime() !== observedOwner.lastHeartbeatAt.getTime() ||
        owner.leaseExpiresAt > now
      ) {
        throw new StaleActivatingOwnerObservation();
      }
      const [session] = await tx
        .select()
        .from(runtimeSessionBindingTable)
        .where(
          and(
            eq(runtimeSessionBindingTable.tenantId, candidate.tenantId),
            eq(runtimeSessionBindingTable.ownershipId, owner.id),
          ),
        )
        .for("update")
        .limit(1);
      if (!session || session.id !== candidate.sessionBindingId)
        throw new StaleActivatingOwnerObservation();
      const source = assertExecutionSourceSnapshot(session.sourceRequestJson);
      if (executionSourceDigest(source) !== session.sourceRequestDigest)
        throw new Error("StartIntentConflict");
      return { kind: "claimed" as const, invocation, attempt, source };
    });
  } catch (error) {
    if (error instanceof StaleActivatingOwnerObservation) return "stale";
    throw error;
  }
  if (claim.kind === "not_applicable") return "not_applicable";
  const binding = await requireExecutionBinding(candidate.tenantId, candidate.invocationId);
  const recovery =
    claim.source.recovery.kind === "resume"
      ? {
          kind: "resume" as const,
          anchor: claim.source.recovery.anchor,
          anchorDigest: claim.source.recovery.anchorDigest,
          ...(claim.source.recovery.checkpointId
            ? { checkpointId: claim.source.recovery.checkpointId }
            : {}),
        }
      : undefined;
  const preparation = await acceptExecutionPreparation({
    request: executionSourceRequestForStart({
      tenantId: candidate.tenantId,
      invocation: claim.invocation,
      binding,
      attempt: claim.attempt,
      sourceOperationKey,
      intentType: claim.source.intentType,
      recovery,
    }),
  });
  if (preparation.disposition === "busy") return "recovered";
  if (preparation.disposition !== "claimed") return "stale";
  let transport: Awaited<ReturnType<typeof resolveRuntimeTransportFromBinding>>;
  let resources: Awaited<ReturnType<typeof resolveBoundExecutionResources>>;
  try {
    transport = await resolveRuntimeTransportFromBinding({
      tenantId: candidate.tenantId,
      binding,
    });
    resources = await resolveBoundExecutionResources({
      tenantId: candidate.tenantId,
      binding,
      purpose: claim.invocation.subjectType === "job" ? "job" : "thread",
    });
  } catch (error) {
    await failAttemptAndInvokeRecoveryAuthority({
      tenantId: candidate.tenantId,
      attempt: claim.attempt,
      invocation: claim.invocation,
      errorCode: error instanceof Error ? error.name : "RuntimeDispatchFailed",
      errorSummary: error instanceof Error ? error.message : String(error),
      now: new Date(),
      workIdentity: { kind: "preparation", claim: preparation.claim },
    });
    return "recovered";
  }
  await dispatchQueuedInvocationAttempt({
    tenantId: candidate.tenantId,
    attemptId: claim.attempt.id,
    claim: null,
    preparationClaim: preparation.claim,
    runtimeClient: transport.runtimeClient,
    runtimeEndpointResolver: async () => ({
      runtimeEndpoint: transport.runtimeEndpoint,
      auth: transport.auth,
      callbackEndpoints: buildGatewayEndpoints({
        external: !transport.hosted,
        invocationId: candidate.invocationId,
      }),
      ...resources,
    }),
    correlationId: sourceOperationKey,
  });
  return "recovered";
}
