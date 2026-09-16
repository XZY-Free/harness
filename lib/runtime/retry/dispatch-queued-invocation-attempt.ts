/** Dispatches one durable InvocationAttempt using its frozen execution facts. */
import { db } from "@/lib/db/client";
import { getEnvironmentRevisionById } from "@/lib/environment/environment-definition-store";
import { getAttemptById, updateAttemptState } from "@/lib/executions/persistence/attempt-store";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import type { ThreadEventActorType } from "@/lib/persistence/schema/conversation";
import type {
  ExecutionBinding,
  Invocation,
  InvocationAttempt,
  InvocationExecutionState,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import { markInvocationLost } from "@/lib/runtime/application/runtime-recovery";
import { startRuntimeInvocation } from "@/lib/runtime/application/runtime-start";
import type { RuntimeEndpointResolution } from "@/lib/runtime/dispatcher";
import {
  InvocationNotFoundError,
  RedispatchNotAllowedError,
  RuntimeHttpClientError,
} from "@/lib/runtime/errors";
import { recordAttemptDispatchTransientFailure } from "@/lib/runtime/retry/dispatch-retry-queries";
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
  const endpoint = await params.runtimeEndpointResolver(binding);
  try {
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
            revision,
            workspaceBindingId: binding.workspaceBindingId,
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
      workspace: endpoint.workspace,
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
      });
      return { status: "terminal_failed", attempt: failedAttempt, errorCode };
    }
    const skipReason: TransientDispatchErrorCode =
      error.kind === "network" ? "runtime_network_unavailable" : "runtime_unavailable";
    const outcome = await recordAttemptDispatchTransientFailure({
      attemptId: attempt.id,
      errorCode: skipReason,
      now: params.now ?? new Date(),
      counted: true,
    });
    if (outcome.outcome === "exhausted") {
      await markInvocationLost({
        tenantId: params.tenantId,
        invocationId: invocation.id,
        reasonCode: "dispatch_retry_exhausted",
        errorSummary: `Attempt dispatch retry exhausted（lastTransient=${skipReason}）`,
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
}): Promise<InvocationAttempt> {
  const current = await getAttemptById(params.attempt.id);
  if (current?.attemptState === "queued" || current?.attemptState === "running") {
    await db.transaction((tx) =>
      updateAttemptState(tx, params.attempt.id, "failed", {
        finishedAt: params.now,
        errorCode: params.errorCode,
        errorSummary: params.errorSummary,
      }),
    );
  }
  const recovered = await markInvocationLost({
    tenantId: params.tenantId,
    invocationId: params.invocation.id,
    reasonCode: params.errorCode,
    errorSummary: params.errorSummary,
    actorType: params.actorType,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
  }).catch((error) => {
    if (error instanceof Error && error.name === "InvocationAlreadyTerminalError") return null;
    throw error;
  });
  return (await getAttemptById(params.attempt.id)) ?? (recovered ? params.attempt : params.attempt);
}
