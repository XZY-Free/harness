/** Canonical dispatcher for thread executions. */
import { randomUUID } from "node:crypto";
import { aiConfig } from "@/lib/config";
import { allocateEventSequences } from "@/lib/conversations/thread-queries";
import { getTurnById } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import {
  type EnvironmentProvisioner,
  environmentProvisionRequestDigest,
} from "@/lib/environment/environment-provisioner";
import { recordEnvironmentSelectionFirstApplied } from "@/lib/environment/environment-selection";
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
import type {
  ExecutionBinding,
  Invocation,
  InvocationAttempt,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import type { RouteResolutionAttribute } from "@/lib/routes/domain/route-resolution-policy";
import {
  canonicalRouteResolver,
  resolveExecutionResources,
} from "@/lib/runtime/application/execution-resources";
import { startRuntimeInvocation } from "@/lib/runtime/application/runtime-start";
import {
  assertDeclaredWorkspaceReady,
  resolveEnvironmentRevisionForInvocation,
  resolveThreadWorkspaceFacts,
} from "@/lib/runtime/application/thread-execution-context";
import type { RuntimeTransportAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { DispatchTurnStateError, RuntimeHttpClientError } from "@/lib/runtime/errors";
import { buildProductionCapabilityCatalog } from "@/lib/runtime/harness-loop/build-production-capability-catalog";
import {
  type RuntimeRouteResolution,
  resolveExecutionPlan,
} from "@/lib/runtime/resolve-execution-plan";
import {
  recordAttemptDispatchTransientFailure,
  sessionDispatchIdentityForAttempt,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import type { CallbackEndpoints, RuntimeStartResponse } from "@/lib/runtime/runtime-protocol";
import {
  type ExecutionSubject,
  freezeTrustedExecutionSubject,
} from "@/lib/runtime/transport/execution-subject";
import type { WorkspaceExecutionResources } from "@/lib/workspace/workspace-backend";
import { createNoPlatformWorkspaceBinding } from "@/lib/workspace/workspace-binding-store";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { and, eq } from "drizzle-orm";

export const DEFAULT_ROUTE_SCOPE_KEY = "default";

/** 正式 Route Resolver 的唯一实例来自组合层（R01 §1），此处不另建一份。 */
const defaultRouteResolver: RouteResolver = canonicalRouteResolver;
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
  /**
   * 受管 Environment Backend 的**边界适配器**（部署/测试注入）。
   * 缺省由唯一组合层给出生产默认；它不是"是否携带 Workspace/Environment"的开关。
   */
  environmentProvisioner?: EnvironmentProvisioner;
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

  const { workspaceBindingId: resolvedWorkspaceBindingId, workspaceUnavailable } =
    await resolveThreadWorkspaceFacts(params.tenantId, thread);
  const environment = await resolveEnvironmentRevisionForInvocation(
    params.tenantId,
    thread.id,
    thread.defaultEnvironmentDefinitionId,
  );
  const environmentRevision = environment.revision;
  // ExecutionBinding 冻结「本执行实际使用的 Workspace 事实」（R01 §1）。
  //
  // 不再存在 `resolvedWorkspaceBindingId && workspaceBackendResolver ? real : NONE` 降级：
  // 引用哪一份 Workspace 合同只由**冻结契约**决定，不由某个注入项是否存在决定。
  // - NO_PLATFORM_ENVIRONMENT ⇒ WorkspaceBinding 必须是显式 NO_PLATFORM_WORKSPACE 合同
  //   （schema-design §ExecutionBinding SERVICE 约束），与平台环境成对。
  // - MANAGED 且 Thread 有真实 Workspace 绑定 ⇒ 引用该真实合同；Workspace 执行资源由
  //   唯一组合层解析，解析不出即 `WorkspaceNotReady`（保留可恢复失败事实），绝不静默
  //   退化成一个"引用真实 Workspace 却没有 Writer"的 Binding。
  // 声明的 Workspace 解析不出正式合同时 MANAGED 执行必须 fail closed（R01 §1 / R07 §4），
  // 不允许在下面被静默替换成 NO_PLATFORM_WORKSPACE 合同。
  assertDeclaredWorkspaceReady({
    environmentRevisionId: environmentRevision?.id ?? null,
    workspaceUnavailable,
  });
  const workspaceBindingId =
    environmentRevision && resolvedWorkspaceBindingId
      ? resolvedWorkspaceBindingId
      : (await createNoPlatformWorkspaceBinding(params.tenantId, frozenPrincipal.principalId)).id;
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
  // 环境选择的「首次应用记录」（schema-design §5.2.20）：Binding 冻结了该选择声明的
  // Revision，即该选择已被本 Invocation 真实使用 → 推进 `applied` 并回填一次性首用锚点。
  // `applied` 之后本行仍是后续默认选择（`getEffectiveEnvironmentSelection` 会继续命中），
  // 因此这里只写「首次」，重复调度是幂等重放。
  if (environment.selection) {
    await recordEnvironmentSelectionFirstApplied({
      tenantId: params.tenantId,
      selectionId: environment.selection.id,
      invocationId: invocation.id,
    });
  }
  const endpoint =
    params.runtimeClient && params.runtimeEndpointResolver
      ? await params.runtimeEndpointResolver(binding)
      : null;
  // R01 §1：Workspace 执行资源与 Environment Provisioner 全部由唯一组合层从 Binding 解析。
  // 调用方提供的 Provisioner 只是**部署/边界适配器**，缺省由组合层给出生产默认。
  const resources = await resolveExecutionResources({
    tenantId: params.tenantId,
    binding,
    purpose: "thread",
    overrides: { environmentProvisioner: params.environmentProvisioner ?? null },
  });
  const resolvedEnvironmentProvisioner = resources.environmentProvisioner;
  if (environmentRevision && !resolvedEnvironmentProvisioner) {
    throw new Error("EnvironmentComplianceFailed: 未配置受管 EnvironmentProvisioner");
  }
  // BOUND 且服务端为 Writer 时组合层已解析出真实执行资源；解析不出即 WorkspaceNotReady，
  // 不会退化成一个"引用真实 Workspace 却没有 Writer"的 Binding。
  const workspaceResources: WorkspaceExecutionResources | undefined = resources.workspace;
  const attempt = await createAttempt({ invocationId: invocation.id, tenantId: params.tenantId });
  const preparationClaimId = randomUUID();
  const preparationIntentKey = `invocation:${invocation.id}`;
  const preparationRequestDigest = environmentRevision
    ? environmentProvisionRequestDigest({
        tenantId: params.tenantId,
        invocationId: invocation.id,
        attemptId: attempt.id,
        revisionId: environmentRevision.id,
        workspaceBindingId,
        recoveryAnchorDigest: null,
      })
    : null;
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
          preparationClaimId,
          preparationIntentKey,
          preparationRequestDigest: preparationRequestDigest as string,
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
        // A05：首次 Start 的来源意图就是 Invocation 自身身份 —— 已持久、重投不变。
        sourceOperationKey: preparationIntentKey,
        ...(preparationRequestDigest
          ? {
              preparationClaim: {
                tenantId: params.tenantId,
                invocationId: invocation.id,
                attemptId: attempt.id,
                intentKey: preparationIntentKey,
                requestDigest: preparationRequestDigest,
                claimId: preparationClaimId,
              },
            }
          : {}),
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
        // R04 §5：完成身份是 Session（不是 Attempt ID）。
        // 取不到 Session 时不写 retry timestamp —— Attempt 仍保持 queued，
        // 维护 lane 的"无 retry timestamp 安全窗口"会继续推进它，不会永久不可见。
        const dispatchIdentity = await sessionDispatchIdentityForAttempt({
          tenantId: params.tenantId,
          attemptId: attempt.id,
        });
        if (dispatchIdentity) {
          await recordAttemptDispatchTransientFailure(dispatchIdentity, {
            errorCode: skipReason,
            now: new Date(),
            counted: true,
          });
        }
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

async function loadSession(
  tenantId: string,
  id: string,
): Promise<RuntimeSessionBinding | undefined> {
  const { getRuntimeSessionBindingById } = await import(
    "@/lib/runtime/persistence/runtime-session-store"
  );
  return (await getRuntimeSessionBindingById(tenantId, id)) ?? undefined;
}

/**
 * Turn → `queued` 的唯一步骤实现（`turn.queued` 事件 + activeInvocationId + 版本 CAS）。
 *
 * 除请求内联调度外，R01 §3 的 preparation lane 在补齐"进程死在 Session 写入之前"的
 * 半程意图时也必须走这里 —— 同一 Turn 的历史事件与 activeInvocationId 在任何恢复路径下
 * 都必须一致，因此它是导出的唯一实现，而不是各路径各写一份。
 */
export async function transitionTurnToQueued(params: {
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
