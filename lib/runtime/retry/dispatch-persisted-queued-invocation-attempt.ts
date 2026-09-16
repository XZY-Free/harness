/** Rebuilds transport from persisted RuntimeRevision and dispatches one Attempt. */
import { db } from "@/lib/db/client";
import { getAttemptById, updateAttemptState } from "@/lib/executions/persistence/attempt-store";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { invocationTable } from "@/lib/persistence/schema/executions";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { hostedRuntimeApplicationService } from "@/lib/runtime/application/runtime-resume";
import { resolveOutboundRuntimeAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { buildGatewayEndpoints } from "@/lib/runtime/gateway-endpoints";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  dispatchQueuedInvocationAttempt,
  failAttemptAndInvokeRecoveryAuthority,
} from "@/lib/runtime/retry/dispatch-queued-invocation-attempt";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import { createRuntimeTransportResolver } from "@/lib/runtime/transport/runtime-transport-resolver";
import { eq } from "drizzle-orm";

export interface PersistedAttemptDispatcherDependencies {
  hostedApplicationService?: HostedRuntimeApplicationService;
  createExternalTransport?: typeof createHttpHarnessRuntimeTransport;
}

export function createPersistedQueuedInvocationAttemptDispatcher(
  dependencies: PersistedAttemptDispatcherDependencies = {},
) {
  const hostedService = dependencies.hostedApplicationService ?? hostedRuntimeApplicationService;
  const createExternalTransport =
    dependencies.createExternalTransport ?? createHttpHarnessRuntimeTransport;

  return async function dispatchPersistedQueuedInvocationAttempt(attemptId: string) {
    const attempt = await getAttemptById(attemptId);
    if (!attempt || attempt.attemptState !== "queued") return;
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, attempt.invocationId))
      .limit(1);
    if (!invocation) {
      await db.transaction((tx) =>
        updateAttemptState(tx, attempt.id, "failed", {
          errorCode: "InvocationNotFound",
          errorSummary: "Attempt 关联 Invocation 不存在",
        }),
      );
      return;
    }
    if (["completed", "failed", "cancelled", "lost"].includes(invocation.executionState)) {
      await db.transaction((tx) =>
        updateAttemptState(tx, attempt.id, "failed", {
          errorCode: "InvocationAlreadyTerminal",
          errorSummary: `Parent Invocation 已终态（${invocation.executionState}）`,
        }),
      );
      return;
    }
    const binding = await getExecutionBindingByInvocation(invocation.tenantId, invocation.id);
    const revision = binding ? await getRuntimeRevisionById(binding.runtimeRevisionId) : null;
    if (
      !binding ||
      !revision ||
      revision.protocolType !== "harness_runtime_protocol" ||
      revision.runtimeEvidenceKind !== binding.runtimeEvidenceKind
    ) {
      await failAttemptAndInvokeRecoveryAuthority({
        tenantId: invocation.tenantId,
        attempt,
        invocation,
        errorCode: "EnvironmentRevisionMismatch",
        errorSummary: "冻结的 ExecutionBinding 与 RuntimeRevision 不一致",
        now: new Date(),
      });
      return;
    }
    const hosted = revision.runtimeEvidenceKind === "hosted_artifact";
    const endpoint = hosted ? "in-process://hosted" : revision.endpointRef;
    const auth = hosted
      ? { mode: "workload_token" as const, token: "in-process-runtime" }
      : await resolveOutboundRuntimeAuth({
          tenantId: invocation.tenantId,
          identityMode: revision.identityMode,
          credentialRefId: revision.credentialRefId,
        });
    const runtimeClient: RuntimeHttpClient = await createRuntimeTransportResolver({
      factories: {
        harness_runtime_protocol: {
          hosted_artifact: () =>
            createInProcessHostedRuntimeClient({
              tenantId: invocation.tenantId,
              applicationService: hostedService,
            }),
          external_endpoint: ({ endpoint: externalEndpoint, auth: externalAuth }) =>
            createExternalTransport({ endpoint: externalEndpoint, auth: externalAuth }),
        },
      },
    })({
      protocolType: revision.protocolType,
      runtimeEvidenceKind: revision.runtimeEvidenceKind,
      endpoint,
      auth,
    });
    try {
      return await dispatchQueuedInvocationAttempt({
        tenantId: invocation.tenantId,
        attemptId: attempt.id,
        runtimeClient,
        runtimeEndpointResolver: async (frozenBinding) => ({
          runtimeEndpoint: endpoint,
          auth,
          callbackEndpoints: buildGatewayEndpoints({
            external: !hosted,
            invocationId: frozenBinding.invocationId,
          }),
        }),
      });
    } catch (error) {
      const current = await getAttemptById(attempt.id);
      if (current?.attemptState === "queued") {
        await failAttemptAndInvokeRecoveryAuthority({
          tenantId: invocation.tenantId,
          attempt: current,
          invocation,
          errorCode: error instanceof Error ? error.name : "RuntimeDispatchFailed",
          errorSummary: error instanceof Error ? error.message : String(error),
          now: new Date(),
        });
      }
    }
  };
}

export const dispatchPersistedQueuedInvocationAttempt =
  createPersistedQueuedInvocationAttemptDispatcher();
