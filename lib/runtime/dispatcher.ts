/**
 * 调度服务。
 *
 * 事实源：
 * - docs/architecture/persistence.md（事务边界）
 * - docs/architecture/agent-control-plane.md §6（Invocation 生命周期）、§7（Turn 接纳周期）
 * - docs/architecture/api-and-events.md （路由解析）、§4（Runtime Protocol）
 * - docs/architecture/runtime-control-plane.md
 *
 * 职责：
 * - dispatchInvocationForTurn：为 accepted Turn 创建调度三元组 + 调用 Runtime HTTP 启动 Invocation。
 * - dispatchAcceptedTurn：批量调度所有 accepted Turn 的便捷入口。
 *
 * 调度流程（单 Turn）：
 * 1. 读取 Turn + Thread（跨租户隔离）。
 * 2. 校验 Turn.turnState == accepted（否则 DispatchTurnStateError）。
 * 3. 通过正式 RouteResolver 解析 Active RouteRevision 与控制面资格事实。
 * 4. 无有效路由 → Turn 保持 accepted，返回 { dispatched: false }（不报错）。
 * 5. createInvocation（事务内：锁 Thread、分配 invocationSequence、INSERT Invocation、写 invocation.queued Event）。
 * 6. createExecutionBinding（不可变 1:1，configHash = SHA-256 规范化字段）。
 * 7. createAttempt（attemptNo=1）。
 * 8. 事务内：锁 Thread、分配 event sequence、CAS 更新 Turn accepted → queued、写 turn.queued Event。
 * 9. 调用 runtimeClient.startInvocation 持久化 runtime_session_ref + runtime_execution_ref。
 * - Runtime accepted → Invocation executionState queued → running + 写 invocation.started Event。
 * - Runtime 网络不可达 → Turn 保持 queued；同一 Attempt 排定 durable retry（nextDispatchAt，由 Runtime Dispatch Retry Worker 领取）。
 * - Runtime 409 IDEMPOTENCY_CONFLICT → 复用现有 SessionBinding。
 * - Runtime 503 RUNTIME_UNAVAILABLE → 同上（durable retry，耗尽后 Recovery Authority 收口）。
 *
 * 关键约束：
 * - 无 DeploymentRoute → Turn 保持 accepted（不报错，等待路由配置后重试）。
 * - ExecutionBinding 启动后不可变（只有 create，没有 update）。
 * - 一个 Invocation 必须且只能属于一个 Turn 或一个 Job。
 * - ThreadEvent sequence 通过锁定 Thread.last_event_sequence 原子递增。
 * - runtime_session_ref 持久化为 RuntimeSessionBinding，外部 Session 不取代 Thread。
 * - 初始执行直接记录在 Invocation，不创建 Attempt 行（Attempt 仅用于基础设施重调度）。
 * - 重试 Attempt 时使用新的 runtime_execution_ref，不覆盖初始 ref。
 */
import { randomUUID } from "node:crypto";
import { aiConfig } from "@/lib/config";
import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
import { getTurnById } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import {
  type CreateExecutionBindingCommand,
  createCreateExecutionBinding,
} from "@/lib/executions/application/create-execution-binding";
import { resolveBindingGovernance } from "@/lib/executions/application/resolve-binding-governance";
import type { ExecutionBinding } from "@/lib/executions/domain/execution-binding";
import { mysqlExecutionBindingStore } from "@/lib/executions/persistence/mysql-execution-binding-store";
import type { AgentRevision } from "@/lib/persistence/schema/agents";
import type {
  ThreadEvent,
  ThreadEventActorType,
  Turn,
} from "@/lib/persistence/schema/conversation";
import { threadEventTable, threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import type {
  Invocation,
  InvocationAttempt,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { type RouteResolver, createResolveRoute } from "@/lib/routes/application/resolve-route";
import type {
  RouteResolution,
  RouteResolutionAttribute,
} from "@/lib/routes/domain/route-resolution-policy";
import {
  type ConfiguredRouteResolver,
  createConfiguredRouteResolver,
} from "@/lib/routes/infrastructure/configured-route-resolver";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import {
  buildRuntimeStartRequestForInvocation,
  invocationAttemptIdempotencyKey,
} from "@/lib/runtime/application/build-runtime-start-request";
import type { RuntimeTransportAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import {
  DispatchTurnStateError,
  RuntimeHttpClientError,
  RuntimeSessionBindingConflictError,
} from "@/lib/runtime/errors";
import { createAttempt } from "@/lib/runtime/invocation-attempt-queries";
import {
  type CreateInvocationParams,
  createInvocation,
  getInvocationById,
  updateInvocationState,
} from "@/lib/runtime/invocation-queries";
import { markInvocationLost } from "@/lib/runtime/recovery-queries";
import {
  type ExecutionPlan,
  extractModelInfo,
  resolveExecutionPlan,
} from "@/lib/runtime/resolve-execution-plan";
import { recordAttemptDispatchTransientFailure } from "@/lib/runtime/retry/dispatch-retry-queries";
import type {
  GatewayAccess,
  GatewayEndpoints,
  GovernanceConfigRef,
  RuntimeHttpClient,
  StartInvocationResponse,
} from "@/lib/runtime/runtime-client";
import {
  createSessionBinding,
  getSessionBindingByExternalRef,
  getSessionBindingsByThread,
  updateLastUsedAt,
} from "@/lib/runtime/session-binding-queries";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { and, eq } from "drizzle-orm";

/** 默认路由 scope key — 正式默认值，调用方可显式覆盖。 */
export const DEFAULT_ROUTE_SCOPE_KEY = "default";

/** 统一解析入口 — Projection 是唯一数据源。 */
const configuredResolver = createConfiguredRouteResolver({
  projectionStore: mysqlRouteEligibilityResolutionStore,
});

/** 将 ConfiguredRouteResolver 适配为 RouteResolver 接口，使 Dispatcher 透明使用统一入口。 */
const defaultRouteResolver: RouteResolver = async (input) => {
  const result = await configuredResolver({
    tenantId: input.tenantId,
    agentConstraint: input.agentConstraint ?? null,
    routeScopeKey: input.routeScopeKey,
    businessKey: input.businessKey,
    attributes: input.attributes,
    threadDefaultModelRef: input.threadDefaultModelRef,
  });
  return result.outcome;
};

const createExecutionBinding = createCreateExecutionBinding({ store: mysqlExecutionBindingStore });

/** 调度结果。 */
export interface DispatchResult {
  /** 是否实际执行了调度（false = 无有效路由，Turn 保持 accepted）。 */
  dispatched: boolean;
  /** 未调度原因（dispatched=false 时填）。 */
  reason?:
    | "no_effective_route"
    | "ambiguous_route_configuration"
    | "invalid_traffic_weight_total"
    | "agent_revision_not_found";
  /** 调度的 Invocation（dispatched=true 时填）。 */
  invocation?: Invocation;
  /** 调度的 ExecutionBinding（dispatched=true 时填）。 */
  binding?: ExecutionBinding;
  /** 本次执行使用的确定性路由解析结果（dispatched=true 时填）。 */
  routeResolution?: RouteResolution;
  /** 调度的 Attempt（dispatched=true 时填）。 */
  attempt?: InvocationAttempt;
  /** 更新后的 Turn（dispatched=true 时填，turnState=queued）。 */
  turn?: Turn;
  /** invocation.queued 事件（由 createInvocation 写入）。 */
  invocationQueuedEvent?: ThreadEvent;
  /** turn.queued 事件（由调度器写入）。 */
  turnQueuedEvent?: ThreadEvent;
  /** Runtime 调度结果（runtimeClient 提供且成功调用时填）。 */
  runtimeDispatch?: RuntimeDispatchResult;
}

/** Runtime 调度结果（dispatchInvocationForTurn 内部调用 Runtime 后填充）。 */
export interface RuntimeDispatchResult {
  /** Runtime 响应（accepted=true 时表示已成功提交；skipped=true 时为 undefined）。 */
  response?: StartInvocationResponse;
  /** 持久化的 RuntimeSessionBinding（可能复用已有，也可能新建；skipped=true 时为 undefined）。 */
  sessionBinding?: RuntimeSessionBinding;
  /** 是否新建了 SessionBinding（false 表示复用已存在；skipped=true 时为 false）。 */
  sessionBindingCreated: boolean;
  /** invocation.started 事件（accepted=true 时写入）。 */
  invocationStartedEvent?: ThreadEvent;
  /** Runtime 调度是否被跳过（网络不可达/503 → Turn 保持 queued，跳过=true）。 */
  skipped?: boolean;
  /** 跳过原因（skipped=true 时填）。 */
  skipReason?: "runtime_network_unavailable" | "runtime_unavailable";
}

/** runtimeEndpointResolver 返回的解析结果。 */
export interface RuntimeEndpointResolution {
  /** Runtime HTTP 端点基础 URL（如 https://runtime-1.internal）。 */
  runtimeEndpoint: string;
  /** Outbound auth（03 §8）：Hosted=Workload Token；External=CredentialRef 凭据。 */
  auth: RuntimeTransportAuth;
  /** 平台 Gateway 回调端点（Runtime 通过这些 URL 上报事件和接收控制指令）。 */
  gatewayEndpoints: GatewayEndpoints;
  /** §24：下发给 Runtime 的 Governance Config 引用（Binding 冻结 Revision 的 configJson）。 */
  governanceConfig: GovernanceConfigRef;
  /** §24/§27：Gateway Access Token（type=gateway，调用 Tool Gateway 用）。 */
  gatewayAccess: GatewayAccess;
}

/**
 * 为单个 accepted Turn 创建调度三元组（Invocation + ExecutionBinding + Attempt），
 * 并调用 Runtime HTTP 启动 Invocation。
 *
 * 流程见模块头注释。无有效路由时不报错，Turn 保持 accepted。
 *
 * Runtime 启动行为：
 * - 传入 runtimeClient 时调用 runtimeClient.startInvocation 持久化 runtime_session_ref/runtime_execution_ref。
 * - Runtime accepted → Invocation queued → running + 写 invocation.started Event。
 * - Runtime 网络不可达 / 503 → Turn 保持 queued（runtimeDispatch.skipped=true；Attempt 已排定 durable retry）。
 * - Runtime 409 IDEMPOTENCY_CONFLICT → 复用现有 SessionBinding。
 * - 不传 runtimeClient → 只创建调度状态，不调用 Runtime。
 *
 * @throws DispatchTurnStateError Turn 不在 accepted 状态
 */
export async function dispatchInvocationForTurn(params: {
  tenantId: string;
  turnId: string;
  /** 调用方显式提供的可选 Agent 控制面约束；null = 基础 Harness Route（§8.3）。 */
  agentConstraint?: string | null;
  /** 路由 scope key（默认 "default"）。 */
  routeScopeKey?: string;
  /** 参与 RouteRevision eligibility 匹配的标量属性。 */
  routeAttributes?: Record<string, RouteResolutionAttribute>;
  /** 员工为本次新 Invocation 选择的模型；同时进入解析摘要和 ExecutionBinding。 */
  selectedModelRef?: string;
  /** 正式路由解析器；默认使用 MySQL 权威事实源。 */
  routeResolver?: RouteResolver;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
  /** Runtime HTTP 客户端（不传则不调用 Runtime）。 */
  runtimeClient?: RuntimeHttpClient;
  /**
   * 从 ExecutionBinding 解析 runtimeEndpoint/auth/gatewayEndpoints 的解析器。
   * 不传则不调用 Runtime（即使 runtimeClient 已传）。
   */
  runtimeEndpointResolver?: (binding: ExecutionBinding) => Promise<RuntimeEndpointResolution>;
  /** Idempotency-Key（不传则自动生成）。 */
  runtimeIdempotencyKey?: string;
  /**
   * ExecutionSubject（06 §6）：可信调用主体。必须由服务端认证 Principal 生成，
   * 禁止从请求体透传 caller 自报 subject。不传则不发送该字段。
   */
  executionSubject?: ExecutionSubject;
}): Promise<DispatchResult> {
  const routeScopeKey = params.routeScopeKey ?? DEFAULT_ROUTE_SCOPE_KEY;
  const actorType: ThreadEventActorType = params.actorType ?? "system";

  // 1. 读取 Turn（跨租户隔离）
  const turn = await getTurnById(params.tenantId, params.turnId);
  if (!turn) {
    throw new DispatchTurnStateError(params.turnId, "not_found");
  }

  // 2. 校验 Turn.turnState == accepted
  if (turn.turnState !== "accepted") {
    throw new DispatchTurnStateError(params.turnId, turn.turnState);
  }

  // 3. 读取 Thread（获取 agentId、threadId、defaultModelRef）
  const [thread] = await db
    .select()
    .from(threadTable)
    .where(and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, turn.threadId)))
    .limit(1);
  if (!thread) {
    throw new DispatchTurnStateError(params.turnId, "thread_not_found");
  }

  // 4+5. : 单次解析执行计划（Route 解析 + AgentRevision + 模型信息）
  const plan = await resolveExecutionPlan(
    {
      tenantId: params.tenantId,
      agentConstraint: params.agentConstraint ?? null,
      routeScopeKey,
      businessKey: { threadId: thread.id },
      attributes: params.routeAttributes ?? {},
      threadDefaultModelRef: params.selectedModelRef ?? thread.defaultModelRef,
      platformDefaultModelRef: aiConfig.chatModel,
      routeResolver: params.routeResolver,
    },
    defaultRouteResolver,
  );

  if (!plan.resolved) {
    return { dispatched: false, reason: plan.reason };
  }
  const routeResolution = plan.routeResolution;
  const modelInfo = plan.modelInfo;

  // 6. createInvocation（事务内：锁 Thread、分配 invocationSequence、写 invocation.queued Event）
  const invocationParams: CreateInvocationParams = {
    tenantId: params.tenantId,
    threadId: thread.id,
    turnId: turn.id,
    invocationKind: "initial",
    triggerItemId: turn.triggerItemId ?? null,
    actorType,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
  };
  const { invocation, event: invocationQueuedEvent } = await createInvocation(invocationParams);

  // 7. createExecutionBinding（不可变 1:1）
  const projectionVersionNo = routeResolution.projectionVersionNo;
  if (
    projectionVersionNo === undefined ||
    !Number.isInteger(projectionVersionNo) ||
    projectionVersionNo < 0
  ) {
    throw new Error("RouteResolution 缺少有效 projectionVersionNo");
  }
  // §10/§11：解析有效 Policy（Route explicit → Tenant baseline fallback）+ Governance（Tenant current）。
  const bindingGovernance = await resolveBindingGovernance(
    db,
    params.tenantId,
    routeResolution.policyRevisionId,
  );
  // 控制面证据恒非空。基础 Harness Route（agentRevisionId=null）的证据 agent 字段
  // 为 null（§18 Agent Evidence not_applicable），会正确展开写入 Binding；Runtime 字段
  // 照常。Agent Route → 完整成组。
  const controlPlaneEvidence = routeResolution.controlPlaneEvidence;
  const bindingParams: CreateExecutionBindingCommand = {
    invocationId: invocation.id,
    tenantId: params.tenantId,
    agentRevisionId: routeResolution.agentRevisionId,
    runtimeRevisionId: routeResolution.runtimeRevisionId,
    deploymentRouteId: routeResolution.deploymentRouteId,
    modelProvider: modelInfo.modelProvider,
    modelId: modelInfo.modelId,
    modelRevisionRef: modelInfo.modelRevisionRef,
    initialEnvironmentLeaseId: null,
    workspaceBindingId: null,
    policyRevisionId: bindingGovernance.policyRevisionId,
    policyRulesDigest: bindingGovernance.policyRulesDigest,
    governanceConfigRevisionId: bindingGovernance.governanceConfigRevisionId,
    governanceConfigDigest: bindingGovernance.governanceConfigDigest,
    contextCheckpointId: null,
    environmentDefinitionRevisionId: null,
    /** Projection 版本号，用于 Binding 版本一致性校验。 */
    projectionVersionNo,
    controlPlaneEvidence: {
      routeRevisionId: routeResolution.routeRevisionId,
      routeActivationId: routeResolution.routeActivationId,
      routeContentDigest: routeResolution.routeContentDigest,
      resolutionInputDigest: routeResolution.resolutionInputDigest,
      ...controlPlaneEvidence,
    },
  };
  const binding = await createExecutionBinding(bindingParams);

  // 8. createAttempt（attemptNo=1）
  const attempt = await createAttempt({ invocationId: invocation.id });

  // 9. 事务内：锁 Thread、分配 event sequence、CAS 更新 Turn accepted → queued、写 turn.queued Event
  const { turn: updatedTurn, event: turnQueuedEvent } = await transitionTurnToQueued({
    threadId: thread.id,
    turn,
    invocationId: invocation.id,
    actorType,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
  });

  // 10. 调用 Runtime HTTP 启动 Invocation
  let runtimeDispatch: RuntimeDispatchResult | undefined;
  if (params.runtimeClient && params.runtimeEndpointResolver) {
    runtimeDispatch = await dispatchToRuntime({
      tenantId: params.tenantId,
      threadId: thread.id,
      invocation,
      binding,
      agentRevision: plan.agentRevision,
      runtimeRevisionId: routeResolution.runtimeRevisionId,
      turn,
      attempt,
      runtimeClient: params.runtimeClient,
      runtimeEndpointResolver: params.runtimeEndpointResolver,
      idempotencyKey: params.runtimeIdempotencyKey ?? invocationAttemptIdempotencyKey(attempt.id),
      actorType,
      actorId: params.actorId ?? null,
      correlationId: params.correlationId ?? null,
      executionSubject: params.executionSubject,
    });
  }

  // 若 Runtime 调度成功（非 skipped），重新查询 Invocation 以反映 running 状态
  let finalInvocation = invocation;
  if (runtimeDispatch && !runtimeDispatch.skipped) {
    const refreshed = await getInvocationById(params.tenantId, invocation.id);
    if (refreshed) {
      finalInvocation = refreshed;
    }
  }

  return {
    dispatched: true,
    invocation: finalInvocation,
    binding,
    routeResolution,
    attempt,
    turn: updatedTurn,
    invocationQueuedEvent,
    turnQueuedEvent,
    runtimeDispatch,
  };
}

/**
 * 事务内将 Turn 从 accepted 转为 queued，并写 turn.queued Event。
 *
 * 流程：
 * 1. SELECT FOR UPDATE 锁定 Thread 行。
 * 2. 分配 event sequence（1 个，用于 turn.queued）。
 * 3. CAS 更新 Turn（accepted → queued，activeInvocationId/latestInvocationId 指向新 Invocation）。
 * 4. INSERT ThreadEvent (turn.queued)。
 *
 * @throws DispatchTurnStateError Turn 已不在 accepted 状态（并发冲突）
 */
async function transitionTurnToQueued(params: {
  threadId: string;
  turn: Turn;
  invocationId: string;
  actorType: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<{ turn: Turn; event: ThreadEvent }> {
  const turnId = params.turn.id;
  const expectedVersionNo = params.turn.versionNo;

  const { eventSequence } = await db.transaction(async (tx) => {
    // 1. 锁定 Thread 行
    const [thread] = await tx
      .select({ id: threadTable.id })
      .from(threadTable)
      .where(eq(threadTable.id, params.threadId))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new DispatchTurnStateError(turnId, "thread_not_found");
    }

    // 2. 分配 event sequence
    const seq = await allocateEventSequences(tx, params.threadId, 1);

    // 3. CAS 更新 Turn（accepted → queued）
    const now = new Date();
    const updateResult = await tx
      .update(turnTable)
      .set({
        turnState: "queued",
        activeInvocationId: params.invocationId,
        latestInvocationId: params.invocationId,
        versionNo: expectedVersionNo + 1,
      })
      .where(and(eq(turnTable.id, turnId), eq(turnTable.versionNo, expectedVersionNo)));

    if (updateResult[0].affectedRows === 0) {
      // CAS 失败：并发冲突或 Turn 状态已变
      const [current] = await tx.select().from(turnTable).where(eq(turnTable.id, turnId)).limit(1);
      throw new DispatchTurnStateError(turnId, current?.turnState ?? "unknown");
    }

    // 4. INSERT ThreadEvent (turn.queued)
    const eventId = randomUUID();
    await tx.insert(threadEventTable).values({
      id: eventId,
      threadId: params.threadId,
      eventSequence: seq,
      eventType: "turn.queued",
      schemaVersion: 1,
      turnId,
      invocationId: params.invocationId,
      actorType: params.actorType,
      actorId: params.actorId ?? null,
      payloadJson: {
        invocation_id: params.invocationId,
      },
      correlationId: params.correlationId ?? null,
      occurredAt: now,
      ingestedAt: now,
    });

    return { eventSequence: seq };
  });

  // 读取最终状态（事务外）
  const [updatedTurn] = await db.select().from(turnTable).where(eq(turnTable.id, turnId)).limit(1);
  if (!updatedTurn) {
    throw new Error(`transitionTurnToQueued: Turn 行未找到（id=${turnId}）`);
  }

  // 查找刚写入的 turn.queued 事件
  const [turnQueuedEvent] = await db
    .select()
    .from(threadEventTable)
    .where(
      and(
        eq(threadEventTable.threadId, params.threadId),
        eq(threadEventTable.eventSequence, eventSequence),
      ),
    )
    .limit(1);
  if (!turnQueuedEvent) {
    throw new Error(
      `transitionTurnToQueued: turn.queued 事件未找到（threadId=${params.threadId}, sequence=${eventSequence}）`,
    );
  }

  return { turn: updatedTurn, event: turnQueuedEvent };
}

/**
 * 调用 Runtime HTTP 启动 Invocation（dispatchInvocationForTurn 内部 helper）。
 *
 * 流程：
 * 1. 通过 runtimeEndpointResolver 解析 runtimeEndpoint + auth + gatewayEndpoints。
 * 2. 读取 RuntimeRevision 获取 capabilities（用于 execution_limits）。
 * 3. 构造 StartInvocationRequestBody。
 * 4. 调用 runtimeClient.startInvocation。
 * 5. 错误处理：
 * - kind=network → 跳过（Turn 保持 queued；Attempt 排定 durable retry）
 * - kind=http + 503 → 跳过（Turn 保持 queued；Attempt 排定 durable retry）
 * - kind=http + 409 IDEMPOTENCY_CONFLICT → 复用现有 SessionBinding
 * 6. 成功：持久化 runtime_session_ref + 事务内更新 Invocation + 写 invocation.started Event。
 * 7. 返回 RuntimeDispatchResult。
 */
async function dispatchToRuntime(params: {
  tenantId: string;
  threadId: string;
  invocation: Invocation;
  binding: ExecutionBinding;
  /** null = 基础 Harness Route（无 Agent 资产约束，§8.3）。 */
  agentRevision: AgentRevision | null;
  runtimeRevisionId: string;
  turn: Turn;
  /** 本次调度对应的 Attempt（attemptNo=1；transient 失败时在其上排定 durable retry）。 */
  attempt: InvocationAttempt;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<RuntimeEndpointResolution>;
  idempotencyKey: string;
  actorType: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
  /** 服务端 Principal 生成的可信调用主体（06 §6）；可选（内部测试/基础路径）。 */
  executionSubject?: ExecutionSubject;
}): Promise<RuntimeDispatchResult> {
  // 1. 解析 runtimeEndpoint + auth + gatewayEndpoints + governanceConfig + gatewayAccess
  const { runtimeEndpoint, auth, gatewayEndpoints, governanceConfig, gatewayAccess } =
    await params.runtimeEndpointResolver(params.binding);

  // 2+3. 构造 StartInvocationRequestBody（唯一正式 builder；初始调度要求 trigger Item 存在）
  const { requestBody } = await buildRuntimeStartRequestForInvocation({
    tenantId: params.tenantId,
    invocation: params.invocation,
    binding: params.binding,
    agentRevision: params.agentRevision,
    runtimeRevisionId: params.runtimeRevisionId,
    gatewayEndpoints,
    governanceConfig,
    gatewayAccess,
    executionSubject: params.executionSubject ?? null,
    correlationId: params.correlationId ?? null,
    attempt: {
      attemptNo: params.attempt.attemptNo,
      attemptId: params.attempt.id,
      retryReason: params.attempt.retryReasonCode,
      checkpointRef: params.attempt.checkpointRef,
    },
    requireTriggerItem: true,
    now: new Date(),
  });

  // 4. 调用 runtimeClient.startInvocation（带错误处理）
  let response: StartInvocationResponse;
  try {
    response = await params.runtimeClient.startInvocation({
      runtimeEndpoint,
      auth,
      idempotencyKey: params.idempotencyKey,
      requestBody,
    });
  } catch (err) {
    if (err instanceof RuntimeHttpClientError) {
      // transient（网络不可达 / 503）→ 在同一 Attempt 上排定 durable retry work
      // （dispatchAttemptCount+1 + nextDispatchAt + 清 lease）；耗尽时由唯一
      // Recovery Authority（markInvocationLost）收口 Invocation/Turn。不再只写“等待重试”。
      if (err.kind === "network" || (err.kind === "http" && err.httpStatus === 503)) {
        const skipReason: "runtime_network_unavailable" | "runtime_unavailable" =
          err.kind === "network" ? "runtime_network_unavailable" : "runtime_unavailable";
        const outcome = await recordAttemptDispatchTransientFailure({
          attemptId: params.attempt.id,
          errorCode: skipReason,
          now: new Date(),
          retryReasonCode: params.attempt.retryReasonCode ?? "initial_dispatch_unavailable",
        });
        if (outcome.outcome === "exhausted") {
          await markInvocationLost({
            tenantId: params.tenantId,
            invocationId: params.invocation.id,
            reasonCode: "dispatch_retry_exhausted",
            errorSummary: `Initial dispatch retry exhausted（lastTransient=${skipReason}）`,
            actorType: params.actorType,
            actorId: params.actorId ?? null,
            correlationId: params.correlationId ?? null,
          });
        }
        return {
          sessionBindingCreated: false,
          skipped: true,
          skipReason,
        };
      }
      // 409 IDEMPOTENCY_CONFLICT → 复用现有 SessionBinding
      if (
        err.kind === "http" &&
        err.httpStatus === 409 &&
        err.runtimeErrorCode === "IDEMPOTENCY_CONFLICT"
      ) {
        return await handleIdempotencyConflict(params);
      }
    }
    throw err;
  }

  // 5. 成功：持久化 runtime_session_ref
  let sessionBinding: RuntimeSessionBinding | undefined;
  let sessionBindingCreated = false;
  try {
    sessionBinding = await createSessionBinding({
      tenantId: params.tenantId,
      runtimeRevisionId: params.runtimeRevisionId,
      agentRevisionId: params.agentRevision?.id ?? null,
      threadId: params.threadId,
      externalSessionRef: response.runtime_session_ref,
    });
    sessionBindingCreated = true;
  } catch (err) {
    if (err instanceof RuntimeSessionBindingConflictError) {
      // 同 runtimeRevisionId+externalSessionRef 已存在（并发或重发），复用
      const existing = await getSessionBindingByExternalRef(
        params.runtimeRevisionId,
        response.runtime_session_ref,
      );
      if (existing) {
        sessionBinding = existing;
        sessionBindingCreated = false;
      } else {
        // 理论不应发生（刚触发 conflict 却查不到），按跳过处理
        return {
          sessionBindingCreated: false,
          skipped: true,
          skipReason: "runtime_unavailable",
        };
      }
    } else {
      throw err;
    }
  }

  // 6. 事务内：更新 Invocation（queued → running + runtimeExecutionRef + runtimeSessionBindingId）+ 写 invocation.started Event
  const invocationStartedEvent = await db.transaction(async (tx) => {
    // 锁定 Thread 行
    const [thread] = await tx
      .select({ id: threadTable.id })
      .from(threadTable)
      .where(eq(threadTable.id, params.threadId))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new Error(`dispatchToRuntime: Thread 不存在（id=${params.threadId}）`);
    }

    // 更新 Invocation：queued → running + 设置 runtimeExecutionRef
    await updateInvocationState(tx, params.tenantId, params.invocation.id, "running", {
      runtimeExecutionRef: response.runtime_execution_ref,
    });

    // 设置 runtimeSessionBindingId（updateInvocationState 不含此字段，单独更新）
    if (sessionBinding) {
      await tx
        .update(invocationTable)
        .set({ runtimeSessionBindingId: sessionBinding.id })
        .where(eq(invocationTable.id, params.invocation.id));
    }

    // 分配 event sequence + 写 invocation.started Event
    const seq = await allocateEventSequences(tx, params.threadId, 1);
    return insertThreadEvent(tx, params.threadId, seq, {
      eventType: "invocation.started",
      turnId: params.turn.id,
      invocationId: params.invocation.id,
      actorType: params.actorType,
      actorId: params.actorId ?? undefined,
      payload: {
        runtime_session_ref: response.runtime_session_ref,
        runtime_execution_ref: response.runtime_execution_ref,
        runtime_session_binding_id: sessionBinding?.id ?? null,
        attempt_no: 1,
      },
      correlationId: params.correlationId ?? undefined,
    });
  });

  // 7. 刷新 sessionBinding.lastUsedAt
  if (sessionBinding) {
    await updateLastUsedAt(sessionBinding.id);
  }

  return {
    response,
    sessionBinding,
    sessionBindingCreated,
    invocationStartedEvent,
  };
}

/**
 * 409 IDEMPOTENCY_CONFLICT 处理：尝试复用已有 SessionBinding。
 *
 * 查找同 thread + runtimeRevisionId 的 active SessionBinding；
 * 找到则复用并 transition Invocation → running；未找到则跳过（Turn 保持 queued）。
 */
async function handleIdempotencyConflict(params: {
  tenantId: string;
  threadId: string;
  invocation: Invocation;
  runtimeRevisionId: string;
  turn: Turn;
  actorType: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<RuntimeDispatchResult> {
  // 查找已有 active SessionBinding
  const bindings = await getSessionBindingsByThread(params.tenantId, params.threadId);
  const existing = bindings.find(
    (b) => b.runtimeRevisionId === params.runtimeRevisionId && b.bindingState === "active",
  );

  if (!existing) {
    // 未找到可复用的 SessionBinding → 跳过
    return {
      sessionBindingCreated: false,
      skipped: true,
      skipReason: "runtime_unavailable",
    };
  }

  // 复用现有 SessionBinding，transition Invocation → running
  const invocationStartedEvent = await db.transaction(async (tx) => {
    const [thread] = await tx
      .select({ id: threadTable.id })
      .from(threadTable)
      .where(eq(threadTable.id, params.threadId))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new Error(`handleIdempotencyConflict: Thread 不存在（id=${params.threadId}）`);
    }

    await updateInvocationState(tx, params.tenantId, params.invocation.id, "running");

    await tx
      .update(invocationTable)
      .set({ runtimeSessionBindingId: existing.id })
      .where(eq(invocationTable.id, params.invocation.id));

    const seq = await allocateEventSequences(tx, params.threadId, 1);
    return insertThreadEvent(tx, params.threadId, seq, {
      eventType: "invocation.started",
      turnId: params.turn.id,
      invocationId: params.invocation.id,
      actorType: params.actorType,
      actorId: params.actorId ?? undefined,
      payload: {
        runtime_session_ref: existing.externalSessionRef,
        runtime_session_binding_id: existing.id,
        attempt_no: 1,
        recovered_from_idempotency_conflict: true,
      },
      correlationId: params.correlationId ?? undefined,
    });
  });

  await updateLastUsedAt(existing.id);

  return {
    sessionBinding: existing,
    sessionBindingCreated: false,
    invocationStartedEvent,
  };
}

/**
 * 批量调度所有 accepted Turn（便捷入口）。
 *
 * 遍历指定 Thread 下所有 accepted Turn，逐个调用 dispatchInvocationForTurn。
 * 无有效路由的 Turn 保持 accepted，不影响其他 Turn 调度。
 */
export async function dispatchAcceptedTurn(params: {
  tenantId: string;
  threadId: string;
  routeScopeKey?: string;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<DispatchResult[]> {
  // 查询 Thread 下所有 accepted Turn
  const turns = await db
    .select()
    .from(turnTable)
    .where(and(eq(turnTable.threadId, params.threadId), eq(turnTable.turnState, "accepted")));

  const results: DispatchResult[] = [];
  for (const turn of turns) {
    const result = await dispatchInvocationForTurn({
      tenantId: params.tenantId,
      turnId: turn.id,
      routeScopeKey: params.routeScopeKey,
      actorType: params.actorType,
      actorId: params.actorId,
      correlationId: params.correlationId,
    });
    results.push(result);
  }
  return results;
}
