/** Canonical dispatcher for thread executions. */
import { randomUUID } from "node:crypto";
import { aiConfig, runtimeConfig } from "@/lib/config";
import { allocateEventSequences } from "@/lib/conversations/thread-queries";
import { getTurnById } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import {
  getEnvironmentDefinitionById,
  getEnvironmentRevisionById,
} from "@/lib/environment/environment-definition-store";
import type { EnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import { createDefaultEnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import { getPendingEnvironmentSelection } from "@/lib/environment/environment-selection";
import {
  type CreateExecutionBindingCommand,
  createCreateExecutionBinding,
} from "@/lib/executions/application/create-execution-binding";
import { resolveBindingGovernance } from "@/lib/executions/application/resolve-binding-governance";
import { createAttempt } from "@/lib/executions/persistence/attempt-store";
import { createInvocation, getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { mysqlExecutionBindingStore } from "@/lib/executions/persistence/mysql-execution-binding-store";
import {
  type ThreadEvent,
  type ThreadEventActorType,
  type Turn,
  threadEventTable,
  threadTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import type { EnvironmentDefinitionRevision } from "@/lib/persistence/schema/environment-definition-revision";
import type {
  ExecutionBinding,
  Invocation,
  InvocationAttempt,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import type { RouteResolutionAttribute } from "@/lib/routes/domain/route-resolution-policy";
import { createConfiguredRouteResolver } from "@/lib/routes/infrastructure/configured-route-resolver";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { startRuntimeInvocation } from "@/lib/runtime/application/runtime-start";
import type { RuntimeTransportAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { DispatchTurnStateError, RuntimeHttpClientError } from "@/lib/runtime/errors";
import { buildProductionCapabilityCatalog } from "@/lib/runtime/harness-loop/build-production-capability-catalog";
import {
  type RuntimeRouteResolution,
  resolveExecutionPlan,
} from "@/lib/runtime/resolve-execution-plan";
import { recordAttemptDispatchTransientFailure } from "@/lib/runtime/retry/dispatch-retry-queries";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import type { CallbackEndpoints, RuntimeStartResponse } from "@/lib/runtime/runtime-protocol";
import {
  type ExecutionSubject,
  freezeTrustedExecutionSubject,
} from "@/lib/runtime/transport/execution-subject";
import { resolveWorkspaceBindingId } from "@/lib/workspace/desktop-workspace-queries";
import type {
  WorkspaceBackend,
  WorkspaceExecutionResources,
} from "@/lib/workspace/workspace-backend";
import { createNoPlatformWorkspaceBinding } from "@/lib/workspace/workspace-binding-store";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { and, eq } from "drizzle-orm";

export const DEFAULT_ROUTE_SCOPE_KEY = "default";

const configuredResolver = createConfiguredRouteResolver({
  projectionStore: mysqlRouteEligibilityResolutionStore,
});
const defaultRouteResolver: RouteResolver = async (input) =>
  (
    await configuredResolver({
      tenantId: input.tenantId,
      target: input.target,
      routeScopeKey: input.routeScopeKey,
      businessKey: input.businessKey,
      attributes: input.attributes,
      threadDefaultModelRef: input.threadDefaultModelRef,
    })
  ).outcome;
const createExecutionBinding = createCreateExecutionBinding({ store: mysqlExecutionBindingStore });

export interface RuntimeEndpointResolution {
  runtimeEndpoint: string;
  auth: RuntimeTransportAuth;
  callbackEndpoints: CallbackEndpoints;
  environmentProvisioner?: EnvironmentProvisioner;
  workspace?: WorkspaceExecutionResources;
}

export interface RuntimeDispatchResult {
  response?: RuntimeStartResponse;
  sessionBinding?: RuntimeSessionBinding;
  sessionBindingCreated: boolean;
  skipped?: boolean;
  skipReason?: "runtime_network_unavailable" | "runtime_unavailable";
}

export interface DispatchResult {
  dispatched: boolean;
  reason?:
    | "no_effective_route"
    | "ambiguous_route_configuration"
    | "invalid_traffic_weight_total"
    | "agent_revision_not_found";
  invocation?: Invocation;
  binding?: ExecutionBinding;
  routeResolution?: RuntimeRouteResolution;
  attempt?: InvocationAttempt;
  turn?: Turn;
  invocationQueuedEvent?: ThreadEvent | null;
  turnQueuedEvent?: ThreadEvent;
  runtimeDispatch?: RuntimeDispatchResult;
}

/** Creates the canonical Invocation → Binding → Attempt chain and queues the Turn. */
export async function dispatchInvocationForTurn(params: {
  tenantId: string;
  turnId: string;
  routeScopeKey?: string;
  routeAttributes?: Record<string, RouteResolutionAttribute>;
  selectedModelRef?: string;
  routeResolver?: RouteResolver;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
  runtimeClient?: RuntimeHttpClient;
  runtimeEndpointResolver?: (binding: ExecutionBinding) => Promise<RuntimeEndpointResolution>;
  runtimeIdempotencyKey?: string;
  executionSubject: ExecutionSubject;
  /**
   * T33：本次 Invocation 显式选择的初始压缩材料（同 tenant 的 compression ContextCheckpoint）。
   *
   * 缺省/null = 不选择；不允许「自动取最新 Checkpoint」。同一 Invocation 的
   * Start 网络重试复用已冻结的 Binding，不会重新挑选。
   */
  initialContextCheckpointId?: string | null;
  environmentProvisioner?: EnvironmentProvisioner;
  workspaceBackendResolver?: (
    binding: WorkspaceBinding,
  ) => Promise<Omit<WorkspaceExecutionResources, "binding">>;
}): Promise<DispatchResult> {
  const actorType = params.actorType ?? "system";
  // Trusted subject 是 dispatch contract 的入口校验：在任何 Turn/DB 事实读取之前
  // 先冻结，缺失或跨租户主体直接 TrustedExecutionSubjectError（不产生任何副作用）。
  const frozenPrincipal = freezeTrustedExecutionSubject(params.executionSubject, params.tenantId);
  const turn = await getTurnById(params.tenantId, params.turnId);
  if (!turn) throw new DispatchTurnStateError(params.turnId, "not_found");
  if (turn.turnState !== "accepted")
    throw new DispatchTurnStateError(params.turnId, turn.turnState);
  const [thread] = await db
    .select()
    .from(threadTable)
    .where(and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, turn.threadId)))
    .limit(1);
  if (!thread) throw new DispatchTurnStateError(params.turnId, "thread_not_found");
  const plan = await resolveExecutionPlan(
    {
      tenantId: params.tenantId,
      routeScopeKey: params.routeScopeKey ?? DEFAULT_ROUTE_SCOPE_KEY,
      businessKey: { threadId: thread.id },
      attributes: params.routeAttributes ?? {},
      threadDefaultModelRef: params.selectedModelRef ?? thread.defaultModelRef,
      platformDefaultModelRef: aiConfig.chatModel,
      routeResolver: params.routeResolver,
    },
    defaultRouteResolver,
  );
  if (!plan.resolved) return { dispatched: false, reason: plan.reason };

  const resolvedWorkspaceBindingId = thread.defaultWorkspaceId
    ? await resolveWorkspaceBindingId(
        params.tenantId,
        thread.defaultWorkspaceId,
        thread.ownerUserId,
      )
    : null;
  // 桌面绑定冻结：Thread 固定的 Workspace 事实不回滚。设备撤销/绑定失效只降级
  // Workspace 能力（catalog 记 unavailableFacts），不阻断基础聊天调度。
  const workspaceUnavailable = Boolean(thread.defaultWorkspaceId) && !resolvedWorkspaceBindingId;
  // ExecutionBinding 冻结「本执行实际使用的 Workspace 事实」：Turn 调度不携带平台
  // Workspace writer（工具写文件由 capability action 执行期按需 fence），按冻结设计
  // （schema-design §ExecutionBinding.workspaceBindingId「不使用文件也引用显式
  // NO_PLATFORM_WORKSPACE 契约」）引用显式 NO_PLATFORM 契约 Binding；只有调用方
  // 提供 WorkspaceBackendResolver（执行携带 writer）时才引用 resolved Binding。
  // Thread 的桌面绑定事实不回滚，能力可用性由 catalog unavailableFacts 冻结。
  const workspaceBindingId =
    resolvedWorkspaceBindingId && params.workspaceBackendResolver
      ? resolvedWorkspaceBindingId
      : (await createNoPlatformWorkspaceBinding(params.tenantId, frozenPrincipal.principalId)).id;
  const environmentRevision = await resolveEnvironmentRevisionForInvocation(
    params.tenantId,
    thread.id,
    thread.defaultEnvironmentDefinitionId,
  );
  const workspaceBinding = await getWorkspaceBindingById(params.tenantId, workspaceBindingId);
  if (!workspaceBinding) throw new Error("WorkspaceBinding 不存在，无法证明 Workspace Continuity");
  const invocationResult = await createInvocation({
    tenantId: params.tenantId,
    threadId: thread.id,
    turnId: turn.id,
    invocationKind: "initial",
    triggerItemId: turn.triggerItemId ?? null,
    actorType,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
  });
  const invocation = invocationResult.invocation;
  const projectionVersionNo = plan.routeResolution.projectionVersionNo;
  if (!Number.isInteger(projectionVersionNo) || projectionVersionNo < 0)
    throw new Error("RouteResolution 缺少有效 projectionVersionNo");
  const governance = await resolveBindingGovernance(
    db,
    params.tenantId,
    plan.routeResolution.policyRevisionId,
  );
  const { kind: _kind, ...runtimeEvidence } = plan.routeResolution.controlPlaneEvidence;
  const catalog = await buildProductionCapabilityCatalog({
    tenantId: params.tenantId,
    invocationId: invocation.id,
    threadId: thread.id,
    // Catalog 冻结「工具能力可用性事实」：shell 执行目标按 Thread 绑定的真实
    // Workspace Binding 解析（设备撤销时由 workspaceUnavailable 显式排除）；
    // ExecutionBinding 的 NO_PLATFORM 契约引用只表达执行不携带 writer。
    workspaceBindingId: resolvedWorkspaceBindingId,
    preferredAgentId: turn.agentUseMode === "preferred" ? (turn.preferredAgentId ?? null) : null,
    runtimeRevisionId: plan.runtimeRevisionId,
    policyRevisionId: governance.policyRevisionId,
    policyRulesDigest: governance.policyRulesDigest,
    executionSubject: params.executionSubject,
    workspaceUnavailable,
    resolveRoute: params.routeResolver ?? defaultRouteResolver,
    routeScopeKey: params.routeScopeKey ?? DEFAULT_ROUTE_SCOPE_KEY,
  });
  const bindingCommand: CreateExecutionBindingCommand = {
    invocationId: invocation.id,
    tenantId: params.tenantId,
    runtimeRevisionId: plan.runtimeRevisionId,
    deploymentRouteId: plan.routeResolution.deploymentRouteId,
    modelProvider: plan.modelInfo.modelProvider,
    modelId: plan.modelInfo.modelId,
    modelRevisionRef: plan.modelInfo.modelRevisionRef,
    workspaceBindingId,
    policyRevisionId: governance.policyRevisionId,
    policyRulesDigest: governance.policyRulesDigest,
    governanceConfigRevisionId: governance.governanceConfigRevisionId,
    governanceConfigDigest: governance.governanceConfigDigest,
    environmentDefinitionRevisionId: environmentRevision?.id ?? null,
    environmentMode: environmentRevision ? "MANAGED" : "NO_PLATFORM_ENVIRONMENT",
    capabilityCatalogJson: catalog.snapshot,
    capabilityCatalogDigest: catalog.digest,
    capabilityCatalogVersion: catalog.version,
    capabilityCatalogSourceRefs: catalog.sourceRefs,
    capabilityCatalogCreatedAt: catalog.createdAt,
    // T33：显式选择的初始压缩材料；由 create-execution-binding 真实核验后冻结。
    initialContextCheckpointId: params.initialContextCheckpointId ?? null,
    ...frozenPrincipal,
    projectionVersionNo,
    controlPlaneEvidence: {
      routeRevisionId: plan.routeResolution.routeRevisionId,
      routeActivationId: plan.routeResolution.routeActivationId,
      routeContentDigest: plan.routeResolution.routeContentDigest,
      resolutionInputDigest: plan.routeResolution.resolutionInputDigest,
      ...runtimeEvidence,
    },
  };
  const binding = await createExecutionBinding(bindingCommand);
  const endpoint =
    params.runtimeClient && params.runtimeEndpointResolver
      ? await params.runtimeEndpointResolver(binding)
      : null;
  const environmentProvisioner = params.environmentProvisioner ?? endpoint?.environmentProvisioner;
  if (environmentRevision && !environmentProvisioner) {
    throw new Error("EnvironmentComplianceFailed: 未配置受管 EnvironmentProvisioner");
  }
  let workspaceResources: WorkspaceExecutionResources | undefined;
  if (workspaceBinding.continuityMode !== "NO_PLATFORM_WORKSPACE") {
    if (endpoint?.workspace) {
      if (endpoint.workspace.binding.id !== workspaceBinding.id)
        throw new Error("WorkspaceNotReady");
      workspaceResources = endpoint.workspace;
    } else if (params.workspaceBackendResolver) {
      workspaceResources = {
        binding: workspaceBinding,
        ...(await params.workspaceBackendResolver(workspaceBinding)),
      };
    }
    // 无受管 WorkspaceBackend 时按 Binding 冻结事实启动（桌面绑定冻结语义）；
    // Workspace Writer/准备证据由 capability action 执行期按需取得，
    // 不在 dispatch 处阻断基础聊天。
  }
  const attempt = await createAttempt({ invocationId: invocation.id, tenantId: params.tenantId });
  const resolvedEnvironmentProvisioner =
    environmentProvisioner ??
    (environmentRevision
      ? createDefaultEnvironmentProvisioner({ runtimeType: runtimeConfig.defaultType })
      : null);
  const environmentLease =
    environmentRevision && resolvedEnvironmentProvisioner
      ? await resolvedEnvironmentProvisioner.provision({
          tenantId: params.tenantId,
          invocationId: invocation.id,
          attemptId: attempt.id,
          // 只从 Binding 冻结的 Revision 读取执行语义（R07 §1）。
          revisionId: environmentRevision.id,
          revision: environmentRevision,
          workspaceBindingId,
          workspaceRoot: workspaceResources?.root ?? null,
          recoveryAnchorDigest: null,
        })
      : null;
  const transition = await transitionTurnToQueued({
    threadId: thread.id,
    turn,
    invocationId: invocation.id,
    actorType,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
  });

  let runtimeDispatch: RuntimeDispatchResult | undefined;
  if (params.runtimeClient && endpoint) {
    try {
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
        workspace: workspaceResources,
      });
      runtimeDispatch = {
        response: started.response,
        sessionBinding: await loadSession(params.tenantId, started.sessionBindingId),
        sessionBindingCreated: true,
      };
    } catch (error) {
      if (error instanceof RuntimeHttpClientError && error.retryable) {
        const skipReason =
          error.kind === "network" ? "runtime_network_unavailable" : "runtime_unavailable";
        // 暂态失败只排定 durable retry（SessionBinding 承载稳定启动意图的重试事实），
        // 绝不 fallback Hosted、绝不丢失 Attempt 重试状态。
        await recordAttemptDispatchTransientFailure({
          attemptId: attempt.id,
          errorCode: skipReason,
          now: new Date(),
          counted: true,
        });
        runtimeDispatch = {
          sessionBindingCreated: true,
          skipped: true,
          skipReason,
        };
      } else throw error;
    }
  }
  return {
    dispatched: true,
    invocation: (await getInvocationById(params.tenantId, invocation.id)) ?? invocation,
    binding,
    routeResolution: plan.routeResolution,
    attempt,
    turn: (await getTurnById(params.tenantId, params.turnId)) ?? transition.turn,
    invocationQueuedEvent: invocationResult.event,
    turnQueuedEvent: transition.event,
    runtimeDispatch,
  };
}

async function resolveEnvironmentRevisionForInvocation(
  tenantId: string,
  threadId: string,
  environmentDefinitionId: string | null,
): Promise<EnvironmentDefinitionRevision | null> {
  if (!environmentDefinitionId) return null;
  const definition = await getEnvironmentDefinitionById(tenantId, environmentDefinitionId);
  if (!definition || definition.lifecycleState !== "active")
    throw new Error("EnvironmentRevisionUnavailable");
  const pending = await getPendingEnvironmentSelection(tenantId, threadId);
  const revisionId = pending?.requestedRevisionId ?? definition.currentRevisionId;
  if (!revisionId) throw new Error("EnvironmentRevisionUnavailable");
  const revision = await getEnvironmentRevisionById(tenantId, revisionId);
  if (!revision || revision.definitionId !== definition.id)
    throw new Error("EnvironmentRevisionUnavailable");
  return revision;
}

async function loadSession(
  tenantId: string,
  id: string,
): Promise<RuntimeSessionBinding | undefined> {
  const { getRuntimeSessionBindingById } = await import(
    "@/lib/runtime/persistence/runtime-session-store"
  );
  return (await getRuntimeSessionBindingById(tenantId, id)) ?? undefined;
}

async function transitionTurnToQueued(params: {
  threadId: string;
  turn: Turn;
  invocationId: string;
  actorType: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<{ turn: Turn; event: ThreadEvent }> {
  const eventSequence = await db.transaction(async (tx) => {
    await tx
      .select({ id: threadTable.id })
      .from(threadTable)
      .where(eq(threadTable.id, params.threadId))
      .for("update")
      .limit(1);
    const sequence = await allocateEventSequences(tx, params.threadId, 1);
    const update = await tx
      .update(turnTable)
      .set({
        turnState: "queued",
        activeInvocationId: params.invocationId,
        latestInvocationId: params.invocationId,
        versionNo: params.turn.versionNo + 1,
      })
      .where(and(eq(turnTable.id, params.turn.id), eq(turnTable.versionNo, params.turn.versionNo)));
    if (update[0].affectedRows === 0)
      throw new DispatchTurnStateError(params.turn.id, "concurrent_update");
    const now = new Date();
    await tx.insert(threadEventTable).values({
      id: randomUUID(),
      threadId: params.threadId,
      eventSequence: sequence,
      eventType: "turn.queued",
      schemaVersion: 1,
      turnId: params.turn.id,
      invocationId: params.invocationId,
      actorType: params.actorType,
      actorId: params.actorId ?? null,
      payloadJson: { invocation_id: params.invocationId },
      correlationId: params.correlationId ?? null,
      occurredAt: now,
      ingestedAt: now,
    });
    return sequence;
  });
  const [turn] = await db.select().from(turnTable).where(eq(turnTable.id, params.turn.id)).limit(1);
  const [event] = await db
    .select()
    .from(threadEventTable)
    .where(
      and(
        eq(threadEventTable.threadId, params.threadId),
        eq(threadEventTable.eventSequence, eventSequence),
      ),
    )
    .limit(1);
  if (!turn || !event) throw new Error("Turn queued 事实回读失败");
  return { turn, event };
}

export async function dispatchAcceptedTurn(params: {
  tenantId: string;
  threadId: string;
  executionSubject: ExecutionSubject;
  routeScopeKey?: string;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<DispatchResult[]> {
  const turns = await db
    .select()
    .from(turnTable)
    .innerJoin(threadTable, eq(threadTable.id, turnTable.threadId))
    .where(
      and(
        eq(threadTable.tenantId, params.tenantId),
        eq(turnTable.threadId, params.threadId),
        eq(turnTable.turnState, "accepted"),
      ),
    )
    .then((rows) => rows.map((row) => row.Turn));
  const results: DispatchResult[] = [];
  for (const turn of turns)
    results.push(await dispatchInvocationForTurn({ ...params, turnId: turn.id }));
  return results;
}
