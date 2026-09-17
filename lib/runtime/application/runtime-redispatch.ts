import { getEnvironmentRevisionById } from "@/lib/environment/environment-definition-store";
import type { EnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import { createAttempt } from "@/lib/executions/persistence/attempt-store";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import type { Invocation, InvocationAttempt } from "@/lib/persistence/schema/executions";
import { startRuntimeInvocation } from "@/lib/runtime/application/runtime-start";
import { InvocationNotFoundError, RedispatchNotAllowedError } from "@/lib/runtime/errors";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import type { CallbackEndpoints } from "@/lib/runtime/runtime-protocol";
import type { WorkspaceExecutionResources } from "@/lib/workspace/workspace-backend";

export const REDISPATCH_ALLOWED_STATES = ["queued", "running", "waiting_user"] as const;
export interface RuntimeRedispatchInput {
  tenantId: string;
  invocationId: string;
  retryReasonCode: string;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpoint: string;
  auth: Parameters<RuntimeHttpClient["startInvocation"]>[0]["auth"];
  callbackEndpoints: CallbackEndpoints;
  environmentProvisioner?: EnvironmentProvisioner;
  workspace?: WorkspaceExecutionResources;
}
export interface RuntimeRedispatchResult {
  redispatched: boolean;
  invocation: Invocation;
  attempt: InvocationAttempt;
  sessionBindingId?: string;
  response?: unknown;
}

export async function createQueuedRedispatchAttempt(input: {
  tenantId: string;
  invocationId: string;
  retryReasonCode: string;
  filesystemCheckpointId?: string | null;
  resumeAnchor?: unknown;
  resumeAnchorDigest?: string | null;
}): Promise<InvocationAttempt> {
  const invocation = await getInvocationById(input.tenantId, input.invocationId);
  if (!invocation) throw new InvocationNotFoundError(input.invocationId);
  if (
    !REDISPATCH_ALLOWED_STATES.includes(
      invocation.executionState as (typeof REDISPATCH_ALLOWED_STATES)[number],
    )
  )
    throw new RedispatchNotAllowedError(input.invocationId, invocation.executionState);
  return createAttempt({
    invocationId: input.invocationId,
    tenantId: input.tenantId,
    retryReasonCode: input.retryReasonCode,
    filesystemCheckpointId: input.filesystemCheckpointId,
    resumeAnchor: input.resumeAnchor,
    resumeAnchorDigest: input.resumeAnchorDigest,
  });
}

export async function redispatchRuntimeInvocation(
  input: RuntimeRedispatchInput,
): Promise<RuntimeRedispatchResult> {
  const invocation = await getInvocationById(input.tenantId, input.invocationId);
  if (!invocation) throw new InvocationNotFoundError(input.invocationId);
  if (
    !REDISPATCH_ALLOWED_STATES.includes(
      invocation.executionState as (typeof REDISPATCH_ALLOWED_STATES)[number],
    )
  )
    throw new RedispatchNotAllowedError(input.invocationId, invocation.executionState);
  const binding = await getExecutionBindingByInvocation(input.tenantId, input.invocationId);
  if (!binding) throw new InvocationNotFoundError(input.invocationId);
  const attempt = await createQueuedRedispatchAttempt({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    retryReasonCode: input.retryReasonCode,
  });
  const revision =
    binding.environmentMode === "MANAGED" && binding.environmentDefinitionRevisionId
      ? await getEnvironmentRevisionById(input.tenantId, binding.environmentDefinitionRevisionId)
      : null;
  if (binding.environmentMode === "MANAGED" && (!revision || !input.environmentProvisioner)) {
    throw new Error("EnvironmentRevisionMismatch");
  }
  if (input.workspace && input.workspace.binding.id !== binding.workspaceBindingId) {
    throw new Error("WorkspaceNotReady");
  }
  const environmentLease =
    revision && input.environmentProvisioner
      ? await input.environmentProvisioner.provision({
          tenantId: input.tenantId,
          invocationId: invocation.id,
          attemptId: attempt.id,
          // Redispatch 仍指向 Binding 冻结的原 Revision（R07 §1 / INV-07）。
          revisionId: binding.environmentDefinitionRevisionId as string,
          revision,
          workspaceBindingId: binding.workspaceBindingId,
          workspaceRoot: input.workspace?.root ?? null,
          recoveryAnchorDigest: null,
        })
      : null;
  const started = await startRuntimeInvocation({
    tenantId: input.tenantId,
    invocation,
    binding,
    attempt,
    runtimeClient: input.runtimeClient,
    runtimeEndpoint: input.runtimeEndpoint,
    auth: input.auth,
    callbackEndpoints: input.callbackEndpoints,
    environmentLeaseId: environmentLease?.id ?? null,
    environmentProvisioner: input.environmentProvisioner ?? null,
    workspace: input.workspace,
  });
  const current = await getInvocationById(input.tenantId, input.invocationId);
  return {
    redispatched: true,
    invocation: current ?? invocation,
    attempt,
    sessionBindingId: started.sessionBindingId,
    response: started.response,
  };
}
