import { cancelActiveAgentCalls } from "@/lib/agents/calls/application/cancel-active-agent-calls";
import { aiConfig } from "@/lib/config";
import { getItemById } from "@/lib/conversations/thread-item-queries";
import { getTurnById } from "@/lib/conversations/turn-queries";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { loadFrozenGovernanceConfig } from "@/lib/governance/governance-repository";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { threadItemTable } from "@/lib/persistence/schema/conversation";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import { createConfiguredRouteResolver } from "@/lib/routes/infrastructure/configured-route-resolver";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import {
  HostedHarnessLoop,
  type TransientEventBatchSink,
} from "@/lib/runtime/adapters/hosted-adapter";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { createResumeHarnessInvocation } from "@/lib/runtime/application/resume-harness-invocation";
import { resolveOutboundRuntimeAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import {
  configuredDecisionPort,
  configuredFinalResponsePort,
} from "@/lib/runtime/harness-loop/configured-model-ports";
import type {
  HarnessActionExecutors,
  HarnessDecisionPort,
  HarnessFinalResponsePort,
} from "@/lib/runtime/harness-loop/loop";
import { createMySqlHarnessLoopRecoveryPort } from "@/lib/runtime/harness-loop/mysql-recovery-port";
import { createPlatformHarnessActionExecutors } from "@/lib/runtime/harness-loop/platform-action-executors";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import {
  releaseInvocationExecutionLease,
  renewInvocationExecutionLease,
  tryAcquireInvocationExecutionLease,
} from "@/lib/runtime/persistence/invocation-execution-lease";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import { getLatestProducerSequence } from "@/lib/runtime/recovery-queries";
import { createHttpRuntimeClient } from "@/lib/runtime/runtime-client";
import { ingressTransientBatch } from "@/lib/runtime/transient-events";
import { and, eq } from "drizzle-orm";

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

interface LiveHostedRunner {
  controller: AbortController;
  promise: Promise<unknown>;
}

/** 仅保存当前进程的可取消句柄；恢复判断始终来自 DB。 */
const liveHostedRunners = new Map<string, LiveHostedRunner>();

interface HostedExecutionOverrides {
  decisionPort?: HarnessDecisionPort;
  finalResponsePort?: HarnessFinalResponsePort;
  actionExecutors?: HarnessActionExecutors;
  transientEventBatchSink?: TransientEventBatchSink;
  modelRef?: string;
}

/** 仅供同一请求内替换执行端口；Invocation/Binding/History 仍全部从 DB 重建。 */
const hostedExecutionOverrides = new Map<string, HostedExecutionOverrides>();

/** 生产级唯一父 Harness 恢复能力；Worker 与补偿入口共用。 */
export const resumeHarnessInvocation = createResumeHarnessInvocation({
  loadInvocation: getInvocationById,
  loadBinding: getExecutionBindingByInvocation,
  loadRuntimeRevision: getRuntimeRevisionById,
  acquireLease: tryAcquireInvocationExecutionLease,
  releaseLease: releaseInvocationExecutionLease,
  renewLease: renewInvocationExecutionLease,
  async runHosted({ tenantId, invocation, binding, subject, capabilityCatalog, abortSignal }) {
    const overrides = hostedExecutionOverrides.get(invocation.id);
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
    const controller = new AbortController();
    const abortForLeaseLoss = () => controller.abort(abortSignal.reason);
    if (abortSignal.aborted) abortForLeaseLoss();
    else abortSignal.addEventListener("abort", abortForLeaseLoss, { once: true });
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
      decisionPort:
        overrides?.decisionPort ?? configuredDecisionPort(binding.modelId ?? aiConfig.chatModel),
      finalResponsePort:
        overrides?.finalResponsePort ??
        configuredFinalResponsePort(binding.modelId ?? aiConfig.chatModel),
      actionExecutors:
        overrides?.actionExecutors ??
        createPlatformHarnessActionExecutors({
          tenantId,
          executionSubject: subject,
          resolveRoute,
          capabilityCatalog,
          transportChannel: "hosted",
        }),
      recoveryPort: createMySqlHarnessLoopRecoveryPort(tenantId),
      transientEventBatchSink:
        overrides?.transientEventBatchSink ??
        (async ({ invocationId, events, transientSequenceStart }) => {
          await ingressTransientBatch({
            tenantId,
            invocationId,
            events,
            transientSequenceStart,
          });
        }),
      modelRef: overrides?.modelRef ?? binding.modelId,
      abortSignal: controller.signal,
    });
    const running = loop.run();
    const liveRunner = { controller, promise: running };
    liveHostedRunners.set(invocation.id, liveRunner);
    try {
      return await running;
    } finally {
      abortSignal.removeEventListener("abort", abortForLeaseLoss);
      if (liveHostedRunners.get(invocation.id) === liveRunner) {
        liveHostedRunners.delete(invocation.id);
      }
    }
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
            : sourceType === "agent_call"
              ? {
                  source: "agent_call_continuation",
                  agent_call_id: agentCallId,
                  source_version: sourceVersion,
                }
              : {
                  source: sourceType,
                  source_id: agentCallId,
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

export const hostedRuntimeApplicationService: HostedRuntimeApplicationService = {
  start(input) {
    return resumeHarnessInvocation({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      sourceType: "hosted_start",
      agentCallId: input.idempotencyKey,
      sourceVersion: 1,
    });
  },

  resume(input) {
    return resumeHarnessInvocation({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      sourceType: "user_action",
      agentCallId: input.idempotencyKey,
      sourceVersion: 1,
    });
  },

  async cancel(input) {
    const liveRunner = liveHostedRunners.get(input.invocationId);
    if (liveRunner) {
      liveRunner.controller.abort(new DOMException("Hosted Invocation 已取消", "AbortError"));
    }
    await cancelActiveAgentCalls({
      tenantId: input.tenantId,
      parentInvocationId: input.invocationId,
    });
    if (liveRunner) {
      await liveRunner.promise;
      return;
    }
    const invocation = await getInvocationById(input.tenantId, input.invocationId);
    if (!invocation || isTerminal(invocation.executionState)) return;
    const latestSequence =
      (await getLatestProducerSequence(input.tenantId, input.invocationId)) ?? 0;
    const eventKey = computeCanonicalDigest(input.idempotencyKey).slice(7, 39);
    await ingressEventBatch({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      producerSequenceStart: latestSequence + 1,
      events: [
        {
          producer_event_id: `hosted-cancel-${eventKey}`,
          producer_sequence: latestSequence + 1,
          type: "execution.cancelled",
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          payload: {
            cancelled_by: "hosted_control",
            reason: input.reason ?? "user_cancel",
          },
        },
      ],
    });
  },

  async steer(input) {
    const invocation = await getInvocationById(input.tenantId, input.invocationId);
    if (!invocation || isTerminal(invocation.executionState)) {
      throw new Error(`Hosted Invocation 不可引导：${input.invocationId}`);
    }
    const payload = asRecord(input.steerPayload);
    const guidanceItemId = payload?.guidance_item_id;
    if (typeof guidanceItemId !== "string" || !guidanceItemId) {
      throw new Error("Hosted steer 缺少 guidance_item_id");
    }
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(threadItemTable)
        .set({ itemState: "completed", updatedAt: new Date() })
        .where(
          and(
            eq(threadItemTable.id, guidanceItemId),
            eq(threadItemTable.invocationId, input.invocationId),
            eq(threadItemTable.itemType, "user_guidance"),
            eq(threadItemTable.itemState, "pending"),
          ),
        );
      if (updated[0].affectedRows === 1) return;
      const [existing] = await tx
        .select({ id: threadItemTable.id })
        .from(threadItemTable)
        .where(
          and(
            eq(threadItemTable.id, guidanceItemId),
            eq(threadItemTable.invocationId, input.invocationId),
            eq(threadItemTable.itemType, "user_guidance"),
            eq(threadItemTable.itemState, "completed"),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Hosted steer guidance 不存在或不属于当前 Invocation");
    });
  },
};

export function createConfiguredHostedRuntimeApplicationService(
  overrides: HostedExecutionOverrides,
): HostedRuntimeApplicationService {
  const withOverrides = async <T>(invocationId: string, operation: () => Promise<T>) => {
    hostedExecutionOverrides.set(invocationId, overrides);
    try {
      return await operation();
    } finally {
      hostedExecutionOverrides.delete(invocationId);
    }
  };
  return {
    start: (input) =>
      withOverrides(input.invocationId, () => hostedRuntimeApplicationService.start(input)),
    resume: (input) =>
      withOverrides(input.invocationId, () => hostedRuntimeApplicationService.resume(input)),
    cancel: (input) => hostedRuntimeApplicationService.cancel(input),
    steer: (input) => hostedRuntimeApplicationService.steer(input),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTerminal(state: string): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "lost";
}
