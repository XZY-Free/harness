import { aiConfig } from "@/lib/config";
import { getItemById } from "@/lib/conversations/thread-item-queries";
import { getTurnById } from "@/lib/conversations/turn-queries";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { loadFrozenGovernanceConfig } from "@/lib/governance/governance-repository";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import { createConfiguredRouteResolver } from "@/lib/routes/infrastructure/configured-route-resolver";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { HostedHarnessLoop } from "@/lib/runtime/adapters/hosted-adapter";
import { createResumeHarnessInvocation } from "@/lib/runtime/application/resume-harness-invocation";
import { resolveOutboundRuntimeAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import {
  configuredDecisionPort,
  configuredFinalResponsePort,
} from "@/lib/runtime/employee-turn-dispatcher";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { createMySqlHarnessLoopRecoveryPort } from "@/lib/runtime/harness-loop/mysql-recovery-port";
import { createPlatformHarnessActionExecutors } from "@/lib/runtime/harness-loop/platform-action-executors";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import {
  releaseInvocationExecutionLease,
  renewInvocationExecutionLease,
  tryAcquireInvocationExecutionLease,
} from "@/lib/runtime/persistence/invocation-execution-lease";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import { createHttpRuntimeClient } from "@/lib/runtime/runtime-client";

const configuredResolver = createConfiguredRouteResolver({
  projectionStore: mysqlRouteEligibilityResolutionStore,
});
const resolveRoute: RouteResolver = async (input) =>
  (
    await configuredResolver({
      tenantId: input.tenantId,
      target: input.target,
      routeScopeKey: input.routeScopeKey,
      businessKey: input.businessKey,
      attributes: input.attributes,
      threadDefaultModelRef: input.threadDefaultModelRef,
      now: input.now,
    })
  ).outcome;

const IN_PROCESS_GATEWAYS = {
  events: "in-process://events",
  cancel: "in-process://cancel",
  resume: "in-process://resume",
  steer: "in-process://steer",
  tools: "in-process://gateway/v1/tools",
  tool_calls: "in-process://gateway/v1/tool-calls",
  user_action_requests: "in-process://gateway/v1/user-action-requests",
  capability_actions: "in-process://gateway/v1/capability-actions",
};

/** 生产级唯一父 Harness 恢复能力；Worker 与补偿入口共用。 */
export const resumeHarnessInvocation = createResumeHarnessInvocation({
  loadInvocation: getInvocationById,
  loadBinding: getExecutionBindingByInvocation,
  loadRuntimeRevision: getRuntimeRevisionById,
  acquireLease: tryAcquireInvocationExecutionLease,
  releaseLease: releaseInvocationExecutionLease,
  renewLease: renewInvocationExecutionLease,
  async runHosted({ tenantId, invocation, binding, subject, capabilityCatalog }) {
    const turn = invocation.turnId ? await getTurnById(tenantId, invocation.turnId) : null;
    if (!invocation.threadId || !invocation.turnId || !turn) {
      throw new Error("Hosted continuation 仅支持具备 Thread/Turn 的父 Invocation");
    }
    const triggerItem = invocation.triggerItemId
      ? await getItemById(tenantId, invocation.triggerItemId)
      : null;
    const frozenGovernance = await loadFrozenGovernanceConfig(
      tenantId,
      binding.governanceConfigRevisionId,
    );
    const limits = asRecord(frozenGovernance.config)?.harnessLoopLimits;
    const loopLimits = asRecord(limits);
    const positive = (key: string, fallback: number) => {
      const value = loopLimits?.[key];
      return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
    };
    const authToken = issueWorkloadToken({
      type: "runtime",
      tenantId,
      invocationId: invocation.id,
      runtimeRevisionId: binding.runtimeRevisionId,
      audience: "runtime",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    });
    const loop = new HostedHarnessLoop({
      invocationId: invocation.id,
      tenantId,
      threadId: invocation.threadId,
      turnId: invocation.turnId,
      capabilityDirectives:
        turn.preferredAgentId && turn.agentUseMode === "preferred"
          ? [
              {
                capability_type: "agent",
                capability_id: turn.preferredAgentId,
                mode: "preferred" as const,
              },
            ]
          : undefined,
      capabilityCatalog,
      inputItems: triggerItem
        ? [{ type: "user_message", item_id: triggerItem.id, content: triggerItem.contentJson }]
        : [],
      workspace: {
        workspace_binding_id: binding.workspaceBindingId,
        workspace_type: binding.workspaceBindingId ? "managed" : "none",
      },
      executionLimits: {
        max_invocation_seconds: 600,
        max_event_bytes: 1_048_576,
        max_loop_steps: positive("maxLoopSteps", 12),
        max_agent_calls: positive("maxAgentCalls", 3),
        max_tool_calls: positive("maxToolCalls", 8),
        max_knowledge_searches: positive("maxKnowledgeSearches", 6),
        max_consecutive_same_action: positive("maxConsecutiveSameAction", 2),
      },
      traceContext: { trace_id: invocation.id, span_id: invocation.id },
      gatewayEndpoints: IN_PROCESS_GATEWAYS,
      runtimeEndpoint: "in-process://hosted",
      authToken,
      ingressClient: {
        async postEventBatch(invocationId, events, producerSequenceStart) {
          await ingressEventBatch({ tenantId, invocationId, events, producerSequenceStart });
        },
      },
      decisionPort: configuredDecisionPort(binding.modelId ?? aiConfig.chatModel),
      finalResponsePort: configuredFinalResponsePort(binding.modelId ?? aiConfig.chatModel),
      actionExecutors: createPlatformHarnessActionExecutors({
        tenantId,
        executionSubject: subject,
        resolveRoute,
        capabilityCatalog,
        transportChannel: "hosted",
      }),
      recoveryPort: createMySqlHarnessLoopRecoveryPort(tenantId),
      modelRef: binding.modelId,
    });
    return loop.run();
  },
  async resumeExternal({
    tenantId,
    invocation,
    binding,
    runtimeRevision,
    sourceType,
    agentCallId,
    sourceVersion,
  }) {
    const auth = await resolveOutboundRuntimeAuth({
      tenantId,
      identityMode: runtimeRevision.identityMode,
      credentialRefId: runtimeRevision.credentialRefId,
    });
    const expiresAt = Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.gateway;
    const response = await createHttpRuntimeClient().resumeInvocation({
      runtimeEndpoint: runtimeRevision.endpointRef,
      auth,
      invocationId: invocation.id,
      idempotencyKey: `harness-continuation:${sourceType}:${agentCallId}:${sourceVersion}`,
      requestBody: {
        resume_payload:
          sourceType === "tool_call"
            ? {
                source: "tool_call_continuation",
                tool_call_id: agentCallId,
                source_version: sourceVersion,
              }
            : {
                source: "agent_call_continuation",
                agent_call_id: agentCallId,
                source_version: sourceVersion,
              },
        trace_context: { trace_id: invocation.id, span_id: invocation.id },
        gateway_access: {
          access_token: issueWorkloadToken({
            type: "gateway",
            tenantId,
            invocationId: binding.invocationId,
            runtimeRevisionId: binding.runtimeRevisionId,
            audience: "gateway",
            expiresAt,
          }),
          expires_at: new Date(expiresAt).toISOString(),
        },
      },
    });
    return { resumed: response.invocation_id === invocation.id && response.resumed };
  },
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
