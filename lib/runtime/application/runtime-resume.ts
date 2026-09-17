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
import { getAttemptById, getLatestAttempt } from "@/lib/executions/persistence/attempt-store";
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
  INVOCATION_ATTEMPT_TERMINAL_STATES,
  INVOCATION_TERMINAL_STATES,
  type Invocation,
  type InvocationAttempt,
  invocationAttemptTable,
} from "@/lib/persistence/schema/executions";
import {
  HostedHarnessLoop,
  type HostedHarnessLoopResult,
  type TransientEventBatchSink,
} from "@/lib/runtime/adapters/hosted-adapter";
import { resolveExecutionResources } from "@/lib/runtime/application/execution-resources";
import type {
  HostedRuntimeApplicationService,
  HostedRuntimeResumeResult,
} from "@/lib/runtime/application/hosted-runtime-application-service";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { startRuntimeInvocation } from "@/lib/runtime/application/runtime-start";
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
import {
  getRuntimeSessionBindingById,
  getRuntimeSessionBindingByOwnership,
} from "@/lib/runtime/persistence/runtime-session-store";
import type { RuntimeHttpClient, RuntimeStartTransportRequest } from "@/lib/runtime/runtime-client";
import type {
  AuthorityIdentity,
  CallbackEndpoints,
  RuntimeStartResponse,
} from "@/lib/runtime/runtime-protocol";
import { decimalStringToNumber, protocolDigest } from "@/lib/runtime/runtime-protocol";
import { ingressTransientBatch } from "@/lib/runtime/transient-events";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import type { WorkspaceExecutionResources } from "@/lib/workspace/workspace-backend";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { and, desc, eq } from "drizzle-orm";

/**
 * 正式 Resume 入口（R02 §7）。
 *
 * 前置只要求"该 Attempt 属于本 Invocation 且非终态"：
 * - 用户暂停后的受控恢复 = `suspended` Attempt（**用户暂停恢复命令**的契约，由
 *   `command-dispatcher` 在调度前显式校验）；
 * - 子调用等待后的 continuation 唤醒 = 同一代际的存活 Supervisor，Attempt 仍在
 *   queued/running，"子调用 pending 不等于人工暂停"，不得因此拒绝重放原意图。
 */
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
    INVOCATION_ATTEMPT_TERMINAL_STATES.includes(attempt.attemptState)
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
      !["prepared", "ready"].includes(environmentLease.readinessState) ||
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
      revisionId: revision.id,
      revision,
      workspaceBindingId: input.binding.workspaceBindingId,
      workspaceRoot: input.workspace?.root ?? null,
      recoveryAnchorDigest: input.anchorDigest ?? null,
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
    environmentProvisioner: input.environmentProvisioner ?? null,
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

/**
 * R02 §2：每个 Ownership generation 在**本进程内**的活跃 Supervisor 索引。
 *
 * 它只索引「已由持久状态授权」的活任务：键是 Ownership id，进入前会先按权威 tuple 复核
 * 该代际仍是当前 active Owner（`loadAuthorityFromTuple`）。去重的持久来源始终是
 * `RuntimeSessionBinding.bindingState` + Ownership 事实，这张表只避免同代际起第二个 Loop。
 */
type LiveRunner = {
  controller: AbortController;
  promise: Promise<HostedHarnessLoopResult> | null;
};
const liveRunners = new Map<string, LiveRunner>();

/**
 * R02 §2：按 Start/Resume **携带的准确 authority** 复核当前状态。
 *
 * 不允许「收到旧 Start 后按 invocationId 重新加载当前 Owner 再运行」：
 * 请求里的 (attemptId, ownershipId, leaseEpoch, sessionBindingId, runtimeRevisionId)
 * 必须逐项匹配当前 Owner 与该 Ownership 的唯一 Session，否则 fail closed。
 */
async function loadAuthorityFromTuple(tenantId: string, authority: AuthorityIdentity) {
  const owner = await getActiveExecutionOwnership({
    tenantId,
    invocationId: authority.invocationId,
  });
  if (
    !owner ||
    owner.id !== authority.ownershipId ||
    owner.attemptId !== authority.attemptId ||
    owner.leaseEpoch !== decimalStringToNumber(authority.leaseEpoch)
  ) {
    throw new Error("NotCurrentExecutor");
  }
  const session = await getRuntimeSessionBindingById(tenantId, authority.sessionBindingId);
  if (
    !session ||
    session.invocationId !== authority.invocationId ||
    session.ownershipId !== owner.id ||
    session.attemptId !== authority.attemptId ||
    session.leaseEpoch !== decimalStringToNumber(authority.leaseEpoch) ||
    session.runtimeRevisionId !== authority.runtimeRevisionId
  ) {
    throw new Error("RuntimeSessionMismatch");
  }
  return { owner, session, authority };
}

async function runHostedInvocation(input: {
  tenantId: string;
  invocation: Invocation;
  binding: ExecutionBinding;
  /** R02 §2：Hosted 启动必须携带 Start/Resume 的准确 authority 与 Session 启动身份。 */
  authority: AuthorityIdentity;
  overrides?: HostedOverrides;
}): Promise<HostedHarnessLoopResult> {
  const current = await loadAuthorityFromTuple(input.tenantId, input.authority);
  const runnerKey = current.owner.id;
  // R02 §2：相同 generation 最多一个 Supervisor 运行用户任务。重复交付的 Start（丢 ACK
  // 重发）或重复唤醒不得再起第二个 Loop —— 直接回答"该代际仍在跑"。
  if (liveRunners.has(runnerKey)) {
    return { completed: false, pending: true, responseText: "", sentEvents: [] };
  }
  // 同步占位：检查与写入之间不能有 await，否则并发交付会各自越过检查各起一个 Loop。
  const slot: LiveRunner = { controller: new AbortController(), promise: null };
  liveRunners.set(runnerKey, slot);
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  try {
    if (current.session.bindingState === "dispatching") {
      if (!current.session.semanticRequestDigest) throw new Error("RuntimeSessionMismatch");
      // R02 §3：capability 摘要的唯一比对源是发布证据（Session 冻结了 RuntimeRevision
      // 引用与其能力 JSON，故摘要恒可重算）。**不再**回落到零摘要。
      const capabilitiesDigest = expectedCapabilityManifestDigest({
        runtimeRevisionId: current.session.runtimeRevisionId,
        runtimeCapabilitiesJson: current.session.runtimeCapabilitiesJson,
      });
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
    // R01 §5：Hosted 的默认 Action Executors 必须由 Binding 冻结的能力目录装配，
    // 不能默认 `{}`（那会把已有 Tool/Agent/Knowledge 工作回归成纯文本回答）。
    const actionExecutors =
      input.overrides?.actionExecutors ??
      (
        await resolveExecutionResources({
          tenantId: input.tenantId,
          binding: input.binding,
          purpose: "resume",
        })
      ).actionExecutors;
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
    const controller = slot.controller;
    heartbeat = setInterval(() => {
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
      gatewayEndpoints: buildGatewayEndpoints({
        external: false,
        invocationId: input.invocation.id,
      }),
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
      actionExecutors,
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
    slot.promise = running;
    return await running;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    // 只清理自己占的槽位：代际被替换后新 Supervisor 已占位时不得误删。
    if (liveRunners.get(runnerKey) === slot) liveRunners.delete(runnerKey);
  }
}

/**
 * R02 §2：Hosted 分支的 authority 是**必需**输入。缺失或与 Invocation/Binding 不符即 fail closed。
 */
function requireHostedAuthority(
  authority: AuthorityIdentity | undefined,
  invocationId: string,
  runtimeRevisionId: string,
): AuthorityIdentity {
  if (!authority) throw new Error("RuntimeSessionMismatch");
  if (
    authority.invocationId !== invocationId ||
    authority.runtimeRevisionId !== runtimeRevisionId
  ) {
    throw new Error("RuntimeSessionMismatch");
  }
  return authority;
}

export async function resumeHarnessInvocation(input: {
  tenantId: string;
  invocationId: string;
  sourceType?: HarnessResumeSourceType;
  agentCallId: string;
  sourceVersion: number;
  /**
   * R02 §2：Hosted 分支必须由调用方（Hosted Adapter）给出 Start/Resume 携带的准确
   * authority 与 Session 启动身份，运行期只复核该代际，不按 invocationId 跟随 current。
   */
  authority?: AuthorityIdentity;
}): Promise<HostedRuntimeResumeResult> {
  const invocation = await getInvocationById(input.tenantId, input.invocationId);
  if (!invocation) throw new Error("Invocation 不存在");
  if (INVOCATION_TERMINAL_STATES.includes(invocation.executionState))
    return { status: "handled_noop", invocationId: invocation.id };
  const binding = await getExecutionBindingByInvocation(input.tenantId, invocation.id);
  if (!binding) throw new Error("ExecutionBinding 不存在");
  const revision = await getRuntimeRevisionById(binding.runtimeRevisionId);
  if (!revision) throw new Error(`RuntimeRevision 不存在: ${binding.runtimeRevisionId}`);
  // External Runtime 的 Parent resume 同样必须经正式 Start 服务（`runtime-resume`）进入，
  // 由 Session 冻结稳定启动意图；in-process Hosted Loop 只服务 hosted_artifact Binding。
  if (revision.runtimeEvidenceKind === "external_endpoint") {
    const attempt = await getLatestAttempt(invocation.id);
    if (!attempt || INVOCATION_ATTEMPT_TERMINAL_STATES.includes(attempt.attemptState)) {
      throw new Error("AttemptMismatch");
    }
    const endpoint = revision.endpointRef;
    const auth = await resolveOutboundRuntimeAuth({
      tenantId: input.tenantId,
      identityMode: revision.identityMode,
      credentialRefId: revision.credentialRefId,
    });
    const anchor = attempt.filesystemCheckpointId
      ? `checkpoint:${attempt.filesystemCheckpointId}`
      : `invocation:${invocation.id}:recovery:${invocation.recoveryVersion}`;
    await resumeRuntimeInvocation({
      tenantId: input.tenantId,
      invocation,
      binding,
      attempt,
      runtimeClient: createHttpHarnessRuntimeTransport({ endpoint, auth }),
      runtimeEndpoint: endpoint,
      auth,
      callbackEndpoints: buildGatewayEndpoints({
        external: true,
        invocationId: invocation.id,
      }),
      anchor,
      anchorDigest: attempt.resumeAnchorDigest ?? protocolDigest(anchor),
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
    // R02 §2：没有准确 authority 就不能启动 Hosted 执行——绝不回落到「按 invocationId
    // 加载当前 Owner」，那会让旧 Start 驱动新代际运行。
    authority: requireHostedAuthority(input.authority, invocation.id, binding.runtimeRevisionId),
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

export const hostedRuntimeApplicationService: HostedRuntimeApplicationService = {
  start: (input) =>
    resumeHarnessInvocation({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      sourceType: "hosted_start",
      agentCallId: input.idempotencyKey,
      sourceVersion: 1,
      authority: input.authority,
    }),
  resume: (input) =>
    resumeHarnessInvocation({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      sourceType: "user_action",
      agentCallId: input.idempotencyKey,
      sourceVersion: 1,
      authority: input.authority,
    }),
  async cancel(input) {
    // R03 §6：Cancel 只针对**请求携带的目标代际**关门。旧目标的 Cancel 既不能停掉
    // 新代际的 Supervisor，也不能把新代际的 Ownership 撤销掉。
    const current = await loadAuthorityFromTuple(input.tenantId, input.authority).catch(() => null);
    if (!current) return; // 目标代际已失效：无副作用，不重定向到当前 Owner。
    const live = liveRunners.get(current.owner.id);
    if (live) live.controller.abort(new Error(input.reason ?? "Invocation cancelled"));
    await cancelActiveAgentCalls({
      tenantId: input.tenantId,
      parentInvocationId: input.invocationId,
    });
    await closeExecutionOwnership({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      ownershipId: current.owner.id,
      attemptId: current.owner.attemptId,
      leaseEpoch: current.owner.leaseEpoch,
      state: "revoked",
      reasonCode: "cancel_requested",
    });
    const invocation = await getInvocationById(input.tenantId, input.invocationId);
    if (!invocation || INVOCATION_TERMINAL_STATES.includes(invocation.executionState)) return;
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
    // R03 §6：Steer 只对目标代际的 pending guidance 生效；代际已失效即空操作，
    // 不把旧命令的引导投递给新 Owner。
    const current = await loadAuthorityFromTuple(input.tenantId, input.authority).catch(() => null);
    if (!current) return;
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
