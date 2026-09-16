/** Canonical Runtime resume and Hosted execution boundary. */
import { randomUUID } from "node:crypto";
import { cancelActiveAgentCalls } from "@/lib/agents/calls/application/cancel-active-agent-calls";
import { aiConfig } from "@/lib/config";
import { getItemById } from "@/lib/conversations/thread-item-queries";
import { getTurnById } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { getEnvironmentRevisionById } from "@/lib/environment/environment-definition-store";
import { getEnvironmentLeaseByAttempt } from "@/lib/environment/environment-lease-store";
import type { EnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import { transitionInvocation } from "@/lib/executions/application/transition-invocation";
import { authorityIdentity } from "@/lib/executions/domain/execution-authority";
import { getAttemptById } from "@/lib/executions/persistence/attempt-store";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import {
  closeExecutionOwnership,
  getActiveExecutionOwnership,
  renewExecutionOwnership,
} from "@/lib/executions/persistence/execution-ownership-store";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { threadItemTable } from "@/lib/persistence/schema/conversation";
import {
  type ExecutionBinding,
  type Invocation,
  type InvocationAttempt,
  invocationAttemptTable,
} from "@/lib/persistence/schema/executions";
import {
  HostedHarnessLoop,
  type HostedHarnessLoopResult,
  type TransientEventBatchSink,
} from "@/lib/runtime/adapters/hosted-adapter";
import { buildRuntimeStartRequestForInvocation } from "@/lib/runtime/application/build-runtime-start-request";
import type {
  HostedRuntimeApplicationService,
  HostedRuntimeResumeResult,
} from "@/lib/runtime/application/hosted-runtime-application-service";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import {
  buildExecutionCredentials,
  startRuntimeInvocation,
} from "@/lib/runtime/application/runtime-start";
import { resolveOutboundRuntimeAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { buildGatewayEndpoints } from "@/lib/runtime/gateway-endpoints";
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
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import { getRuntimeSessionBindingByOwnership } from "@/lib/runtime/persistence/runtime-session-store";
import type { RuntimeHttpClient, RuntimeStartTransportRequest } from "@/lib/runtime/runtime-client";
import type { CallbackEndpoints, RuntimeStartResponse } from "@/lib/runtime/runtime-protocol";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { ingressTransientBatch } from "@/lib/runtime/transient-events";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import type { WorkspaceExecutionResources } from "@/lib/workspace/workspace-backend";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { and, desc, eq } from "drizzle-orm";

/** Formal Resume keeps the suspended Attempt but always creates a fresh ownership generation and SessionBinding. */
export async function resumeRuntimeInvocation(input: {
  tenantId: string;
  invocation: Invocation;
  binding: ExecutionBinding;
  attempt: InvocationAttempt;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpoint: string;
  auth: RuntimeStartTransportRequest["auth"];
  callbackEndpoints: CallbackEndpoints;
  checkpointId?: string;
  workspace?: WorkspaceExecutionResources;
  environmentProvisioner?: EnvironmentProvisioner;
  anchor: string;
  anchorDigest: string;
}): Promise<RuntimeStartResponse> {
  const invocation = await getInvocationById(input.tenantId, input.invocation.id);
  const attempt = await getAttemptById(input.attempt.id);
  // waiting_user = 受控暂停后的正式 Resume；running = UserAction resolve 事务已先落
  // Authority 的 post-authority Resume（凭证由 command-dispatcher 校验）。
  if (
    !invocation ||
    !["waiting_user", "running"].includes(invocation.executionState) ||
    !attempt ||
    attempt.invocationId !== input.invocation.id ||
    attempt.attemptState !== "suspended"
  ) {
    throw new Error("AttemptMismatch");
  }
  let environmentLease =
    input.binding.environmentMode === "MANAGED"
      ? await getEnvironmentLeaseByAttempt(input.tenantId, invocation.id, attempt.id)
      : null;
  if (
    input.binding.environmentMode === "MANAGED" &&
    (!environmentLease ||
      environmentLease.environmentDefinitionRevisionId !==
        input.binding.environmentDefinitionRevisionId ||
      environmentLease.readinessState !== "preparing" ||
      environmentLease.leaseState !== "active" ||
      !input.binding.environmentDefinitionRevisionId ||
      !input.environmentProvisioner)
  ) {
    throw new Error("EnvironmentRevisionMismatch");
  }
  if (
    environmentLease &&
    input.binding.environmentDefinitionRevisionId &&
    input.environmentProvisioner
  ) {
    const revision = await getEnvironmentRevisionById(
      input.tenantId,
      input.binding.environmentDefinitionRevisionId,
    );
    if (!revision || revision.id !== environmentLease.environmentDefinitionRevisionId) {
      throw new Error("EnvironmentRevisionMismatch");
    }
    environmentLease = await input.environmentProvisioner.revalidate({
      tenantId: input.tenantId,
      lease: environmentLease,
      revision,
      workspaceBindingId: input.binding.workspaceBindingId,
    });
    if (
      environmentLease.readinessState !== "prepared" ||
      environmentLease.leaseState !== "active"
    ) {
      throw new Error("EnvironmentComplianceFailed");
    }
  }
  const checkpointId = input.checkpointId ?? attempt.filesystemCheckpointId ?? undefined;
  const started = await startRuntimeInvocation({
    tenantId: input.tenantId,
    invocation,
    binding: input.binding,
    attempt,
    runtimeClient: input.runtimeClient,
    runtimeEndpoint: input.runtimeEndpoint,
    auth: input.auth,
    callbackEndpoints: input.callbackEndpoints,
    environmentLeaseId: environmentLease?.id ?? null,
    workspace: input.workspace,
    intentType: "resume",
    recovery: {
      kind: "resume",
      anchor: input.anchor,
      anchorDigest: input.anchorDigest,
      ...(checkpointId ? { checkpointId } : {}),
    },
  });
  return started.response;
}

export type HarnessResumeSourceType =
  | "hosted_start"
  | "user_action"
  | "user_pause"
  | "agent_call"
  | "tool_call";

interface HostedOverrides {
  decisionPort?: HarnessDecisionPort;
  finalResponsePort?: HarnessFinalResponsePort;
  actionExecutors?: HarnessActionExecutors;
  transientEventBatchSink?: TransientEventBatchSink;
  modelRef?: string;
}

const hostedOverrides = new Map<string, HostedOverrides>();
const liveRunners = new Map<
  string,
  { controller: AbortController; promise: Promise<HostedHarnessLoopResult> }
>();

async function loadCurrentAuthority(tenantId: string, invocationId: string) {
  const owner = await getActiveExecutionOwnership({ tenantId, invocationId });
  if (!owner) throw new Error("NotCurrentExecutor");
  const session = await getRuntimeSessionBindingByOwnership(tenantId, owner.id);
  if (!session || session.invocationId !== invocationId) throw new Error("RuntimeSessionMismatch");
  return {
    owner,
    session,
    authority: authorityIdentity({
      invocationId,
      runtimeRevisionId: session.runtimeRevisionId,
      attemptId: owner.attemptId,
      ownershipId: owner.id,
      leaseEpoch: owner.leaseEpoch,
      sessionBindingId: session.id,
    }),
  };
}

async function runHostedInvocation(input: {
  tenantId: string;
  invocation: Invocation;
  binding: ExecutionBinding;
  overrides?: HostedOverrides;
}): Promise<HostedHarnessLoopResult> {
  const current = await loadCurrentAuthority(input.tenantId, input.invocation.id);
  if (current.session.bindingState === "dispatching") {
    if (!current.session.semanticRequestDigest) throw new Error("RuntimeSessionMismatch");
    const capabilitiesDigest =
      current.session.transportAcknowledgement &&
      typeof current.session.transportAcknowledgement === "object" &&
      !Array.isArray(current.session.transportAcknowledgement) &&
      typeof (current.session.transportAcknowledgement as Record<string, unknown>)
        .capabilitiesDigest === "string"
        ? ((current.session.transportAcknowledgement as Record<string, unknown>)
            .capabilitiesDigest as string)
        : `sha256:${"0".repeat(64)}`;
    await ingressRuntimeEvents({
      tenantId: input.tenantId,
      invocationId: input.invocation.id,
      batch: {
        protocolVersion: 3,
        authority: current.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: String(input.invocation.lastProducerSequence + 1),
            type: "execution.started",
            schemaVersion: 1,
            payload: {
              intentKey: current.session.startIntentKey,
              semanticRequestDigest: current.session.semanticRequestDigest,
              remoteSessionRef:
                current.session.remoteSessionRef ?? `hosted-session:${current.session.id}`,
              remoteExecutionRef:
                current.session.remoteExecutionRef ??
                `hosted-execution:${input.invocation.id}:${current.owner.id}`,
              capabilitiesDigest,
            },
          },
        ],
      },
    });
  } else if (current.session.bindingState !== "active") {
    throw new Error("RuntimeSessionMismatch");
  }
  if (!input.invocation.threadId || !input.invocation.turnId) {
    return { completed: false, pending: true, responseText: "", sentEvents: [] };
  }
  const turn = await getTurnById(input.tenantId, input.invocation.turnId);
  if (!turn) throw new Error("Turn 不存在");
  const trigger = input.invocation.triggerItemId
    ? await getItemById(input.tenantId, input.invocation.triggerItemId)
    : null;
  const workspaceBinding = await getWorkspaceBindingById(
    input.tenantId,
    input.binding.workspaceBindingId,
  );
  if (!workspaceBinding) throw new Error("WorkspaceBinding 不存在");
  const workspace =
    workspaceBinding.continuityMode === "NO_PLATFORM_WORKSPACE"
      ? { mode: "NONE" as const }
      : {
          mode: "BOUND" as const,
          bindingId: workspaceBinding.id,
          contractDigest: workspaceBinding.contractDigest,
          continuityMode: workspaceBinding.continuityMode,
          activationEvidenceRef: `ownership:${current.owner.id}`,
        };
  const tokenFacts = {
    contractVersion: 3 as const,
    type: "execution" as const,
    tenantId: input.tenantId,
    ...current.authority,
    expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
  };
  const runtimeToken = issueWorkloadToken({ ...tokenFacts, audience: "runtime" });
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void renewExecutionOwnership({
      tenantId: input.tenantId,
      invocationId: input.invocation.id,
      ownershipId: current.owner.id,
      attemptId: current.owner.attemptId,
      leaseEpoch: current.owner.leaseEpoch,
    }).catch(() => controller.abort(new Error("OwnershipExpired")));
  }, 20_000);
  const loop = new HostedHarnessLoop({
    invocationId: input.invocation.id,
    authority: current.authority,
    tenantId: input.tenantId,
    threadId: input.invocation.threadId,
    turnId: input.invocation.turnId,
    inputItems: trigger ? [{ type: "user_message", content: trigger.contentJson }] : [],
    gatewayEndpoints: buildGatewayEndpoints({ external: false, invocationId: input.invocation.id }),
    runtimeEndpoint: "in-process://hosted",
    authToken: runtimeToken,
    workspace,
    executionLimits: {
      maxEventBytes: 262_144,
      maxBatchEvents: 100,
      maxBatchBytes: 1_048_576,
      dispatchDeadlineMs: 120_000,
      executionTimeoutMs: 600_000,
    },
    traceContext: { traceId: input.invocation.id, spanId: input.invocation.id },
    decisionPort:
      input.overrides?.decisionPort ??
      configuredDecisionPort(input.binding.modelId ?? aiConfig.chatModel),
    finalResponsePort:
      input.overrides?.finalResponsePort ??
      configuredFinalResponsePort(input.binding.modelId ?? aiConfig.chatModel),
    actionExecutors: input.overrides?.actionExecutors ?? {},
    recoveryPort: createMySqlHarnessLoopRecoveryPort(input.tenantId),
    ingressClient: {
      postEventBatch: async (invocationId, authority, events) => {
        await ingressRuntimeEvents({
          tenantId: input.tenantId,
          invocationId,
          batch: { protocolVersion: 3, authority, events },
        });
      },
    },
    transientEventBatchSink:
      input.overrides?.transientEventBatchSink ??
      (async ({ invocationId, transientSequenceStart, events }) => {
        // 默认 transient 通道：response.delta 等不持久化事件经正式 ingress 投影到
        // Thread transient 总线（SSE 订阅者），绝不黑洞。
        await ingressTransientBatch({
          tenantId: input.tenantId,
          invocationId,
          transientSequenceStart,
          events,
        });
      }),
    modelRef: input.overrides?.modelRef ?? input.binding.modelId,
    abortSignal: controller.signal,
    deadlineAt: new Date(Date.now() + 600_000),
  });
  const running = loop.run();
  liveRunners.set(input.invocation.id, { controller, promise: running });
  try {
    return await running;
  } finally {
    clearInterval(heartbeat);
    if (liveRunners.get(input.invocation.id)?.promise === running)
      liveRunners.delete(input.invocation.id);
  }
}

export async function resumeHarnessInvocation(input: {
  tenantId: string;
  invocationId: string;
  sourceType?: HarnessResumeSourceType;
  agentCallId: string;
  sourceVersion: number;
}): Promise<HostedRuntimeResumeResult> {
  const invocation = await getInvocationById(input.tenantId, input.invocationId);
  if (!invocation) throw new Error("Invocation 不存在");
  if (["completed", "failed", "cancelled", "lost"].includes(invocation.executionState))
    return { status: "handled_noop", invocationId: invocation.id };
  const binding = await getExecutionBindingByInvocation(input.tenantId, invocation.id);
  if (!binding) throw new Error("ExecutionBinding 不存在");
  const revision = await getRuntimeRevisionById(binding.runtimeRevisionId);
  if (!revision) throw new Error(`RuntimeRevision 不存在: ${binding.runtimeRevisionId}`);
  // External Runtime 的 Parent resume 必须经正式协议 POST 到外部端点；
  // in-process Hosted Loop 只服务 hosted_artifact Binding。
  if (revision.runtimeEvidenceKind === "external_endpoint") {
    await resumeExternalRuntime({
      tenantId: input.tenantId,
      invocation,
      binding,
      revision,
      idempotencyKey: `continuation-resume:${input.agentCallId}:${input.sourceVersion}`,
    });
    return {
      status: "resumed",
      invocationId: invocation.id,
      runtime: "external",
      completed: false,
      pending: true,
      waitingForUser: false,
    };
  }
  const result = await runHostedInvocation({
    tenantId: input.tenantId,
    invocation,
    binding,
    overrides: hostedOverrides.get(invocation.id),
  });
  return {
    status: "resumed",
    invocationId: invocation.id,
    runtime: "hosted",
    completed: result.completed,
    pending: result.pending,
    waitingForUser: result.waitingForUser,
  };
}

/** External Runtime 的 Parent resume：用冻结事实构造 canonical Resume 请求并 POST。 */
async function resumeExternalRuntime(input: {
  tenantId: string;
  invocation: Invocation;
  binding: ExecutionBinding;
  revision: NonNullable<Awaited<ReturnType<typeof getRuntimeRevisionById>>>;
  idempotencyKey: string;
}): Promise<void> {
  const current = await loadCurrentAuthority(input.tenantId, input.invocation.id);
  const endpoint = input.revision.endpointRef;
  const auth = await resolveOutboundRuntimeAuth({
    tenantId: input.tenantId,
    identityMode: input.revision.identityMode,
    credentialRefId: input.revision.credentialRefId,
  });
  const attempt = await getAttemptById(
    (await getLatestAttemptId(input.tenantId, input.invocation.id)) ?? "",
  );
  const anchor = attempt?.filesystemCheckpointId
    ? `checkpoint:${attempt.filesystemCheckpointId}`
    : `invocation:${input.invocation.id}:recovery:${input.invocation.recoveryVersion}`;
  const anchorDigest = attempt?.resumeAnchorDigest ?? protocolDigest(anchor);
  const { request } = await buildRuntimeStartRequestForInvocation({
    tenantId: input.tenantId,
    invocation: input.invocation,
    binding: input.binding,
    authority: current.authority,
    credentials: buildExecutionCredentials(input.tenantId, current.authority),
    runtimeEndpoint: endpoint,
    callbackEndpoints: buildGatewayEndpoints({
      external: true,
      invocationId: input.invocation.id,
    }),
    intentType: "resume",
    recovery: { kind: "resume", anchor, anchorDigest },
    activationEvidenceRef: `ownership:${current.owner.id}`,
    attempt: {
      producerSequenceStart: input.invocation.lastProducerSequence + 1,
      checkpointId: attempt?.filesystemCheckpointId ?? undefined,
      anchor,
      anchorDigest,
    },
  });
  const transport = createHttpHarnessRuntimeTransport({ endpoint, auth });
  await transport.resumeInvocation({
    runtimeEndpoint: endpoint,
    auth,
    idempotencyKey: input.idempotencyKey,
    request,
  });
}

async function getLatestAttemptId(tenantId: string, invocationId: string): Promise<string | null> {
  const attempts = await db
    .select({ id: invocationAttemptTable.id })
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.invocationId, invocationId))
    .orderBy(desc(invocationAttemptTable.createdAt));
  return attempts[0]?.id ?? null;
}

export const hostedRuntimeApplicationService: HostedRuntimeApplicationService = {
  start: (input) =>
    resumeHarnessInvocation({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      sourceType: "hosted_start",
      agentCallId: input.idempotencyKey,
      sourceVersion: 1,
    }),
  resume: (input) =>
    resumeHarnessInvocation({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      sourceType: "user_action",
      agentCallId: input.idempotencyKey,
      sourceVersion: 1,
    }),
  async cancel(input) {
    const live = liveRunners.get(input.invocationId);
    if (live) live.controller.abort(new Error(input.reason ?? "Invocation cancelled"));
    await cancelActiveAgentCalls({
      tenantId: input.tenantId,
      parentInvocationId: input.invocationId,
    });
    const invocation = await getInvocationById(input.tenantId, input.invocationId);
    if (
      !invocation ||
      ["completed", "failed", "cancelled", "lost"].includes(invocation.executionState)
    )
      return;
    const active = await getActiveExecutionOwnership({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
    });
    if (active)
      await closeExecutionOwnership({
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        ownershipId: active.id,
        state: "revoked",
        reasonCode: "cancel_requested",
      });
    await db.transaction((tx) =>
      transitionInvocation(tx, {
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        nextState: "cancelled",
        errorCode: "InvocationCancelled",
        errorSummary: input.reason ?? "cancel_requested",
      }),
    );
  },
  async steer(input) {
    const payload =
      input.steerPayload && typeof input.steerPayload === "object"
        ? (input.steerPayload as Record<string, unknown>)
        : {};
    const guidanceItemId = payload.guidanceItemId ?? payload.inputRef;
    if (typeof guidanceItemId !== "string") throw new Error("Steer 缺少 guidanceItemId");
    await db
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
  },
};

export function createConfiguredHostedRuntimeApplicationService(
  overrides: HostedOverrides,
): HostedRuntimeApplicationService {
  const wrap = async <T>(invocationId: string, work: () => Promise<T>): Promise<T> => {
    hostedOverrides.set(invocationId, overrides);
    try {
      return await work();
    } finally {
      hostedOverrides.delete(invocationId);
    }
  };
  return {
    start: (input) => wrap(input.invocationId, () => hostedRuntimeApplicationService.start(input)),
    resume: (input) =>
      wrap(input.invocationId, () => hostedRuntimeApplicationService.resume(input)),
    cancel: (input) => hostedRuntimeApplicationService.cancel(input),
    steer: (input) => hostedRuntimeApplicationService.steer(input),
  };
}
