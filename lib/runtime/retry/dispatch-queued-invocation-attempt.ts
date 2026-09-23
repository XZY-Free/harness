/** Dispatches one durable InvocationAttempt using its frozen execution facts. */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { getEnvironmentRevisionById } from "@/lib/environment/environment-definition-store";
import {
  getEnvironmentLeaseByAttempt,
  registerEnvironmentLeaseCleanupForAttemptInTransaction,
} from "@/lib/environment/environment-lease-store";
import {
  assertExecutionSourceSnapshot,
  executionSourceDigest,
  executionSourceRequestOf,
} from "@/lib/executions/domain/preparation-source";
import {
  type AttemptPreparationClaim,
  getAttemptById,
  updateAttemptState,
} from "@/lib/executions/persistence/attempt-store";
import { lockInvocationRootIfExists } from "@/lib/executions/persistence/execution-ownership-store";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import type { ThreadEventActorType } from "@/lib/persistence/schema/conversation";
import type {
  ExecutionBinding,
  Invocation,
  InvocationAttempt,
  InvocationExecutionState,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import {
  executionOwnershipTable,
  invocationAttemptTable,
} from "@/lib/persistence/schema/executions";
import { acceptExecutionPreparation } from "@/lib/runtime/application/execution-preparation";
import {
  type ObservedOwnerTuple,
  markInvocationLost,
} from "@/lib/runtime/application/runtime-recovery";
import {
  RuntimeStartTransportError,
  executionSourceRequestForStart,
  startRuntimeInvocation,
} from "@/lib/runtime/application/runtime-start";
import type { RuntimeEndpointResolution } from "@/lib/runtime/dispatcher";
import {
  InvocationNotFoundError,
  RedispatchNotAllowedError,
  RuntimeHttpClientError,
} from "@/lib/runtime/errors";
import {
  type SessionDispatchIdentity,
  lockClaimedSessionInTransaction,
  recordAttemptDispatchTransientFailure,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import type { TransientDispatchErrorCode } from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import { isTransientRuntimeError } from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import type { RuntimeStartResponse } from "@/lib/runtime/runtime-protocol";
import { and, eq } from "drizzle-orm";

export const REDISPATCH_ALLOWED_STATES: readonly InvocationExecutionState[] = [
  "queued",
  "running",
  "waiting_user",
];

export interface DispatchQueuedAttemptParams {
  tenantId: string;
  attemptId: string;
  /**
   * 领取身份（R04 §5）：来自 Session dispatch claim 时，所有完成确认都按该身份复核；
   * 请求内联路径为 `null`（无 lease，只按 Session 自身冻结 tuple 复核）。
   */
  claim?: SessionDispatchIdentity | null;
  preparationClaim?: AttemptPreparationClaim | null;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<RuntimeEndpointResolution>;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
  runtimeIdempotencyKey?: string | null;
  now?: Date;
}

export type DispatchQueuedAttemptResult =
  | {
      status: "started";
      invocation: Invocation;
      attempt: InvocationAttempt;
      response: RuntimeStartResponse;
      sessionBinding: RuntimeSessionBinding;
      sessionBindingCreated: boolean;
      previousSessionBinding: RuntimeSessionBinding | null;
      invocationStartedEvent: null;
    }
  | {
      status: "transient_scheduled";
      attempt: InvocationAttempt;
      skipReason: TransientDispatchErrorCode;
      nextDispatchAt: Date;
      dispatchCount: number;
    }
  | {
      status: "transient_exhausted";
      attempt: InvocationAttempt;
      skipReason: TransientDispatchErrorCode;
    }
  | { status: "terminal_failed"; attempt: InvocationAttempt; errorCode: string };

export async function dispatchQueuedInvocationAttempt(
  params: DispatchQueuedAttemptParams,
): Promise<DispatchQueuedAttemptResult> {
  const attempt = await getAttemptById(params.attemptId);
  if (!attempt) throw new Error(`InvocationAttempt 不存在（id=${params.attemptId}）`);
  if (attempt.attemptState !== "queued") throw new Error(`Attempt 已非 queued（id=${attempt.id}）`);
  const invocation = await getInvocationById(params.tenantId, attempt.invocationId);
  if (!invocation) throw new InvocationNotFoundError(attempt.invocationId);
  if (!REDISPATCH_ALLOWED_STATES.includes(invocation.executionState)) {
    throw new RedispatchNotAllowedError(invocation.id, invocation.executionState);
  }
  const binding = await import("@/lib/executions/persistence/execution-binding-queries").then(
    (module) => module.getExecutionBindingByInvocation(params.tenantId, invocation.id),
  );
  if (!binding) throw new InvocationNotFoundError(invocation.id);
  const dispatchClaim = params.claim;
  const persistedSession = dispatchClaim
    ? await import("@/lib/runtime/persistence/runtime-session-store").then((module) =>
        module.getRuntimeSessionBindingById(params.tenantId, dispatchClaim.sessionBindingId),
      )
    : null;
  if (params.claim && !persistedSession) throw new Error("RuntimeSessionMismatch");
  const persistedSource = persistedSession
    ? assertExecutionSourceSnapshot(persistedSession.sourceRequestJson)
    : null;
  if (
    persistedSession &&
    (!persistedSource ||
      persistedSession.sourceRequestDigest !== executionSourceDigest(persistedSource) ||
      persistedSession.attemptId !== attempt.id)
  ) {
    throw new Error("RuntimeSessionMismatch");
  }
  const sourceRequest = persistedSource
    ? executionSourceRequestOf(persistedSource)
    : params.preparationClaim
      ? executionSourceRequestOf(params.preparationClaim.source)
      : executionSourceRequestForStart({
          tenantId: params.tenantId,
          invocation,
          binding,
          attempt,
          sourceOperationKey: `invocation:${invocation.id}`,
        });
  const preparationDecision = await acceptExecutionPreparation({
    request: sourceRequest,
    claimId: params.preparationClaim?.claimId ?? randomUUID(),
    now: params.now,
  });
  if (preparationDecision.disposition === "busy") throw new Error("AttemptPreparationBusy");
  const preparationClaim =
    preparationDecision.disposition === "claimed" ? preparationDecision.claim : null;
  try {
    const endpoint = await params.runtimeEndpointResolver(binding);
    const revision =
      binding.environmentMode === "MANAGED" && binding.environmentDefinitionRevisionId
        ? await getEnvironmentRevisionById(params.tenantId, binding.environmentDefinitionRevisionId)
        : null;
    if (binding.environmentMode === "MANAGED" && (!revision || !endpoint.environmentProvisioner)) {
      throw new Error("EnvironmentRevisionMismatch");
    }
    if (endpoint.workspace && endpoint.workspace.binding.id !== binding.workspaceBindingId) {
      throw new Error("WorkspaceNotReady");
    }
    const environmentLease = revision
      ? preparationClaim &&
        preparationDecision.disposition === "claimed" &&
        preparationDecision.stage === "prepare" &&
        endpoint.environmentProvisioner
        ? await endpoint.environmentProvisioner.provision({
            tenantId: params.tenantId,
            invocationId: invocation.id,
            attemptId: attempt.id,
            // 只实例化 Binding 冻结的 Revision（R07 §1）。
            revisionId: binding.environmentDefinitionRevisionId as string,
            revision,
            workspaceBindingId: binding.workspaceBindingId,
            workspaceRoot: endpoint.workspace?.root ?? null,
            recoveryAnchorDigest: null,
            preparationClaim,
          })
        : await getEnvironmentLeaseByAttempt(params.tenantId, invocation.id, attempt.id)
      : null;
    const started = await startRuntimeInvocation({
      tenantId: params.tenantId,
      invocation,
      binding,
      attempt,
      runtimeClient: params.runtimeClient,
      runtimeEndpoint: endpoint.runtimeEndpoint,
      auth: endpoint.auth,
      callbackEndpoints: endpoint.callbackEndpoints,
      environmentLeaseId: environmentLease?.id ?? null,
      environmentProvisioner: endpoint.environmentProvisioner ?? null,
      workspace: endpoint.workspace,
      // A05：投递重试仍是**同一个**来源意图（Invocation 身份），不是新请求。
      // 用时间戳或投递序号会让"ACK 丢失后的第二次投递"被判成新意图而重做准备。
      sourceOperationKey: sourceRequest.sourceOperationKey,
      intentType: sourceRequest.intentType,
      recovery:
        sourceRequest.recovery.kind === "resume"
          ? {
              kind: "resume",
              anchor: sourceRequest.recovery.anchor,
              anchorDigest: sourceRequest.recovery.anchorDigest,
              ...(sourceRequest.recovery.checkpointId
                ? { checkpointId: sourceRequest.recovery.checkpointId }
                : {}),
            }
          : undefined,
      preparationClaim,
      sessionDispatchClaim: params.claim,
      now: params.now,
    });
    const session = await import("@/lib/runtime/persistence/runtime-session-store").then((module) =>
      module.getRuntimeSessionBindingById(params.tenantId, started.sessionBindingId),
    );
    if (!session) throw new Error(`RuntimeSessionBinding 不存在（id=${started.sessionBindingId}）`);
    return {
      status: "started",
      invocation,
      attempt: (await getAttemptById(attempt.id)) ?? attempt,
      response: started.response,
      sessionBinding: session,
      sessionBindingCreated: true,
      previousSessionBinding: null,
      invocationStartedEvent: null,
    };
  } catch (error) {
    const failure = error instanceof RuntimeStartTransportError ? error.originalError : error;
    const dispatchIdentity =
      error instanceof RuntimeStartTransportError ? error.dispatchIdentity : (params.claim ?? null);
    if (!(failure instanceof RuntimeHttpClientError) || !isTransientRuntimeError(failure)) {
      const errorCode =
        failure instanceof RuntimeHttpClientError
          ? (failure.runtimeErrorCode ?? failure.stableCode)
          : failure instanceof Error
            ? failure.name
            : "RUNTIME_DISPATCH_FAILED";
      const failedAttempt = await failAttemptAndInvokeRecoveryAuthority({
        tenantId: params.tenantId,
        attempt,
        invocation,
        errorCode,
        errorSummary: failure instanceof Error ? failure.message : String(failure),
        now: params.now ?? new Date(),
        workIdentity: dispatchIdentity
          ? { kind: "dispatch", claim: dispatchIdentity }
          : preparationClaim
            ? { kind: "preparation", claim: preparationClaim }
            : (() => {
                throw new Error("AttemptFailureWorkIdentityMissing");
              })(),
      });
      return { status: "terminal_failed", attempt: failedAttempt, errorCode };
    }
    const skipReason: TransientDispatchErrorCode =
      failure.kind === "network" ? "runtime_network_unavailable" : "runtime_unavailable";
    // R04 §5：暂态重试排定必须带 **Session + Ownership + claim token** 身份。
    const outcome = await recordAttemptDispatchTransientFailure(
      dispatchIdentity ??
        (() => {
          throw new Error("SessionDispatchClaimMissing");
        })(),
      {
        errorCode: skipReason,
        now: params.now ?? new Date(),
        counted: true,
      },
    );
    if (outcome.outcome === "exhausted") {
      // R03 §5：携带本次观察到的 Owner tuple；由 markInvocationLost 在根锁内复核，
      // 陈旧观察（已换代/已续租）只丢弃，不误杀新 Owner。
      await markInvocationLost({
        tenantId: params.tenantId,
        invocationId: invocation.id,
        reasonCode: "dispatch_retry_exhausted",
        errorSummary: `Attempt dispatch retry exhausted（lastTransient=${skipReason}）`,
        observedOwner: outcome.observedOwner,
        actorType: params.actorType,
        actorId: params.actorId ?? null,
        correlationId: params.correlationId ?? null,
      });
      return { status: "transient_exhausted", attempt: outcome.attempt, skipReason };
    }
    return {
      status: "transient_scheduled",
      attempt: outcome.attempt,
      skipReason,
      nextDispatchAt: outcome.nextDispatchAt,
      dispatchCount: outcome.dispatchCount,
    };
  }
}

/**
 * 请求内联调度（无 lease）的完成身份：按 Attempt 定位它当前的 Session generation。
 *
 * 这不是"按 attemptId 直接更新"：定位得到的 tuple 会作为完成更新的条件逐项复核，
 * 因此并发的新 generation 不会被迟到结论污染。
 */
export type AttemptFailureWorkIdentity =
  | { kind: "preparation"; claim: AttemptPreparationClaim }
  | { kind: "dispatch"; claim: SessionDispatchIdentity };

export async function failAttemptAndInvokeRecoveryAuthority(params: {
  tenantId: string;
  attempt: InvocationAttempt;
  invocation: Invocation;
  errorCode: string;
  errorSummary: string;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
  now: Date;
  /** 出发时的阶段工作身份；失败出口不得重新查询当前 claim。 */
  workIdentity: AttemptFailureWorkIdentity;
}): Promise<InvocationAttempt> {
  const observedOwner = await db.transaction(async (tx): Promise<ObservedOwnerTuple | null> => {
    const invocation = await lockInvocationRootIfExists(tx, params.tenantId, params.invocation.id);
    if (!invocation) throw new InvocationNotFoundError(params.invocation.id);
    const [currentAttempt] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.tenantId, params.tenantId),
          eq(invocationAttemptTable.id, params.attempt.id),
          eq(invocationAttemptTable.invocationId, params.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!currentAttempt) throw new Error(`InvocationAttempt 不存在（id=${params.attempt.id}）`);

    let originOwner: typeof executionOwnershipTable.$inferSelect | undefined;
    if (params.workIdentity.kind === "preparation") {
      const { assertAttemptPreparationClaimHeldInTransaction } = await import(
        "@/lib/executions/persistence/attempt-store"
      );
      await assertAttemptPreparationClaimHeldInTransaction(tx, params.workIdentity.claim);
      const predecessor = params.workIdentity.claim.source.predecessor;
      if (predecessor) {
        [originOwner] = await tx
          .select()
          .from(executionOwnershipTable)
          .where(
            and(
              eq(executionOwnershipTable.tenantId, params.tenantId),
              eq(executionOwnershipTable.id, predecessor.ownershipId),
              eq(executionOwnershipTable.attemptId, predecessor.attemptId),
              eq(executionOwnershipTable.leaseEpoch, Number(predecessor.leaseEpoch)),
            ),
          )
          .for("update")
          .limit(1);
      }
    } else {
      const session = await lockClaimedSessionInTransaction(tx, params.workIdentity.claim);
      if (session.invocationId !== params.invocation.id) {
        throw new Error("SessionDispatchClaimSuperseded");
      }
      [originOwner] = await tx
        .select()
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, params.tenantId),
            eq(executionOwnershipTable.id, params.workIdentity.claim.ownershipId),
            eq(executionOwnershipTable.attemptId, params.workIdentity.claim.attemptId),
            eq(executionOwnershipTable.leaseEpoch, params.workIdentity.claim.leaseEpoch),
          ),
        )
        .for("update")
        .limit(1);
      if (!originOwner) throw new Error("SessionDispatchClaimSuperseded");
    }

    if (currentAttempt.attemptState === "queued" || currentAttempt.attemptState === "running") {
      await updateAttemptState(tx, params.attempt.id, "failed", {
        finishedAt: params.now,
        errorCode: params.errorCode,
        errorSummary: params.errorSummary,
      });
      if (params.workIdentity.kind === "preparation") {
        const [activeOwner] = await tx
          .select({ id: executionOwnershipTable.id })
          .from(executionOwnershipTable)
          .where(
            and(
              eq(executionOwnershipTable.tenantId, params.tenantId),
              eq(executionOwnershipTable.invocationId, params.invocation.id),
              eq(executionOwnershipTable.ownershipState, "active"),
            ),
          )
          .for("update")
          .limit(1);
        if (!activeOwner) {
          // Prepared 的实例可能已经真实存在，而 O/S 尚未建立。准备 claim 与 Attempt
          // 失败在同一事务内核对后，给该 Attempt 的 Lease 登记持久退役义务。
          await registerEnvironmentLeaseCleanupForAttemptInTransaction(tx, {
            tenantId: params.tenantId,
            invocationId: params.invocation.id,
            attemptId: params.attempt.id,
            errorCode: params.errorCode,
            now: params.now,
          });
        }
      }
    }
    return originOwner
      ? {
          ownershipId: originOwner.id,
          attemptId: originOwner.attemptId,
          leaseEpoch: originOwner.leaseEpoch,
          leaseExpiresAt: originOwner.leaseExpiresAt,
          lastHeartbeatAt: originOwner.lastHeartbeatAt,
        }
      : null;
  });
  const recovered = await markInvocationLost({
    tenantId: params.tenantId,
    invocationId: params.invocation.id,
    reasonCode: params.errorCode,
    errorSummary: params.errorSummary,
    // 使用本次工作出发时绑定的旧代际；绝不在 catch 中查询并借用继任者身份。
    observedOwner,
    actorType: params.actorType,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
  }).catch((error) => {
    if (error instanceof Error && error.name === "InvocationAlreadyTerminalError") return null;
    throw error;
  });
  return (await getAttemptById(params.attempt.id)) ?? (recovered ? params.attempt : params.attempt);
}
