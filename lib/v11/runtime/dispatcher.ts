/**
 * V11 调度服务（S05-C01 + S05-C02 扩展）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.2-§6.4、§6.11、§9.1（事务边界）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §6（Invocation 生命周期）、§7（Turn 接纳周期）
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §6.3（路由解析）、§4（Runtime Protocol）
 * - ../v11-agentkit-platform-development-plan/05-runtime-dispatch-and-attempt.md S05-C01/S05-C02
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
 * 9. S05-C02 扩展：调用 runtimeClient.startInvocation 持久化 runtime_session_ref + runtime_execution_ref。
 *    - Runtime accepted → Invocation executionState queued → running + 写 invocation.started Event。
 *    - Runtime 网络不可达 → Turn 保持 queued，不报错（后续重试）。
 *    - Runtime 409 IDEMPOTENCY_CONFLICT → 复用现有 SessionBinding。
 *    - Runtime 503 RUNTIME_UNAVAILABLE → Turn 保持 queued，不报错。
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
import { mysqlExecutionBindingStore } from "@/lib/compatibility/executions/mysql-execution-binding-store";
import { mysqlRouteResolutionStore } from "@/lib/compatibility/routes/mysql-route-resolution-store";
import { db } from "@/lib/db/client";
import {
  type CreateExecutionBindingCommand,
  createCreateExecutionBinding,
} from "@/lib/executions/application/create-execution-binding";
import type { ExecutionBinding } from "@/lib/executions/domain/execution-binding";
import { type RouteResolver, createResolveRoute } from "@/lib/routes/application/resolve-route";
import type {
  RouteResolution,
  RouteResolutionAttribute,
} from "@/lib/routes/domain/route-resolution-policy";
import { issueContextHandle } from "@/lib/v11/context/context-handle";
import { getRevisionById } from "@/lib/v11/control-plane/agent-revision-queries";
import { getRuntimeRevisionById } from "@/lib/v11/control-plane/runtime-revision-queries";
import { getItemById } from "@/lib/v11/conversation/thread-item-queries";
import { allocateEventSequences, insertThreadEvent } from "@/lib/v11/conversation/thread-queries";
import { getTurnById } from "@/lib/v11/conversation/turn-queries";
import {
  DispatchTurnStateError,
  RuntimeHttpClientError,
  RuntimeSessionBindingConflictError,
} from "@/lib/v11/runtime/errors";
import { createAttempt } from "@/lib/v11/runtime/invocation-attempt-queries";
import {
  type CreateInvocationParams,
  createInvocation,
  getInvocationById,
  updateInvocationState,
} from "@/lib/v11/runtime/invocation-queries";
import type {
  RuntimeHttpClient,
  StartInvocationRequestBody,
  StartInvocationResponse,
} from "@/lib/v11/runtime/runtime-client";
import {
  createSessionBinding,
  getSessionBindingByExternalRef,
  getSessionBindingsByThread,
  updateLastUsedAt,
} from "@/lib/v11/runtime/session-binding-queries";
import type { V11AgentRevision } from "@/lib/v11/schema/agent";
import type { ThreadEventActorType, V11ThreadEvent, V11Turn } from "@/lib/v11/schema/conversation";
import { v11Thread, v11ThreadEvent, v11Turn } from "@/lib/v11/schema/conversation";
import type {
  V11ExecutionBinding,
  V11Invocation,
  V11InvocationAttempt,
  V11RuntimeSessionBinding,
} from "@/lib/v11/schema/runtime";
import { v11Invocation } from "@/lib/v11/schema/runtime";
import { and, eq } from "drizzle-orm";

/** 本阶段使用的默认路由 scope key（后续阶段从 Thread/Agent 配置解析）。 */
export const DEFAULT_ROUTE_SCOPE_KEY = "default";

/** 默认模型 provider（modelPolicyJson 未显式声明时使用）。 */
const DEFAULT_MODEL_PROVIDER = "default";

const defaultRouteResolver = createResolveRoute({ store: mysqlRouteResolutionStore });
const createExecutionBinding = createCreateExecutionBinding({ store: mysqlExecutionBindingStore });

/** 调度结果。 */
export interface DispatchResult {
  /** 是否实际执行了调度（false = 无有效路由，Turn 保持 accepted）。 */
  dispatched: boolean;
  /** 未调度原因（dispatched=false 时填）。 */
  reason?: "no_effective_route";
  /** 调度的 Invocation（dispatched=true 时填）。 */
  invocation?: V11Invocation;
  /** 调度的 ExecutionBinding（dispatched=true 时填）。 */
  binding?: ExecutionBinding;
  /** 本次执行使用的确定性路由解析结果（dispatched=true 时填）。 */
  routeResolution?: RouteResolution;
  /** 调度的 Attempt（dispatched=true 时填）。 */
  attempt?: V11InvocationAttempt;
  /** 更新后的 Turn（dispatched=true 时填，turnState=queued）。 */
  turn?: V11Turn;
  /** invocation.queued 事件（由 createInvocation 写入）。 */
  invocationQueuedEvent?: V11ThreadEvent;
  /** turn.queued 事件（由调度器写入）。 */
  turnQueuedEvent?: V11ThreadEvent;
  /** Runtime 调度结果（runtimeClient 提供且成功调用时填）。 */
  runtimeDispatch?: RuntimeDispatchResult;
}

/** Runtime 调度结果（dispatchInvocationForTurn 内部调用 Runtime 后填充）。 */
export interface RuntimeDispatchResult {
  /** Runtime 响应（accepted=true 时表示已成功提交；skipped=true 时为 undefined）。 */
  response?: StartInvocationResponse;
  /** 持久化的 RuntimeSessionBinding（可能复用已有，也可能新建；skipped=true 时为 undefined）。 */
  sessionBinding?: V11RuntimeSessionBinding;
  /** 是否新建了 SessionBinding（false 表示复用已存在；skipped=true 时为 false）。 */
  sessionBindingCreated: boolean;
  /** invocation.started 事件（accepted=true 时写入）。 */
  invocationStartedEvent?: V11ThreadEvent;
  /** Runtime 调度是否被跳过（网络不可达/503 → Turn 保持 queued，跳过=true）。 */
  skipped?: boolean;
  /** 跳过原因（skipped=true 时填）。 */
  skipReason?: "runtime_network_unavailable" | "runtime_unavailable";
}

/** runtimeEndpointResolver 返回的解析结果。 */
export interface RuntimeEndpointResolution {
  /** Runtime HTTP 端点基础 URL（如 https://runtime-1.internal）。 */
  runtimeEndpoint: string;
  /** 短期 Workload Token（绑定 runtime_revision/invocation/租户）。 */
  authToken: string;
  /** 平台 Gateway 回调端点（Runtime 通过这些 URL 上报事件和接收控制指令）。 */
  gatewayEndpoints: {
    events: string;
    cancel: string;
    resume: string;
    steer: string;
  };
}

/** 从 AgentRevision.modelPolicyJson 提取模型信息。 */
interface ModelInfo {
  modelProvider: string;
  modelId: string;
  modelRevisionRef: string | null;
}

/**
 * 从 AgentRevision.modelPolicyJson 和 Thread.defaultModelRef 提取模型信息。
 *
 * modelPolicyJson 形如 { default: "doubao-pro", provider?: "doubao", revision?: "v1" }。
 * 优先级：modelPolicyJson > Thread.defaultModelRef > "default" 占位。
 */
function extractModelInfo(
  modelPolicyJson: unknown,
  threadDefaultModelRef: string | null,
): ModelInfo {
  const policy = (modelPolicyJson ?? {}) as Record<string, unknown>;
  const modelId =
    (typeof policy.default === "string" && policy.default) ||
    (typeof policy.modelId === "string" && policy.modelId) ||
    threadDefaultModelRef ||
    "default";
  const modelProvider =
    (typeof policy.provider === "string" && policy.provider) || DEFAULT_MODEL_PROVIDER;
  const modelRevisionRef =
    typeof policy.revision === "string"
      ? policy.revision
      : typeof policy.modelRevisionRef === "string"
        ? policy.modelRevisionRef
        : null;
  return { modelProvider, modelId, modelRevisionRef };
}

/**
 * 为单个 accepted Turn 创建调度三元组（Invocation + ExecutionBinding + Attempt），
 * 并调用 Runtime HTTP 启动 Invocation（S05-C02 扩展）。
 *
 * 流程见模块头注释。无有效路由时不报错，Turn 保持 accepted。
 *
 * S05-C02 扩展：
 * - 传入 runtimeClient 时调用 runtimeClient.startInvocation 持久化 runtime_session_ref/runtime_execution_ref。
 * - Runtime accepted → Invocation queued → running + 写 invocation.started Event。
 * - Runtime 网络不可达 / 503 → Turn 保持 queued，不报错（runtimeDispatch.skipped=true）。
 * - Runtime 409 IDEMPOTENCY_CONFLICT → 复用现有 SessionBinding。
 * - 不传 runtimeClient → 沿用 S05-C01 行为（只创建调度状态，不调用 Runtime）。
 *
 * @throws DispatchTurnStateError Turn 不在 accepted 状态
 */
export async function dispatchInvocationForTurn(params: {
  tenantId: string;
  turnId: string;
  /** 路由 scope key（默认 "default"）。 */
  routeScopeKey?: string;
  /** 参与 RouteRevision eligibility 匹配的标量属性。 */
  routeAttributes?: Record<string, RouteResolutionAttribute>;
  /** 正式路由解析器；默认使用 MySQL 权威事实源。 */
  routeResolver?: RouteResolver;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
  /** S05-C02：Runtime HTTP 客户端（不传则不调用 Runtime）。 */
  runtimeClient?: RuntimeHttpClient;
  /**
   * S05-C02：从 ExecutionBinding 解析 runtimeEndpoint/authToken/gatewayEndpoints 的解析器。
   * 不传则不调用 Runtime（即使 runtimeClient 已传）。
   */
  runtimeEndpointResolver?: (binding: V11ExecutionBinding) => Promise<RuntimeEndpointResolution>;
  /** S05-C02：Idempotency-Key（不传则自动生成）。 */
  runtimeIdempotencyKey?: string;
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
    .from(v11Thread)
    .where(and(eq(v11Thread.tenantId, params.tenantId), eq(v11Thread.id, turn.threadId)))
    .limit(1);
  if (!thread) {
    throw new DispatchTurnStateError(params.turnId, "thread_not_found");
  }

  // 4. 确定性解析 Active RouteRevision，并在创建执行事实前完成全部资格检查
  const routeOutcome = await (params.routeResolver ?? defaultRouteResolver)({
    tenantId: params.tenantId,
    agentId: thread.primaryAgentId,
    routeScopeKey,
    businessKey: { threadId: thread.id },
    attributes: params.routeAttributes ?? {},
  });
  if (routeOutcome.status === "unresolved") {
    // 无有效路由 → Turn 保持 accepted，不报错
    return { dispatched: false, reason: "no_effective_route" };
  }
  const routeResolution = routeOutcome.resolution;

  // 5. 读取解析结果冻结的 AgentRevision（提取模型信息）
  const agentRevision = await getRevisionById(routeResolution.agentRevisionId);
  if (!agentRevision) {
    throw new DispatchTurnStateError(params.turnId, "agent_revision_not_found");
  }
  const modelInfo = extractModelInfo(agentRevision.modelPolicyJson, thread.defaultModelRef);

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
    policyRevisionId: routeResolution.policyRevisionId,
    contextCheckpointId: null,
    environmentDefinitionRevisionId: null,
    controlPlaneEvidence: {
      routeRevisionId: routeResolution.routeRevisionId,
      routeActivationId: routeResolution.routeActivationId,
      routeContentDigest: routeResolution.routeContentDigest,
      ...routeResolution.controlPlaneEvidence,
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

  // 10. S05-C02 扩展：调用 Runtime HTTP 启动 Invocation
  let runtimeDispatch: RuntimeDispatchResult | undefined;
  if (params.runtimeClient && params.runtimeEndpointResolver) {
    runtimeDispatch = await dispatchToRuntime({
      tenantId: params.tenantId,
      threadId: thread.id,
      invocation,
      binding,
      agentRevision,
      runtimeRevisionId: routeResolution.runtimeRevisionId,
      turn,
      runtimeClient: params.runtimeClient,
      runtimeEndpointResolver: params.runtimeEndpointResolver,
      idempotencyKey: params.runtimeIdempotencyKey ?? `invoke-${invocation.id}`,
      actorType,
      actorId: params.actorId ?? null,
      correlationId: params.correlationId ?? null,
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
  turn: V11Turn;
  invocationId: string;
  actorType: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<{ turn: V11Turn; event: V11ThreadEvent }> {
  const turnId = params.turn.id;
  const expectedVersionNo = params.turn.versionNo;

  const { eventSequence } = await db.transaction(async (tx) => {
    // 1. 锁定 Thread 行
    const [thread] = await tx
      .select({ id: v11Thread.id })
      .from(v11Thread)
      .where(eq(v11Thread.id, params.threadId))
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
      .update(v11Turn)
      .set({
        turnState: "queued",
        activeInvocationId: params.invocationId,
        latestInvocationId: params.invocationId,
        versionNo: expectedVersionNo + 1,
      })
      .where(and(eq(v11Turn.id, turnId), eq(v11Turn.versionNo, expectedVersionNo)));

    if (updateResult[0].affectedRows === 0) {
      // CAS 失败：并发冲突或 Turn 状态已变
      const [current] = await tx.select().from(v11Turn).where(eq(v11Turn.id, turnId)).limit(1);
      throw new DispatchTurnStateError(turnId, current?.turnState ?? "unknown");
    }

    // 4. INSERT ThreadEvent (turn.queued)
    const eventId = randomUUID();
    await tx.insert(v11ThreadEvent).values({
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
  const [updatedTurn] = await db.select().from(v11Turn).where(eq(v11Turn.id, turnId)).limit(1);
  if (!updatedTurn) {
    throw new Error(`transitionTurnToQueued: Turn 行未找到（id=${turnId}）`);
  }

  // 查找刚写入的 turn.queued 事件
  const [turnQueuedEvent] = await db
    .select()
    .from(v11ThreadEvent)
    .where(
      and(
        eq(v11ThreadEvent.threadId, params.threadId),
        eq(v11ThreadEvent.eventSequence, eventSequence),
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
 * S05-C02 扩展：调用 Runtime HTTP 启动 Invocation（dispatchInvocationForTurn 内部 helper）。
 *
 * 流程：
 * 1. 通过 runtimeEndpointResolver 解析 runtimeEndpoint + authToken + gatewayEndpoints。
 * 2. 读取 RuntimeRevision 获取 capabilities（用于 execution_limits）。
 * 3. 构造 StartInvocationRequestBody。
 * 4. 调用 runtimeClient.startInvocation。
 * 5. 错误处理：
 *    - kind=network → 跳过（Turn 保持 queued，不报错）
 *    - kind=http + 503 → 跳过（Turn 保持 queued，不报错）
 *    - kind=http + 409 IDEMPOTENCY_CONFLICT → 复用现有 SessionBinding
 * 6. 成功：持久化 runtime_session_ref + 事务内更新 Invocation + 写 invocation.started Event。
 * 7. 返回 RuntimeDispatchResult。
 */
async function dispatchToRuntime(params: {
  tenantId: string;
  threadId: string;
  invocation: V11Invocation;
  binding: V11ExecutionBinding;
  agentRevision: V11AgentRevision;
  runtimeRevisionId: string;
  turn: V11Turn;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: V11ExecutionBinding) => Promise<RuntimeEndpointResolution>;
  idempotencyKey: string;
  actorType: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<RuntimeDispatchResult> {
  // 1. 解析 runtimeEndpoint + authToken + gatewayEndpoints
  const { runtimeEndpoint, authToken, gatewayEndpoints } = await params.runtimeEndpointResolver(
    params.binding,
  );

  // 2. 读取 RuntimeRevision 获取 capabilities（用于 execution_limits）
  const runtimeRevision = await getRuntimeRevisionById(params.runtimeRevisionId);
  if (!runtimeRevision) {
    throw new Error(`dispatchToRuntime: RuntimeRevision 不存在（id=${params.runtimeRevisionId}）`);
  }
  const caps = runtimeRevision.runtimeCapabilitiesJson as {
    limits?: { max_invocation_seconds?: number; max_event_bytes?: number };
  } | null;
  const maxInvocationSeconds = caps?.limits?.max_invocation_seconds ?? 600;
  const maxEventBytes = caps?.limits?.max_event_bytes ?? 1_048_576;

  // 3. 构造 StartInvocationRequestBody
  const triggerItem = params.invocation.triggerItemId
    ? await getItemById(params.tenantId, params.invocation.triggerItemId)
    : null;
  if (!triggerItem) {
    throw new Error(
      `dispatchToRuntime: 当前输入 Item 不存在（invocationId=${params.invocation.id}）`,
    );
  }
  const contextHandle = await issueContextHandle({
    tenantId: params.tenantId,
    invocationId: params.invocation.id,
  });
  const requestBody: StartInvocationRequestBody = {
    invocation_id: params.invocation.id,
    turn_context: {
      thread_id: params.threadId,
      turn_id: params.turn.id,
      trigger_item_id: params.turn.triggerItemId ?? null,
    },
    job_context: null,
    agent: {
      agent_revision_id: params.agentRevision.id,
      instruction_hash: params.agentRevision.instructionHash,
      artifact_ref: params.agentRevision.agentArtifactRef,
      model_policy: (params.agentRevision.modelPolicyJson ?? {}) as Record<string, unknown>,
      permission_requirements: (params.agentRevision.permissionRequirementsJson ?? {}) as Record<
        string,
        unknown
      >,
      interface_requirements: (params.agentRevision.agentInterfaceRequirementsJson ?? {}) as Record<
        string,
        unknown
      >,
    },
    input_items: [
      {
        type: "platform_rule",
        content: "仅使用当前 Invocation 授权的 Context Gateway 与 Workspace 资源。",
      },
      {
        type: "agent_instruction_ref",
        agent_revision_id: params.agentRevision.id,
        instruction_hash: params.agentRevision.instructionHash,
      },
      {
        type: "user_message",
        item_id: triggerItem.id,
        content: triggerItem.contentJson,
      },
      {
        type: "resource_index",
        sources: ["recent_items", "skill", "workspace_map", "memory", "knowledge"],
      },
    ],
    context_handle: contextHandle,
    gateway_endpoints: gatewayEndpoints,
    workspace: {
      workspace_binding_id: params.binding.workspaceBindingId,
      workspace_type: params.binding.workspaceBindingId ? "managed" : "none",
    },
    execution_limits: {
      max_invocation_seconds: maxInvocationSeconds,
      max_event_bytes: maxEventBytes,
    },
    trace_context: {
      trace_id: params.correlationId ?? params.invocation.id,
      span_id: params.invocation.id,
    },
    attempt: { attempt_no: 1 },
  };

  // 4. 调用 runtimeClient.startInvocation（带错误处理）
  let response: StartInvocationResponse;
  try {
    response = await params.runtimeClient.startInvocation({
      runtimeEndpoint,
      authToken,
      idempotencyKey: params.idempotencyKey,
      requestBody,
    });
  } catch (err) {
    if (err instanceof RuntimeHttpClientError) {
      // 网络不可达 → 跳过（Turn 保持 queued，不报错）
      if (err.kind === "network") {
        return {
          sessionBindingCreated: false,
          skipped: true,
          skipReason: "runtime_network_unavailable",
        };
      }
      // 503 RUNTIME_UNAVAILABLE → 跳过（Turn 保持 queued，不报错）
      if (err.kind === "http" && err.httpStatus === 503) {
        return {
          sessionBindingCreated: false,
          skipped: true,
          skipReason: "runtime_unavailable",
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
  let sessionBinding: V11RuntimeSessionBinding | undefined;
  let sessionBindingCreated = false;
  try {
    sessionBinding = await createSessionBinding({
      tenantId: params.tenantId,
      runtimeRevisionId: params.runtimeRevisionId,
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
      .select({ id: v11Thread.id })
      .from(v11Thread)
      .where(eq(v11Thread.id, params.threadId))
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
        .update(v11Invocation)
        .set({ runtimeSessionBindingId: sessionBinding.id })
        .where(eq(v11Invocation.id, params.invocation.id));
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
  invocation: V11Invocation;
  runtimeRevisionId: string;
  turn: V11Turn;
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
      .select({ id: v11Thread.id })
      .from(v11Thread)
      .where(eq(v11Thread.id, params.threadId))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new Error(`handleIdempotencyConflict: Thread 不存在（id=${params.threadId}）`);
    }

    await updateInvocationState(tx, params.tenantId, params.invocation.id, "running");

    await tx
      .update(v11Invocation)
      .set({ runtimeSessionBindingId: existing.id })
      .where(eq(v11Invocation.id, params.invocation.id));

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
    .from(v11Turn)
    .where(and(eq(v11Turn.threadId, params.threadId), eq(v11Turn.turnState, "accepted")));

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
