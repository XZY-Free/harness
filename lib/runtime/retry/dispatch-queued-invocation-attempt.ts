/** Dispatches one durable InvocationAttempt using its frozen execution facts. */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { getEnvironmentRevisionById } from "@/lib/environment/environment-definition-store";
import { environmentProvisionRequestDigest } from "@/lib/environment/environment-provisioner";
import {
  type AttemptPreparationClaim,
  claimAttemptPreparation,
  getAttemptById,
  updateAttemptState,
} from "@/lib/executions/persistence/attempt-store";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import type { ThreadEventActorType } from "@/lib/persistence/schema/conversation";
import type {
  ExecutionBinding,
  Invocation,
  InvocationAttempt,
  InvocationExecutionState,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import { markInvocationLost, readObservedOwner } from "@/lib/runtime/application/runtime-recovery";
import {
  runtimeStartSourceRequestDigest,
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
  assertSessionDispatchClaimHeld,
  recordAttemptDispatchTransientFailure,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import { sessionDispatchIdentityForAttempt } from "@/lib/runtime/retry/dispatch-retry-queries";
import type { TransientDispatchErrorCode } from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import { isTransientRuntimeError } from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import type { RuntimeStartResponse } from "@/lib/runtime/runtime-protocol";

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
  const preparationIntentKey = `invocation:${invocation.id}`;
  const preparationRequestDigest =
    binding.environmentMode === "MANAGED" && binding.environmentDefinitionRevisionId
      ? environmentProvisionRequestDigest({
          tenantId: params.tenantId,
          invocationId: invocation.id,
          attemptId: attempt.id,
          revisionId: binding.environmentDefinitionRevisionId,
          workspaceBindingId: binding.workspaceBindingId,
          recoveryAnchorDigest: null,
        })
      : runtimeStartSourceRequestDigest({
          tenantId: params.tenantId,
          invocationId: invocation.id,
          attemptId: attempt.id,
          intentType: "start",
          runtimeRevisionId: binding.runtimeRevisionId,
          workspaceBindingId: binding.workspaceBindingId,
          environmentDefinitionRevisionId: null,
          anchorDigest: null,
          checkpointId: null,
        });
  const preparationOutcome = params.preparationClaim
    ? null
    : await claimAttemptPreparation({
        tenantId: params.tenantId,
        invocationId: invocation.id,
        attemptId: attempt.id,
        intentKey: preparationIntentKey,
        requestDigest: preparationRequestDigest,
        claimId: randomUUID(),
        now: params.now,
      });
  if (preparationOutcome?.disposition === "busy") throw new Error("AttemptPreparationBusy");
  const preparationClaim = params.preparationClaim ?? preparationOutcome?.claim ?? null;
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
    const environmentLease =
      revision && endpoint.environmentProvisioner
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
            preparationClaimId: preparationClaim?.claimId ?? randomUUID(),
            preparationIntentKey,
            preparationRequestDigest,
          })
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
      sourceOperationKey: `invocation:${invocation.id}`,
      preparationClaim,
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
    const transient = error instanceof RuntimeHttpClientError && isTransientRuntimeError(error);
    if (!transient) {
      const errorCode =
        error instanceof RuntimeHttpClientError
          ? (error.runtimeErrorCode ?? error.stableCode)
          : error instanceof Error
            ? error.name
            : "RUNTIME_DISPATCH_FAILED";
      const failedAttempt = await failAttemptAndInvokeRecoveryAuthority({
        tenantId: params.tenantId,
        attempt,
        invocation,
        errorCode,
        errorSummary: error instanceof Error ? error.message : String(error),
        now: params.now ?? new Date(),
        claim: params.claim ?? null,
        preparationClaim,
      });
      return { status: "terminal_failed", attempt: failedAttempt, errorCode };
    }
    const skipReason: TransientDispatchErrorCode =
      error.kind === "network" ? "runtime_network_unavailable" : "runtime_unavailable";
    // R04 §5：暂态重试排定必须带 **Session + Ownership + claim token** 身份。
    const outcome = await recordAttemptDispatchTransientFailure(
      params.claim ?? (await requireInlineDispatchIdentity(params.tenantId, attempt.id)),
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
        observedOwner: await readObservedOwner({
          tenantId: params.tenantId,
          invocationId: invocation.id,
        }),
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
async function requireInlineDispatchIdentity(
  tenantId: string,
  attemptId: string,
): Promise<SessionDispatchIdentity> {
  const identity = await sessionDispatchIdentityForAttempt({ tenantId, attemptId });
  if (!identity) {
    throw new Error(`RuntimeSessionBinding 不存在（attemptId=${attemptId}）`);
  }
  return identity;
}

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
  /** 领取身份：给出时先复核 claim 仍被持有，否则拒绝写完成事实。 */
  claim?: SessionDispatchIdentity | null;
  preparationClaim?: AttemptPreparationClaim | null;
}): Promise<InvocationAttempt> {
  if (params.claim) await assertSessionDispatchClaimHeld(params.claim);
  const current = await getAttemptById(params.attempt.id);
  if (current?.attemptState === "queued" || current?.attemptState === "running") {
    await db.transaction(async (tx) => {
      if (params.preparationClaim) {
        const { assertAttemptPreparationClaimHeldInTransaction } = await import(
          "@/lib/executions/persistence/attempt-store"
        );
        await assertAttemptPreparationClaimHeldInTransaction(tx, params.preparationClaim);
      }
      await updateAttemptState(tx, params.attempt.id, "failed", {
        finishedAt: params.now,
        errorCode: params.errorCode,
        errorSummary: params.errorSummary,
      });
    });
  }
  const recovered = await markInvocationLost({
    tenantId: params.tenantId,
    invocationId: params.invocation.id,
    reasonCode: params.errorCode,
    errorSummary: params.errorSummary,
    // R03 §5：旧 Attempt 的失败结论必须携带它当时观察到的 Owner tuple。
    observedOwner: await readObservedOwner({
      tenantId: params.tenantId,
      invocationId: params.invocation.id,
    }),
    actorType: params.actorType,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
  }).catch((error) => {
    if (error instanceof Error && error.name === "InvocationAlreadyTerminalError") return null;
    throw error;
  });
  return (await getAttemptById(params.attempt.id)) ?? (recovered ? params.attempt : params.attempt);
}
