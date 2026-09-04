/**
 * 从持久 Authority 重建并重发同一个 queued InvocationAttempt。
 *
 * Worker 只传 attemptId；本服务负责校验冻结 Binding/Revision、选择 Hosted/External
 * Transport、重建 start request，并在 Hosted 接受后显式启动本地执行。
 */
import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { loadFrozenGovernanceConfig } from "@/lib/governance/governance-repository";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { logger } from "@/lib/logger";
import { invocationTable } from "@/lib/persistence/schema/executions";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { hostedRuntimeApplicationService } from "@/lib/runtime/application/production-resume-harness-invocation";
import {
  OutboundRuntimeAuthError,
  resolveOutboundRuntimeAuth,
} from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { RedispatchNotAllowedError, RuntimeHttpClientError } from "@/lib/runtime/errors";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import { getAttemptById, updateAttemptState } from "@/lib/runtime/invocation-attempt-queries";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  dispatchQueuedInvocationAttempt,
  failAttemptAndInvokeRecoveryAuthority,
} from "@/lib/runtime/retry/dispatch-queued-invocation-attempt";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import { recoverTrustedExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import { createRuntimeTransportResolver } from "@/lib/runtime/transport/runtime-transport-resolver";
import { eq } from "drizzle-orm";

const GATEWAY_ENDPOINTS = {
  events: "in-process://events",
  cancel: "in-process://cancel",
  resume: "in-process://resume",
  steer: "in-process://steer",
  tools: "in-process://gateway/v1/tools",
  tool_calls: "in-process://gateway/v1/tool-calls",
  user_action_requests: "in-process://gateway/v1/user-action-requests",
  capability_actions: "in-process://gateway/v1/capability-actions",
};

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
          errorCode: "INVOCATION_NOT_FOUND",
          errorSummary: "Attempt 关联 Invocation 不存在",
        }),
      );
      return;
    }
    if (["completed", "failed", "cancelled", "lost"].includes(invocation.executionState)) {
      await db.transaction((tx) =>
        updateAttemptState(tx, attempt.id, "failed", {
          errorCode: "PARENT_INVOCATION_TERMINAL",
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
      revision.runtimeEvidenceKind !== binding.runtimeEvidenceKind ||
      revision.runtimeTargetDigest !== binding.runtimeTargetDigest ||
      revision.configHash !== binding.runtimeConfigDigest
    ) {
      await failAttemptAndInvokeRecoveryAuthority({
        tenantId: invocation.tenantId,
        attempt,
        invocation,
        errorCode: "RUNTIME_REVISION_INVALID",
        errorSummary: "冻结的 RuntimeRevision 与 ExecutionBinding 不一致",
        actorType: "system",
        now: new Date(),
      });
      return;
    }
    try {
      recoverTrustedExecutionSubject(binding, invocation.tenantId);
      const hosted = revision.runtimeEvidenceKind === "hosted_artifact";
      const endpoint = hosted ? "in-process://hosted" : revision.endpointRef;
      const auth = hosted
        ? {
            mode: "workload_token" as const,
            token: issueWorkloadToken({
              type: "runtime",
              tenantId: invocation.tenantId,
              invocationId: invocation.id,
              runtimeRevisionId: revision.id,
              audience: "runtime",
              expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
            }),
          }
        : await resolveOutboundRuntimeAuth({
            tenantId: invocation.tenantId,
            identityMode: revision.identityMode,
            credentialRefId: revision.credentialRefId,
          });
      const resolveTransport = createRuntimeTransportResolver({
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
      });
      const runtimeClient: RuntimeHttpClient = await resolveTransport({
        protocolType: revision.protocolType,
        runtimeEvidenceKind: revision.runtimeEvidenceKind,
        endpoint,
        auth,
      });
      const result = await dispatchQueuedInvocationAttempt({
        tenantId: invocation.tenantId,
        attemptId: attempt.id,
        runtimeClient,
        runtimeEndpointResolver: async (frozenBinding) => {
          const frozenGovernance = await loadFrozenGovernanceConfig(
            frozenBinding.tenantId,
            frozenBinding.governanceConfigRevisionId,
          );
          const gatewayExpiresAt = Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.gateway;
          return {
            runtimeEndpoint: endpoint,
            auth,
            gatewayEndpoints: GATEWAY_ENDPOINTS,
            governanceConfig: {
              revision_id: frozenBinding.governanceConfigRevisionId,
              config_digest: frozenBinding.governanceConfigDigest,
              config: frozenGovernance.config as unknown as Record<string, unknown>,
            },
            gatewayAccess: {
              access_token: issueWorkloadToken({
                type: "gateway",
                tenantId: frozenBinding.tenantId,
                invocationId: frozenBinding.invocationId,
                runtimeRevisionId: frozenBinding.runtimeRevisionId,
                audience: "gateway",
                expiresAt: gatewayExpiresAt,
              }),
              expires_at: new Date(gatewayExpiresAt).toISOString(),
            },
          };
        },
      });
      if (result.status === "started" && hosted) {
        const launch = runtimeClient as ReturnType<typeof createInProcessHostedRuntimeClient>;
        void launch.launchAcceptedInvocation(invocation.id).catch((error) => {
          logger.error("[runtime-dispatch-retry] Hosted 执行启动失败", {
            invocationId: invocation.id,
            error: String(error),
          });
        });
      }
      return result;
    } catch (error) {
      if (error instanceof RedispatchNotAllowedError) {
        const refreshedAttempt = await getAttemptById(attempt.id);
        if (refreshedAttempt?.attemptState === "queued") {
          await db.transaction((tx) =>
            updateAttemptState(tx, attempt.id, "failed", {
              errorCode: "PARENT_INVOCATION_TERMINAL",
              errorSummary: "Parent Invocation 已终态",
            }),
          );
        }
        return;
      }
      const refreshedAttempt = await getAttemptById(attempt.id);
      if (refreshedAttempt?.attemptState !== "queued") throw error;
      const stableCode =
        error instanceof RuntimeHttpClientError
          ? error.stableCode
          : error instanceof OutboundRuntimeAuthError
            ? "RUNTIME_CREDENTIAL_INVALID"
            : "RUNTIME_DISPATCH_CONFIGURATION_INVALID";
      await failAttemptAndInvokeRecoveryAuthority({
        tenantId: invocation.tenantId,
        attempt: refreshedAttempt,
        invocation,
        errorCode: stableCode,
        errorSummary: "Runtime retry 在网络调用前失败",
        actorType: "system",
        now: new Date(),
      });
      return;
    }
  };
}

export const dispatchPersistedQueuedInvocationAttempt =
  createPersistedQueuedInvocationAttemptDispatcher();
