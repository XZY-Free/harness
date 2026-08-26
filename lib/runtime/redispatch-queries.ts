import { issueContextHandle } from "@/lib/context/context-handle";
import { getItemById } from "@/lib/conversations/thread-item-queries";
import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
/**
 * 重调度编排。
 *
 * 事实源：
 * - docs/architecture/persistence.md
 * - docs/architecture/conversations.md
 * - docs/architecture/api-and-events.md
 *
 * 职责：
 * - redispatchInvocation：为同一 Invocation 创建新 Attempt + 调用 Runtime startInvocation（attempt_no > 1）
 * + 标记旧 RuntimeSessionBinding 为 lost + 创建新 RuntimeSessionBinding + 更新 Invocation 状态 + 写 invocation.started Event。
 *
 * 关键约束：
 * - 不新建 continuation Invocation（同一 invocationId 重调度）。
 * - 不更换 ExecutionBinding（binding 不可变，1:1）。
 * - producer_sequence 在整个 Invocation 内连续，不按 Attempt 从 1 重启。
 * - 终态 Invocation 不可重调度（completed/failed/cancelled/lost）。
 * - 旧 RuntimeSessionBinding 必须标记为 lost（Runtime 内存状态已丢失，原 session 不可用）。
 * - 不伪造完成：Runtime 未接受时不能将 Invocation 转为 completed（§13）。
 *
 * 触发场景：
 * 1. Runtime resume 调用返回 requires_redispatch=true（Runtime 主动声明内存状态丢失）。
 * 2. 平台检测到 Worker 重启后通过恢复策略决定重调度（非 lost 终态）。
 *
 * 错误处理（与 dispatcher.ts dispatchToRuntime 一致）：
 * - kind=network → 跳过（Attempt 保持 queued，等待重试）。
 * - kind=http + 503 → 跳过（Attempt 保持 queued，等待重试）。
 * - kind=http + 409 IDEMPOTENCY_CONFLICT → 复用现有 SessionBinding，标记为成功。
 * - 其他错误 → 抛出（调用方决定是否重试）。
 */
import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import type { AgentRevision } from "@/lib/persistence/schema/agents";
import type { ThreadEvent, ThreadEventActorType } from "@/lib/persistence/schema/conversation";
import { threadTable } from "@/lib/persistence/schema/conversation";
import type {
  ExecutionBinding,
  Invocation,
  InvocationAttempt,
  InvocationExecutionState,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import { invocationTable } from "@/lib/persistence/schema/executions";
import type { RuntimeEndpointResolution } from "@/lib/runtime/dispatcher";
import {
  InvocationNotFoundError,
  RedispatchNotAllowedError,
  RuntimeHttpClientError,
  RuntimeSessionBindingConflictError,
} from "@/lib/runtime/errors";
import {
  createAttemptInternal,
  updateAttemptState,
} from "@/lib/runtime/invocation-attempt-queries";
import { getInvocationById, updateInvocationState } from "@/lib/runtime/invocation-queries";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import { getLatestProducerSequence } from "@/lib/runtime/recovery-queries";
import { RUNTIME_PROTOCOL_VERSION } from "@/lib/runtime/runtime-client";
import type {
  RuntimeHttpClient,
  StartInvocationRequestBody,
  StartInvocationResponse,
} from "@/lib/runtime/runtime-client";
import {
  createSessionBinding,
  getSessionBindingByExternalRef,
  markSessionBindingLost,
  updateLastUsedAt,
} from "@/lib/runtime/session-binding-queries";
import { and, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 允许重调度的非终态 Invocation 状态。 */
const REDISPATCH_ALLOWED_STATES: readonly InvocationExecutionState[] = [
  "queued",
  "running",
  "waiting_user",
];

/** redispatchInvocation 入参。 */
export interface RedispatchInvocationParams {
  tenantId: string;
  invocationId: string;
  /** 重调度原因码（如 requires_redispatch / runtime_lost / infra_error）。 */
  retryReasonCode: string;
  /** 重调度检查点引用（必须避开已确认副作用，事实源 L755）。 */
  checkpointRef?: string | null;
  /** Runtime HTTP 客户端。 */
  runtimeClient: RuntimeHttpClient;
  /** 从 ExecutionBinding 解析 runtimeEndpoint/authToken/gatewayEndpoints 的解析器。 */
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<RuntimeEndpointResolution>;
  /** RuntimeRevision id（用于创建新 SessionBinding）。 */
  runtimeRevisionId: string;
  /**
   * AgentRevision（用于构造 StartInvocationRequestBody）。Agent 可选（§8.3）：
   * 基础 Harness Route 为 null（无 Agent 资产约束），仅生成完整 Agent 字段与
   * agent_instruction_ref item 当且仅当存在 AgentRevision。
   */
  agentRevision: AgentRevision | null;
  /** 触发事件的 actor 类型（默认 system）。 */
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  /** 关联标识（X-Request-Id / traceparent）。 */
  correlationId?: string | null;
  /** Runtime 调用幂等键（不传则自动生成）。 */
  runtimeIdempotencyKey?: string | null;
}

/** redispatchInvocation 返回结果。 */
export interface RedispatchResult {
  /** 是否实际完成了重调度（false = Runtime 不可达，Attempt 保持 queued）。 */
  redispatched: boolean;
  /** 未完成原因（redispatched=false 时填）。 */
  skipReason?: "runtime_network_unavailable" | "runtime_unavailable";
  /** 更新后的 Invocation（executionState=running）。 */
  invocation?: Invocation;
  /** 新建的 Attempt（attemptState=running）。 */
  attempt?: InvocationAttempt;
  /** 旧 RuntimeSessionBinding（标记为 lost）。无旧绑定时为 null。 */
  previousSessionBinding?: RuntimeSessionBinding | null;
  /** 新 RuntimeSessionBinding。 */
  sessionBinding?: RuntimeSessionBinding;
  /** 是否新建了 SessionBinding（false 表示复用已存在）。 */
  sessionBindingCreated?: boolean;
  /** 写入的 invocation.started ThreadEvent（仅 Turn 模式）。 */
  invocationStartedEvent?: ThreadEvent | null;
  /** Runtime 响应。 */
  response?: StartInvocationResponse;
}

/**
 * 为同一 Invocation 创建新 Attempt 并调用 Runtime startInvocation 重调度。
 *
 * 事实源：docs/architecture/persistence.md 与 docs/architecture/conversations.md。
 *
 * 流程：
 * 1. 加载 Invocation（跨租户隔离）+ 校验状态 ∈ (queued, running, waiting_user)。
 * 2. 加载 ExecutionBinding（不可变 1:1）。
 * 3. 计算 producer_sequence_start = getLatestProducerSequence + 1。
 * 4. 事务内：SELECT FOR UPDATE Invocation + createAttemptInternal（attemptNo = max+1, queued）。
 * Attempt 行先持久化，但 attemptState 保持 queued，等 Runtime 接受后才转 running。
 * 5. 调用 runtimeClient.startInvocation（带 attempt_no > 1, attempt_id, retry_reason, checkpoint_ref, producer_sequence_start）。
 * 6. Runtime 接受：
 * - 创建新 RuntimeSessionBinding。
 * - 标记旧 RuntimeSessionBinding 为 lost（如有）。
 * - 事务内：CAS Invocation → running + 更新 runtimeExecutionRef/runtimeSessionBindingId +
 * CAS Attempt queued → running + 写 invocation.started ThreadEvent（仅 Turn 模式）。
 * 7. Runtime 网络不可达 / 503：返回 skipped=true，Attempt 保持 queued（调用方后续重试）。
 * 8. Runtime 409 IDEMPOTENCY_CONFLICT：复用现有 SessionBinding，按成功处理。
 *
 * 不变量：
 * - 同一 invocationId（不新建 continuation Invocation）。
 * - 同一 ExecutionBinding（不可变）。
 * - producer_sequence 在整个 Invocation 内连续。
 * - 旧 RuntimeSessionBinding 标记 lost（非 closed，表示异常失联）。
 *
 * @throws InvocationNotFoundError Invocation 不存在或跨租户不可见
 * @throws RedispatchNotAllowedError Invocation 已终态或不允许重调度
 */
export async function redispatchInvocation(
  params: RedispatchInvocationParams,
): Promise<RedispatchResult> {
  const actorType: ThreadEventActorType = params.actorType ?? "system";

  // 1. 加载 Invocation + 校验状态
  const invocation = await getInvocationById(params.tenantId, params.invocationId);
  if (!invocation) {
    throw new InvocationNotFoundError(params.invocationId);
  }
  if (!REDISPATCH_ALLOWED_STATES.includes(invocation.executionState)) {
    throw new RedispatchNotAllowedError(params.invocationId, invocation.executionState);
  }

  // 2. 加载 ExecutionBinding（不可变 1:1）
  const binding = await getExecutionBindingByInvocation(params.tenantId, params.invocationId);
  if (!binding) {
    throw new InvocationNotFoundError(params.invocationId);
  }

  // 3. 计算 producer_sequence_start（整个 Invocation 内连续，）
  const latestSeq = await getLatestProducerSequence(params.tenantId, params.invocationId);
  const producerSequenceStart = (latestSeq ?? 0) + 1;

  // 4. 事务内：SELECT FOR UPDATE Invocation + createAttemptInternal
  // 注意：Attempt 行先创建为 queued，等 Runtime 接受后才转 running
  // 若 Runtime 不可达，Attempt 保持 queued，后续可由恢复流程重新调度
  const newAttempt = await db.transaction(async (tx) => {
    // SELECT FOR UPDATE Invocation（防止并发重调度）
    const [current] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, params.tenantId),
          eq(invocationTable.id, params.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) {
      throw new InvocationNotFoundError(params.invocationId);
    }
    if (!REDISPATCH_ALLOWED_STATES.includes(current.executionState)) {
      throw new RedispatchNotAllowedError(params.invocationId, current.executionState);
    }

    // 创建新 Attempt（attemptNo = max+1, queued）
    return createAttemptInternal(tx, {
      invocationId: params.invocationId,
      retryReasonCode: params.retryReasonCode,
      checkpointRef: params.checkpointRef ?? null,
    });
  });

  // 5. 调用 runtimeClient.startInvocation（带 attempt 字段）
  const { runtimeEndpoint, authToken, gatewayEndpoints, governanceConfig, gatewayAccess } =
    await params.runtimeEndpointResolver(binding);

  // 读取 RuntimeRevision 获取 capabilities（用于 execution_limits）
  const runtimeRevision = await getRuntimeRevisionById(params.runtimeRevisionId);
  if (!runtimeRevision) {
    throw new Error(
      `redispatchInvocation: RuntimeRevision 不存在（id=${params.runtimeRevisionId}）`,
    );
  }
  const caps = runtimeRevision.runtimeCapabilitiesJson as {
    limits?: { max_invocation_seconds?: number; max_event_bytes?: number };
  } | null;
  const maxInvocationSeconds = caps?.limits?.max_invocation_seconds ?? 600;
  const maxEventBytes = caps?.limits?.max_event_bytes ?? 1_048_576;

  // 构造 StartInvocationRequestBody（带 attempt_no > 1 + 重调度字段）
  const contextHandle = await issueContextHandle({
    tenantId: params.tenantId,
    invocationId: params.invocationId,
  });

  // input_items 构造（与 dispatcher.ts 一致；triggerItem 可能不存在于 Job 模式）
  const inputItems: unknown[] = [
    {
      type: "platform_rule",
      content: "仅使用当前 Invocation 授权的 Context Gateway 与 Workspace 资源。",
    },
    // Agent 可选（§8.3）：仅有 AgentRevision 时加入 agent_instruction_ref；
    // 基础 Harness Route（无 Agent）不生成该 item。
    ...(params.agentRevision
      ? [
          {
            type: "agent_instruction_ref",
            agent_revision_id: params.agentRevision.id,
          },
        ]
      : []),
    {
      type: "resource_index",
      sources: ["recent_items", "skill", "workspace_map", "memory", "knowledge"],
    },
  ];
  if (invocation.triggerItemId) {
    const triggerItem = await getItemById(params.tenantId, invocation.triggerItemId);
    if (triggerItem) {
      inputItems.splice(2, 0, {
        type: "user_message",
        item_id: triggerItem.id,
        content: triggerItem.contentJson,
      });
    }
  }

  const requestBody: StartInvocationRequestBody = {
    protocol_version: RUNTIME_PROTOCOL_VERSION,
    invocation_id: params.invocationId,
    turn_context: invocation.threadId
      ? {
          thread_id: invocation.threadId,
          turn_id: invocation.turnId ?? "",
          trigger_item_id: invocation.triggerItemId ?? null,
        }
      : null,
    job_context: invocation.jobId
      ? {
          job_id: invocation.jobId,
          trigger_item_id: invocation.triggerItemId ?? null,
        }
      : null,
    agent: params.agentRevision
      ? {
          agent_revision_id: params.agentRevision.id,
          model_policy: (params.agentRevision.modelPolicyJson ?? {}) as Record<string, unknown>,
          permission_requirements: (params.agentRevision.permissionRequirementsJson ??
            {}) as Record<string, unknown>,
          interface_requirements: (params.agentRevision.agentInterfaceRequirementsJson ??
            {}) as Record<string, unknown>,
        }
      : null,
    input_items: inputItems,
    context_handle: contextHandle,
    gateway_endpoints: gatewayEndpoints,
    governance_config: governanceConfig,
    gateway_access: gatewayAccess,
    workspace: {
      workspace_binding_id: binding.workspaceBindingId,
      workspace_type: binding.workspaceBindingId ? "managed" : "none",
    },
    execution_limits: {
      max_invocation_seconds: maxInvocationSeconds,
      max_event_bytes: maxEventBytes,
    },
    trace_context: {
      trace_id: params.correlationId ?? params.invocationId,
      span_id: params.invocationId,
    },
    attempt: {
      attempt_no: newAttempt.attemptNo,
      attempt_id: newAttempt.id,
      retry_reason: params.retryReasonCode,
      checkpoint_ref: params.checkpointRef ?? undefined,
      producer_sequence_start: producerSequenceStart,
    },
  };

  const idempotencyKey =
    params.runtimeIdempotencyKey ??
    `redispatch-${params.invocationId}-attempt-${newAttempt.attemptNo}`;

  let response: StartInvocationResponse;
  try {
    response = await params.runtimeClient.startInvocation({
      runtimeEndpoint,
      authToken,
      idempotencyKey,
      requestBody,
    });
  } catch (err) {
    if (err instanceof RuntimeHttpClientError) {
      // 网络不可达 → 跳过（Attempt 保持 queued，等待重试）
      if (err.kind === "network") {
        return {
          redispatched: false,
          skipReason: "runtime_network_unavailable",
          attempt: newAttempt,
        };
      }
      // 503 RUNTIME_UNAVAILABLE → 跳过（Attempt 保持 queued，等待重试）
      if (err.kind === "http" && err.httpStatus === 503) {
        return {
          redispatched: false,
          skipReason: "runtime_unavailable",
          attempt: newAttempt,
        };
      }
      // 409 IDEMPOTENCY_CONFLICT → 复用现有 SessionBinding，按成功处理
      if (
        err.kind === "http" &&
        err.httpStatus === 409 &&
        err.runtimeErrorCode === "IDEMPOTENCY_CONFLICT"
      ) {
        return await handleIdempotencyConflict(params, invocation, newAttempt, actorType);
      }
    }
    throw err;
  }

  // 6. Runtime 接受：创建新 SessionBinding + 标记旧 SessionBinding lost + 事务内更新状态 + 写 Event
  // 6.1 创建新 SessionBinding
  let sessionBinding: RuntimeSessionBinding | undefined;
  let sessionBindingCreated = false;
  try {
    sessionBinding = await createSessionBinding({
      tenantId: params.tenantId,
      runtimeRevisionId: params.runtimeRevisionId,
      threadId: invocation.threadId ?? null,
      jobId: invocation.jobId ?? null,
      externalSessionRef: response.runtime_session_ref,
    });
    sessionBindingCreated = true;
  } catch (err) {
    if (err instanceof RuntimeSessionBindingConflictError) {
      const existing = await getSessionBindingByExternalRef(
        params.runtimeRevisionId,
        response.runtime_session_ref,
      );
      if (existing) {
        sessionBinding = existing;
        sessionBindingCreated = false;
      } else {
        // 理论不应发生，按跳过处理
        return {
          redispatched: false,
          skipReason: "runtime_unavailable",
          attempt: newAttempt,
        };
      }
    } else {
      throw err;
    }
  }

  // 6.2 标记旧 RuntimeSessionBinding 为 lost（如有）
  let previousSessionBinding: RuntimeSessionBinding | null = null;
  if (invocation.runtimeSessionBindingId) {
    previousSessionBinding = await markSessionBindingLost(invocation.runtimeSessionBindingId);
  }

  // 6.3 事务内：CAS Invocation → running + CAS Attempt queued → running + 写 invocation.started Event
  let invocationStartedEvent: ThreadEvent | null = null;
  let updatedAttempt: InvocationAttempt | null = null;
  const updatedInvocation = await db.transaction(async (tx) => {
    // 锁定 Thread 行（仅 Turn 模式，与 dispatcher.ts 一致）
    if (invocation.threadId) {
      const [thread] = await tx
        .select({ id: threadTable.id })
        .from(threadTable)
        .where(eq(threadTable.id, invocation.threadId))
        .for("update")
        .limit(1);
      if (!thread) {
        throw new Error(`redispatchInvocation: Thread 不存在（id=${invocation.threadId}）`);
      }
    }

    // CAS Invocation → running（从 queued/running/waiting_user 都允许转到 running）
    // 若已是 running，状态机不允许 running → running，需先转 queued 再转 running
    // 实际上 状态机：running → waiting_user/completed/failed/cancelled/lost（无 running → running）
    // waiting_user → running/cancelled/failed/lost（允许 waiting_user → running）
    // queued → running/cancelled/failed/lost（允许 queued → running）
    // 因此对已 running 的 Invocation，不调用 updateInvocationState（保持 running 状态），仅更新 runtimeExecutionRef
    let updated: Invocation;
    if (invocation.executionState === "running") {
      // 已 running：仅更新 runtimeExecutionRef + runtimeSessionBindingId（不调状态机）
      const now = new Date();
      await tx
        .update(invocationTable)
        .set({
          runtimeExecutionRef: response.runtime_execution_ref,
          runtimeSessionBindingId: sessionBinding?.id ?? invocation.runtimeSessionBindingId,
          lastHeartbeatAt: now,
          versionNo: invocation.versionNo + 1,
          updatedAt: now,
        })
        .where(eq(invocationTable.id, params.invocationId));
      const [refreshed] = await tx
        .select()
        .from(invocationTable)
        .where(eq(invocationTable.id, params.invocationId))
        .limit(1);
      if (!refreshed) {
        throw new Error(`redispatchInvocation: Invocation 行未找到（id=${params.invocationId}）`);
      }
      updated = refreshed;
    } else {
      // queued / waiting_user → running（状态机允许）
      await updateInvocationState(tx, params.tenantId, params.invocationId, "running", {
        runtimeExecutionRef: response.runtime_execution_ref,
      });
      // 设置 runtimeSessionBindingId（updateInvocationState 不含此字段，单独更新）
      if (sessionBinding) {
        await tx
          .update(invocationTable)
          .set({ runtimeSessionBindingId: sessionBinding.id })
          .where(eq(invocationTable.id, params.invocationId));
      }
      // 重新查询以反映 runtimeSessionBindingId 更新
      const [refreshed] = await tx
        .select()
        .from(invocationTable)
        .where(eq(invocationTable.id, params.invocationId))
        .limit(1);
      if (!refreshed) {
        throw new Error(`redispatchInvocation: Invocation 行未找到（id=${params.invocationId}）`);
      }
      updated = refreshed;
    }

    // CAS Attempt queued → running（捕获刷新后的 Attempt 行用于返回）
    updatedAttempt = await updateAttemptState(tx, newAttempt.id, "running", {
      runtimeExecutionRef: response.runtime_execution_ref,
      startedAt: new Date(),
    });

    // 写 invocation.started ThreadEvent（仅 Turn 模式；payload 包含 attempt_no 重调度信息）
    if (updated.threadId) {
      const seq = await allocateEventSequences(tx, updated.threadId, 1);
      invocationStartedEvent = await insertThreadEvent(tx, updated.threadId, seq, {
        eventType: "invocation.started",
        turnId: updated.turnId ?? undefined,
        invocationId: updated.id,
        actorType,
        actorId: params.actorId ?? undefined,
        payload: {
          runtime_session_ref: response.runtime_session_ref,
          runtime_execution_ref: response.runtime_execution_ref,
          runtime_session_binding_id: sessionBinding?.id ?? null,
          attempt_no: newAttempt.attemptNo,
          attempt_id: newAttempt.id,
          retry_reason: params.retryReasonCode,
          checkpoint_ref: params.checkpointRef ?? null,
          producer_sequence_start: producerSequenceStart,
          redispatched: true,
          previous_session_binding_id: previousSessionBinding?.id ?? null,
        },
        correlationId: params.correlationId ?? undefined,
      });
    }

    return updated;
  });

  // 6.4 刷新 sessionBinding.lastUsedAt
  if (sessionBinding) {
    await updateLastUsedAt(sessionBinding.id);
  }

  return {
    redispatched: true,
    invocation: updatedInvocation,
    attempt: updatedAttempt ?? newAttempt,
    previousSessionBinding: previousSessionBinding,
    sessionBinding,
    sessionBindingCreated,
    invocationStartedEvent,
    response,
  };
}

/**
 * 处理 Runtime 409 IDEMPOTENCY_CONFLICT（幂等复用）。
 *
 * 与 dispatcher.ts handleIdempotencyConflict 一致：复用现有 SessionBinding，
 * 但仍需完成 Attempt 状态转换 + Event 写入。
 */
async function handleIdempotencyConflict(
  params: RedispatchInvocationParams,
  invocation: Invocation,
  newAttempt: InvocationAttempt,
  actorType: ThreadEventActorType,
): Promise<RedispatchResult> {
  // 查找现有 SessionBinding（按 externalSessionRef 无法获取，因为 409 时 response 未拿到）
  // 此处简化处理：复用 Invocation 当前 runtimeSessionBindingId
  let sessionBinding: RuntimeSessionBinding | undefined;
  if (invocation.runtimeSessionBindingId) {
    // 旧 SessionBinding 保持原样（不标记 lost，因为是幂等复用，非失联）
    // 直接读取（markSessionBindingLost/closeSessionBinding 都会读，这里也需要读）
    // 但为保持简单，直接使用 invocation.runtimeSessionBindingId 作为复用标识
    sessionBinding = undefined; // 不创建新 binding，沿用 invocation.runtimeSessionBindingId
  }

  // 事务内：CAS Attempt queued → running（即使没有 runtime_execution_ref，也按 running 处理）
  let invocationStartedEvent: ThreadEvent | null = null;
  let updatedAttempt: InvocationAttempt | null = null;
  const updatedInvocation = await db.transaction(async (tx) => {
    if (invocation.threadId) {
      const [thread] = await tx
        .select({ id: threadTable.id })
        .from(threadTable)
        .where(eq(threadTable.id, invocation.threadId))
        .for("update")
        .limit(1);
      if (!thread) {
        throw new Error(`redispatchInvocation: Thread 不存在（id=${invocation.threadId}）`);
      }
    }

    // 已 running 时不调状态机；queued/waiting_user → running
    let updated: Invocation;
    if (invocation.executionState === "running") {
      const now = new Date();
      await tx
        .update(invocationTable)
        .set({
          lastHeartbeatAt: now,
          versionNo: invocation.versionNo + 1,
          updatedAt: now,
        })
        .where(eq(invocationTable.id, params.invocationId));
      const [refreshed] = await tx
        .select()
        .from(invocationTable)
        .where(eq(invocationTable.id, params.invocationId))
        .limit(1);
      if (!refreshed) {
        throw new Error(`redispatchInvocation: Invocation 行未找到（id=${params.invocationId}）`);
      }
      updated = refreshed;
    } else {
      updated = await updateInvocationState(tx, params.tenantId, params.invocationId, "running");
    }

    // CAS Attempt queued → running（捕获刷新后的 Attempt 行用于返回）
    updatedAttempt = await updateAttemptState(tx, newAttempt.id, "running", {
      startedAt: new Date(),
    });

    // 写 invocation.started Event（标记为幂等复用）
    if (updated.threadId) {
      const seq = await allocateEventSequences(tx, updated.threadId, 1);
      invocationStartedEvent = await insertThreadEvent(tx, updated.threadId, seq, {
        eventType: "invocation.started",
        turnId: updated.turnId ?? undefined,
        invocationId: updated.id,
        actorType,
        actorId: params.actorId ?? undefined,
        payload: {
          runtime_session_ref: null,
          runtime_execution_ref: null,
          runtime_session_binding_id: invocation.runtimeSessionBindingId ?? null,
          attempt_no: newAttempt.attemptNo,
          attempt_id: newAttempt.id,
          retry_reason: params.retryReasonCode,
          checkpoint_ref: params.checkpointRef ?? null,
          idempotency_conflict: true,
          redispatched: true,
        },
        correlationId: params.correlationId ?? undefined,
      });
    }

    return updated;
  });

  return {
    redispatched: true,
    invocation: updatedInvocation,
    attempt: updatedAttempt ?? newAttempt,
    previousSessionBinding: null, // 幂等复用不标记旧 binding lost
    sessionBinding,
    sessionBindingCreated: false,
    invocationStartedEvent,
  };
}

/** 导出事务句柄类型与常量供外部组合事务使用。 */
export type { Tx };
export { REDISPATCH_ALLOWED_STATES };
