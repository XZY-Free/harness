import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
/**
 * 命令调度器。
 *
 * 事实源：
 * - docs/architecture/persistence.md （InvocationCommand 表）、-（Invocation/Binding/Attempt）
 * - docs/architecture/agent-control-plane.md （Steer）、（Stop/Interrupt）、（Regenerate）、（Resume）
 * - docs/architecture/api-and-events.md §4（Runtime Protocol API：cancel/resume/steer）
 * - docs/architecture/runtime-control-plane.md
 * - docs/V12/01/SnowHarness_九项问题最终代码收口方案_2026-08-27/01-DurableDispatch与RetryAuthority.md §七
 *
 * 职责：
 * - dispatchSteerCommand：将 queued Steer 命令调度到 Runtime（POST /invocations/{id}:steer），ack 后标记 acknowledged + 写 turn.steered。
 * - dispatchCancelCommand：将 queued Interrupt 命令调度到 Runtime（POST /invocations/{id}:cancel），ack 后标记 acknowledged（Turn 终态由 ingress execution.cancelled 推进）。
 * - dispatchResumeCommand：将 queued Resume 命令调度到 Runtime（POST /invocations/{id}:resume），ack 后标记 acknowledged + Invocation waiting_user → running + 写 turn.resumed/invocation.resumed。
 * - retryDispatchedInvocationCommand：Durable Retry Worker 领取 dispatched Command 后用同一 idempotency key 重新发起 HTTP。
 *
 * 命令状态机（不可逆，不新增 retry_wait 状态）：
 * - queued → dispatched → acknowledged/failed
 * - transient（网络/503）通过 retry scheduling 字段表达：dispatchAttemptCount /
 *   nextDispatchAt / dispatchLease* / lastTransientErrorCode；状态保持 dispatched。
 * - 已成功副作用不可撤销；Runtime 拒绝时不能伪造成功（command 标记 failed）。
 *
 * 错误处理（与 dispatcher.ts dispatchToRuntime 一致）：
 * - kind=network / HTTP 503 → 保持 dispatched + nextDispatchAt（durable retry，由 Runtime
 *   Dispatch Retry Worker 领取；耗尽 → failed(retry_exhausted)，Resume 由唯一 Recovery
 *   Authority 收口）。
 * - kind=http + 409 IDEMPOTENCY_CONFLICT → 幂等复用，标记 acknowledged。
 * - 其他错误 → 标记 failed（Runtime 拒绝，不伪造成功）。
 *
 * 关键约束：
 * - Cancel 在 Runtime ack 前先写 turn.interrupt_requested（由 requestInterrupt 入队时写，不等 Runtime ack）。
 * - Steer 不创建第二个 Turn（将 user_guidance Item 加入当前 Turn）。
 * - waiting_user 必须解析对应 UserActionRequest（Resume 携带 resume_payload）。
 * - Resume 不能新建 continuation Invocation（只恢复原 Invocation）。
 * - 同一 Command 的所有 retry 必须使用稳定 Runtime Idempotency-Key（命令 idempotencyKey 不变）。
 */
import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import type { AgentRevision } from "@/lib/persistence/schema/agents";
import type {
  InvocationCommand,
  ThreadEvent,
  ThreadEventActorType,
} from "@/lib/persistence/schema/conversation";
import {
  invocationCommandTable,
  threadTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import type { ExecutionBinding, Invocation } from "@/lib/persistence/schema/executions";
import { invocationTable } from "@/lib/persistence/schema/executions";
import type { RuntimeTransportAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import {
  CommandAlreadyDispatchedError,
  CommandInvocationNotFoundError,
  CommandNotFoundError,
  ResumeInvocationNotWaitingError,
  RuntimeHttpClientError,
} from "@/lib/runtime/errors";
import { getInvocationById, updateInvocationState } from "@/lib/runtime/invocation-queries";
import { markInvocationLost } from "@/lib/runtime/recovery-queries";
import { redispatchInvocation } from "@/lib/runtime/redispatch-queries";
import {
  recordCommandRetryAttemptStarted,
  scheduleCommandTransientRetry,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import { RUNTIME_DISPATCH_RETRY_POLICY } from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import type {
  CancelInvocationRequest,
  GatewayAccess,
  GatewayEndpoints,
  GovernanceConfigRef,
  ResumeInvocationRequest,
  ResumeInvocationResponse,
  RuntimeHttpClient,
  SteerInvocationRequest,
} from "@/lib/runtime/runtime-client";
import { RuntimeTransportError } from "@/lib/runtime/transport/runtime-transport";
import { and, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** RuntimeEndpointResolution（与 dispatcher.ts 一致，从此处独立声明避免循环依赖）。 */
export interface CommandRuntimeEndpointResolution {
  /** Runtime HTTP 端点基础 URL。 */
  runtimeEndpoint: string;
  /** Outbound auth（03 §8）：Hosted=Workload Token；External=CredentialRef 凭据。 */
  auth: RuntimeTransportAuth;
  /**
   * 平台 Gateway 回调端点（requires_redispatch=true 时必需，供 redispatchInvocation
   * 构造 StartInvocationRequestBody 使用）。
   *
   * cancel/steer 命令不需要此字段；resume 命令在 requires_redispatch=true 分支需要。
   */
  gatewayEndpoints?: GatewayEndpoints;
  /** §24：Binding 冻结 Governance Config 引用（resume 重调度 startInvocation 时需要）。 */
  governanceConfig?: GovernanceConfigRef;
  /** §27/§28：Gateway Access Token（resume 必须重签新 token 下发给 Runtime）。 */
  gatewayAccess?: GatewayAccess;
}

/** 命令调度结果。 */
export interface CommandDispatchResult {
  /** 命令 id。 */
  commandId: string;
  /** 最终命令状态。 */
  commandState: "acknowledged" | "failed" | "dispatched";
  /** Runtime 调度是否被跳过（网络不可达/503 → 保持 dispatched，durable retry 已排定）。 */
  skipped?: boolean;
  /** 跳过原因（skipped=true 时填）。 */
  skipReason?: "runtime_network_unavailable" | "runtime_unavailable";
  /** transient 已排定 durable retry 的详情（skipped=true 时填）。 */
  pendingRetry?: {
    nextDispatchAt: Date;
    dispatchAttemptCount: number;
  };
  /** transient 耗尽后命令已终态 failed（skipped=true 时可能填）。 */
  retryExhausted?: boolean;
  /** Runtime 执行引用（dispatched/acknowledged 时填）。 */
  runtimeExecutionRef?: string;
  /** ack 时间（acknowledged 时填）。 */
  acknowledgedAt?: Date;
  /** 失败时间（failed 时填）。 */
  failedAt?: Date;
  /** 失败错误码（failed 时填）。 */
  errorCode?: string;
  /** 失败错误消息（failed 时填）。 */
  errorMessage?: string;
  /** 调度产生的事件（ack 后写入的 turn.steered/turn.resumed/invocation.resumed 等）。 */
  events: ThreadEvent[];
  /**
   * Resume 命令是否触发了重调度（Runtime 返回 requires_redispatch=true）。
   * true 时表示平台为同一 Invocation 创建了新 Attempt 并重新调用 Runtime startInvocation。
   */
  redispatched?: boolean;
}

// ─── 公共辅助：加载命令 + 校验状态 ────────────────────────

/** InvocationCommand 行 + 关联 Invocation 的加载结果。 */
interface LoadedCommand {
  command: {
    id: string;
    commandType: string;
    commandState: string;
    invocationId: string | null;
    threadId: string;
    turnId: string | null;
    commandPayloadJson: unknown;
    idempotencyKey: string | null;
  };
  invocation: Invocation;
  binding: ExecutionBinding;
}

/**
 * 加载命令 + 关联 Invocation + ExecutionBinding（跨租户隔离）。
 *
 * @param expectedState "queued"（首次调度）或 "dispatched"（Durable Retry Worker 领取）。
 * @throws CommandNotFoundError 命令不存在或跨租户不可见
 * @throws CommandAlreadyDispatchedError 命令状态与 expectedState 不符
 * @throws CommandInvocationNotFoundError 命令关联的 Invocation 不存在
 */
async function loadCommand(
  tenantId: string,
  commandId: string,
  expectedState: "queued" | "dispatched",
): Promise<LoadedCommand> {
  const [commandRow] = await db
    .select()
    .from(invocationCommandTable)
    .where(eq(invocationCommandTable.id, commandId))
    .limit(1);

  // 跨租户隔离：通过 threadId 关联租户校验
  if (!commandRow) {
    throw new CommandNotFoundError(commandId);
  }

  // 通过 Thread 校验租户归属
  const [threadRow] = await db
    .select({ tenantId: threadTable.tenantId })
    .from(threadTable)
    .where(eq(threadTable.id, commandRow.threadId))
    .limit(1);
  if (!threadRow || threadRow.tenantId !== tenantId) {
    throw new CommandNotFoundError(commandId);
  }

  // 校验命令状态
  if (commandRow.commandState !== expectedState) {
    throw new CommandAlreadyDispatchedError(commandId, commandRow.commandState);
  }

  // 校验 invocationId 已绑定
  if (!commandRow.invocationId) {
    throw new CommandInvocationNotFoundError("<null>");
  }

  const invocation = await getInvocationById(tenantId, commandRow.invocationId);
  if (!invocation) {
    throw new CommandInvocationNotFoundError(commandRow.invocationId);
  }

  const binding = await getExecutionBindingByInvocation(tenantId, invocation.id);
  if (!binding) {
    throw new CommandInvocationNotFoundError(invocation.id);
  }

  return {
    command: {
      id: commandRow.id,
      commandType: commandRow.commandType,
      commandState: commandRow.commandState,
      invocationId: commandRow.invocationId,
      threadId: commandRow.threadId,
      turnId: commandRow.turnId,
      commandPayloadJson: commandRow.commandPayloadJson,
      idempotencyKey: commandRow.idempotencyKey,
    },
    invocation,
    binding,
  };
}

/** 兼容旧名（首次调度入口）。 */
async function loadCommandForDispatch(tenantId: string, commandId: string): Promise<LoadedCommand> {
  return loadCommand(tenantId, commandId, "queued");
}

/**
 * 事务内 CAS 转换命令状态（queued → dispatched），同时登记 dispatch 计数与 lease。
 *
 * @returns true=成功转换；false=并发冲突（已被其他调度器处理）
 */
async function transitionCommandToDispatched(
  tx: Tx,
  commandId: string,
  runtimeExecutionRef: string | null,
  leaseOwner = "api-dispatcher",
): Promise<boolean> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + RUNTIME_DISPATCH_RETRY_POLICY.leaseDurationMs);
  const result = await tx
    .update(invocationCommandTable)
    .set({
      commandState: "dispatched",
      dispatchedAt: now,
      runtimeExecutionRef,
      dispatchAttemptCount: 1,
      lastDispatchAttemptAt: now,
      dispatchLeaseOwner: leaseOwner,
      dispatchLeaseExpiresAt: leaseExpiresAt,
      nextDispatchAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(invocationCommandTable.id, commandId),
        eq(invocationCommandTable.commandState, "queued"),
      ),
    );
  return result[0].affectedRows > 0;
}

/**
 * 事务内 CAS 转换命令状态（dispatched → acknowledged），并清 lease/nextDispatchAt。
 */
async function transitionCommandToAcknowledged(tx: Tx, commandId: string): Promise<void> {
  const now = new Date();
  await tx
    .update(invocationCommandTable)
    .set({
      commandState: "acknowledged",
      acknowledgedAt: now,
      dispatchLeaseOwner: null,
      dispatchLeaseExpiresAt: null,
      nextDispatchAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(invocationCommandTable.id, commandId),
        eq(invocationCommandTable.commandState, "dispatched"),
      ),
    );
}

/**
 * 标记命令失败（dispatched → failed，事务外调用），并清 lease/nextDispatchAt。
 *
 * Runtime 拒绝时不能伪造成功。
 */
async function markCommandFailed(
  commandId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(invocationCommandTable)
    .set({
      commandState: "failed",
      failedAt: now,
      errorCode,
      errorMessage,
      dispatchLeaseOwner: null,
      dispatchLeaseExpiresAt: null,
      nextDispatchAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(invocationCommandTable.id, commandId),
        eq(invocationCommandTable.commandState, "dispatched"),
      ),
    );
}

/**
 * 标记命令 acknowledged（dispatched → acknowledged，事务外调用，用于幂等冲突复用场景）。
 */
async function markCommandAcknowledged(commandId: string): Promise<void> {
  const now = new Date();
  await db
    .update(invocationCommandTable)
    .set({
      commandState: "acknowledged",
      acknowledgedAt: now,
      dispatchLeaseOwner: null,
      dispatchLeaseExpiresAt: null,
      nextDispatchAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(invocationCommandTable.id, commandId),
        eq(invocationCommandTable.commandState, "dispatched"),
      ),
    );
}

// ─── dispatchSteerCommand ─────────────────────────────────

/** Steer 执行入参（首次调度与 retry 共用）。 */
interface SteerExecutionParams {
  tenantId: string;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}

/**
 * 调度 Steer 命令到 Runtime（首次：queued → dispatched → 执行）。
 *
 * 关键约束：
 * - Steer 不创建第二个 Turn，将 user_guidance Item 加入当前 Turn。
 * - Runtime 拒绝时不能伪造成功（command 标记 failed）。
 *
 * @throws CommandNotFoundError 命令不存在或跨租户不可见
 * @throws CommandAlreadyDispatchedError 命令已调度
 * @throws CommandInvocationNotFoundError 关联 Invocation 不存在
 */
export async function dispatchSteerCommand(params: {
  tenantId: string;
  commandId: string;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<CommandDispatchResult> {
  const loaded = await loadCommandForDispatch(params.tenantId, params.commandId);

  if (loaded.command.commandType !== "steer") {
    throw new CommandAlreadyDispatchedError(loaded.command.id, loaded.command.commandType);
  }

  // 1. 事务内 CAS queued → dispatched（含 dispatchAttemptCount=1 + lease）
  const transitioned = await db.transaction(async (tx) =>
    transitionCommandToDispatched(tx, loaded.command.id, null),
  );
  if (!transitioned) {
    // 并发冲突：已被其他调度器处理
    throw new CommandAlreadyDispatchedError(loaded.command.id, "dispatched");
  }

  return executeSteerDispatch(
    {
      tenantId: params.tenantId,
      runtimeClient: params.runtimeClient,
      runtimeEndpointResolver: params.runtimeEndpointResolver,
      actorType: params.actorType,
      actorId: params.actorId,
      correlationId: params.correlationId,
    },
    loaded,
  );
}

/** Steer 命令执行核心（命令已处于 dispatched 状态；首次与 retry 共用）。 */
async function executeSteerDispatch(
  params: SteerExecutionParams,
  loaded: LoadedCommand,
): Promise<CommandDispatchResult> {
  const actorType: ThreadEventActorType = params.actorType ?? "system";

  // 2. 解析 runtimeEndpoint + auth
  const { runtimeEndpoint, auth } = await params.runtimeEndpointResolver(loaded.binding);

  // 3. 构造 steer 请求（稳定 idempotency key：命令 idempotencyKey 不变）
  const steerPayload = loaded.command.commandPayloadJson as Record<string, unknown>;
  const runtimeIdempotencyKey = loaded.command.idempotencyKey ?? `steer-${loaded.command.id}`;
  const traceContext = params.correlationId
    ? { trace_id: params.correlationId, span_id: loaded.invocation.id }
    : null;

  const request: SteerInvocationRequest = {
    runtimeEndpoint,
    auth,
    invocationId: loaded.invocation.id,
    idempotencyKey: runtimeIdempotencyKey,
    requestBody: {
      steer_payload: steerPayload,
      trace_context: traceContext,
    },
  };

  // 4. 调用 Runtime
  try {
    await params.runtimeClient.steerInvocation(request);
  } catch (err) {
    return handleRuntimeError(err, loaded, params);
  }

  // 5. 成功：事务内 CAS dispatched → acknowledged + 写 turn.steered Event
  // ack 事件使用派生唯一 key（不复用命令的 idempotencyKey，避免与 turn.steer_queued 冲突）
  const steerAckIdempotencyKey = `steer-ack-${loaded.command.id}`;
  const events = await db.transaction(async (tx) => {
    await transitionCommandToAcknowledged(tx, loaded.command.id);

    // 写 turn.steered Event（Steer 不创建第二个 Turn，只标记已引导）
    if (loaded.invocation.threadId && loaded.command.turnId) {
      const seq = await allocateEventSequences(tx, loaded.invocation.threadId, 1);
      const event = await insertThreadEvent(tx, loaded.invocation.threadId, seq, {
        eventType: "turn.steered",
        turnId: loaded.command.turnId,
        invocationId: loaded.invocation.id,
        actorType,
        actorId: params.actorId ?? undefined,
        payload: {
          command_id: loaded.command.id,
          guidance_item_id: steerPayload.guidance_item_id ?? null,
          runtime_acknowledged: true,
        },
        correlationId: params.correlationId ?? undefined,
        idempotencyKey: steerAckIdempotencyKey,
      });
      return [event];
    }
    return [];
  });

  return {
    commandId: loaded.command.id,
    commandState: "acknowledged",
    runtimeExecutionRef: undefined,
    acknowledgedAt: new Date(),
    events,
  };
}

// ─── dispatchCancelCommand ────────────────────────────────

/** Cancel 执行入参（首次调度与 retry 共用）。 */
interface CancelExecutionParams {
  tenantId: string;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}

/**
 * 调度 Cancel（Interrupt）命令到 Runtime（首次：queued → dispatched → 执行）。
 *
 * 关键约束：
 * - Cancel 在 Runtime ack 前先写 turn.interrupt_requested（由 requestInterrupt 入队时写）。
 * - 已成功副作用不可撤销。
 * - Runtime 拒绝时不能伪造成功（command 标记 failed）。
 *
 * @throws CommandNotFoundError 命令不存在或跨租户不可见
 * @throws CommandAlreadyDispatchedError 命令已调度
 * @throws CommandInvocationNotFoundError 关联 Invocation 不存在
 */
export async function dispatchCancelCommand(params: {
  tenantId: string;
  commandId: string;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<CommandDispatchResult> {
  const loaded = await loadCommandForDispatch(params.tenantId, params.commandId);

  if (loaded.command.commandType !== "interrupt") {
    throw new CommandAlreadyDispatchedError(loaded.command.id, loaded.command.commandType);
  }

  // 1. 事务内 CAS queued → dispatched（含 dispatchAttemptCount=1 + lease）
  const transitioned = await db.transaction(async (tx) =>
    transitionCommandToDispatched(tx, loaded.command.id, null),
  );
  if (!transitioned) {
    throw new CommandAlreadyDispatchedError(loaded.command.id, "dispatched");
  }

  return executeCancelDispatch(
    {
      tenantId: params.tenantId,
      runtimeClient: params.runtimeClient,
      runtimeEndpointResolver: params.runtimeEndpointResolver,
      actorType: params.actorType,
      actorId: params.actorId,
      correlationId: params.correlationId,
    },
    loaded,
  );
}

/** Cancel 命令执行核心（命令已处于 dispatched 状态；首次与 retry 共用）。 */
async function executeCancelDispatch(
  params: CancelExecutionParams,
  loaded: LoadedCommand,
): Promise<CommandDispatchResult> {
  // 2. 解析 runtimeEndpoint + auth
  const { runtimeEndpoint, auth } = await params.runtimeEndpointResolver(loaded.binding);

  // 3. 构造 cancel 请求（稳定 idempotency key：命令 idempotencyKey 不变）
  const commandPayload = loaded.command.commandPayloadJson as Record<string, unknown>;
  const reason =
    typeof commandPayload.reason_code === "string" ? commandPayload.reason_code : "user_cancel";
  const runtimeIdempotencyKey = loaded.command.idempotencyKey ?? `cancel-${loaded.command.id}`;
  const traceContext = params.correlationId
    ? { trace_id: params.correlationId, span_id: loaded.invocation.id }
    : null;

  const request: CancelInvocationRequest = {
    runtimeEndpoint,
    auth,
    invocationId: loaded.invocation.id,
    idempotencyKey: runtimeIdempotencyKey,
    requestBody: {
      reason,
      trace_context: traceContext,
    },
  };

  // 4. 调用 Runtime
  try {
    await params.runtimeClient.cancelInvocation(request);
  } catch (err) {
    return handleRuntimeError(err, loaded, params);
  }

  // 5. 成功：事务内 CAS dispatched → acknowledged
  // Turn 终态由 ingress execution.cancelled 推进（Runtime 通过 events:batch 上报）
  await db.transaction(async (tx) => {
    await transitionCommandToAcknowledged(tx, loaded.command.id);
  });

  return {
    commandId: loaded.command.id,
    commandState: "acknowledged",
    runtimeExecutionRef: undefined,
    acknowledgedAt: new Date(),
    events: [],
  };
}

// ─── dispatchResumeCommand ────────────────────────────────

/** Resume 执行入参（首次调度与 retry 共用）。 */
interface ResumeExecutionParams {
  tenantId: string;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
  /**
   * requires_redispatch=true 时使用的已加载 AgentRevision（用于构造 redispatch 的
   * StartInvocationRequestBody）。冻结架构下 ExecutionBinding 不再绑定 Agent，
   * 本字段为 Agent 层合法可选字段；未提供 → redispatch 不携带 Agent Revision。
   */
  agentRevision?: AgentRevision | null;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
  /**
   * 04 专项：Resume 每次真正 dispatch 前重建 Binding-frozen Invocation Context
   * （Harness dispatch 层构建；Transport 只做 wire 映射）。返回 null = 无 Agent
   * Contract（Base Harness）不携带；required context 缺失/被拒时抛错 → 命令标记
   * failed（fail closed，不发网络）。
   */
  resolveInvocationContext?: (loaded: {
    invocation: Invocation;
    binding: ExecutionBinding;
  }) => Promise<Array<{ context_kind: string; value: unknown }> | null>;
}

/**
 * 调度 Resume 命令到 Runtime（首次：queued → dispatched → 执行）。
 *
 * 关键约束：
 * - waiting_user 必须解析对应 UserActionRequest（Resume 携带 resume_payload）。
 * - Resume 不能新建 continuation Invocation（只恢复原 Invocation）；redispatch 同样不新建 Invocation。
 * - requires_redispatch=true 时必须有 gatewayEndpoints（用于 redispatch 的 startInvocation 调用）。
 *
 * @throws CommandNotFoundError 命令不存在或跨租户不可见
 * @throws CommandAlreadyDispatchedError 命令已调度
 * @throws CommandInvocationNotFoundError 关联 Invocation 不存在
 * @throws ResumeInvocationNotWaitingError Invocation 不在 waiting_user 状态
 */
export async function dispatchResumeCommand(params: {
  tenantId: string;
  commandId: string;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
  agentRevision?: AgentRevision | null;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
  resolveInvocationContext?: (loaded: {
    invocation: Invocation;
    binding: ExecutionBinding;
  }) => Promise<Array<{ context_kind: string; value: unknown }> | null>;
}): Promise<CommandDispatchResult> {
  const loaded = await loadCommandForDispatch(params.tenantId, params.commandId);

  if (loaded.command.commandType !== "resume") {
    throw new CommandAlreadyDispatchedError(loaded.command.id, loaded.command.commandType);
  }

  validateResumeInvocationState(loaded);

  // 1. 事务内 CAS queued → dispatched（含 dispatchAttemptCount=1 + lease）
  const transitioned = await db.transaction(async (tx) =>
    transitionCommandToDispatched(tx, loaded.command.id, null),
  );
  if (!transitioned) {
    throw new CommandAlreadyDispatchedError(loaded.command.id, "dispatched");
  }

  return executeResumeDispatch(
    {
      tenantId: params.tenantId,
      runtimeClient: params.runtimeClient,
      runtimeEndpointResolver: params.runtimeEndpointResolver,
      agentRevision: params.agentRevision,
      actorType: params.actorType,
      actorId: params.actorId,
      correlationId: params.correlationId,
      resolveInvocationContext: params.resolveInvocationContext,
    },
    loaded,
  );
}

/**
 * Durable Retry Worker 命令 lane 入口：对已 dispatched 的命令用同一 idempotency key
 * 重新发起 HTTP（领取由 dispatch-retry-queries.claimDueInvocationCommands 完成）。
 *
 * 与首次调度共用 executeXDispatch 核心；Resume 的 Invocation 状态校验放宽为：
 * waiting_user / post-authority running 之外（如已终态）→ 命令 failed（诚实终态，不重试）。
 */
export async function retryDispatchedInvocationCommand(params: {
  tenantId: string;
  commandId: string;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
  agentRevision?: AgentRevision | null;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
  resolveInvocationContext?: (loaded: {
    invocation: Invocation;
    binding: ExecutionBinding;
  }) => Promise<Array<{ context_kind: string; value: unknown }> | null>;
}): Promise<CommandDispatchResult> {
  const loaded = await loadCommand(params.tenantId, params.commandId, "dispatched");

  // bump-at-start：本次是第几次 HTTP（CAS 首发已置 1，此处为 retry 递增）。
  await recordCommandRetryAttemptStarted({ commandId: loaded.command.id, now: new Date() });

  if (loaded.command.commandType === "resume") {
    try {
      validateResumeInvocationState(loaded);
    } catch (err) {
      if (err instanceof ResumeInvocationNotWaitingError) {
        // Invocation 已推进到无法 Resume 的状态（如终态）→ 命令诚实 failed
        const errorCode = "RESUME_INVOCATION_STATE_INVALID";
        await markCommandFailed(loaded.command.id, errorCode, err.message);
        return {
          commandId: loaded.command.id,
          commandState: "failed",
          failedAt: new Date(),
          errorCode,
          errorMessage: err.message,
          events: [],
        };
      }
      throw err;
    }
    return executeResumeDispatch(
      {
        tenantId: params.tenantId,
        runtimeClient: params.runtimeClient,
        runtimeEndpointResolver: params.runtimeEndpointResolver,
        agentRevision: params.agentRevision,
        actorType: params.actorType,
        actorId: params.actorId,
        correlationId: params.correlationId,
        resolveInvocationContext: params.resolveInvocationContext,
      },
      loaded,
    );
  }

  if (loaded.command.commandType === "steer") {
    return executeSteerDispatch(
      {
        tenantId: params.tenantId,
        runtimeClient: params.runtimeClient,
        runtimeEndpointResolver: params.runtimeEndpointResolver,
        actorType: params.actorType,
        actorId: params.actorId,
        correlationId: params.correlationId,
      },
      loaded,
    );
  }

  if (loaded.command.commandType === "interrupt") {
    return executeCancelDispatch(
      {
        tenantId: params.tenantId,
        runtimeClient: params.runtimeClient,
        runtimeEndpointResolver: params.runtimeEndpointResolver,
        actorType: params.actorType,
        actorId: params.actorId,
        correlationId: params.correlationId,
      },
      loaded,
    );
  }

  throw new CommandAlreadyDispatchedError(loaded.command.id, loaded.command.commandType);
}

/** Resume 前置状态校验（waiting_user 或 post-authority running）。 */
function validateResumeInvocationState(loaded: LoadedCommand): void {
  const loadedPayload = loaded.command.commandPayloadJson as Record<string, unknown>;
  const isPostAuthorityResume =
    loaded.invocation.executionState === "running" &&
    loadedPayload.resume_source === "user_action_resolution" &&
    typeof loadedPayload.request_id === "string" &&
    loadedPayload.request_id.length > 0 &&
    loadedPayload.resume_payload !== null &&
    typeof loadedPayload.resume_payload === "object";

  if (loaded.invocation.executionState !== "waiting_user" && !isPostAuthorityResume) {
    throw new ResumeInvocationNotWaitingError(
      loaded.invocation.id,
      loaded.invocation.executionState,
    );
  }
}

/** Resume 命令执行核心（命令已处于 dispatched 状态；首次与 retry 共用）。 */
async function executeResumeDispatch(
  params: ResumeExecutionParams,
  loaded: LoadedCommand,
): Promise<CommandDispatchResult> {
  const actorType: ThreadEventActorType = params.actorType ?? "system";
  const loadedPayload = loaded.command.commandPayloadJson as Record<string, unknown>;
  const isPostAuthorityResume =
    loaded.invocation.executionState === "running" &&
    loadedPayload.resume_source === "user_action_resolution" &&
    typeof loadedPayload.request_id === "string" &&
    loadedPayload.request_id.length > 0 &&
    loadedPayload.resume_payload !== null &&
    typeof loadedPayload.resume_payload === "object";

  // 2. 解析 runtimeEndpoint + auth（+ 可选 gatewayEndpoints）
  const endpointResolution = await params.runtimeEndpointResolver(loaded.binding);
  const { runtimeEndpoint, auth } = endpointResolution;

  // 3. 构造 resume 请求
  // §27/§28：resume 必须携带重新签发的新 Gateway Access Token（新 jti/expiry，绑定 same
  // tenant/invocation/冻结 Binding），由 resolver 提供；缺失则拒绝（fail-closed，不能复用旧 token）。
  const gatewayAccess = endpointResolution.gatewayAccess;
  if (!gatewayAccess) {
    await markCommandFailed(
      loaded.command.id,
      "RESUME_GATEWAY_ACCESS_MISSING",
      "Resume 命令缺少重新签发的 Gateway Access Token",
    );
    return {
      commandId: loaded.command.id,
      commandState: "failed",
      failedAt: new Date(),
      errorCode: "RESUME_GATEWAY_ACCESS_MISSING",
      errorMessage: "Resume 命令缺少重新签发的 Gateway Access Token",
      events: [],
    };
  }
  const commandPayload = loaded.command.commandPayloadJson as Record<string, unknown>;
  const resumePayload = commandPayload.resume_payload ?? commandPayload;
  // 稳定 Runtime Idempotency-Key：同一 Command 的所有 retry 不换 key。
  const runtimeIdempotencyKey = loaded.command.idempotencyKey ?? `resume-${loaded.command.id}`;
  const traceContext = params.correlationId
    ? { trace_id: params.correlationId, span_id: loaded.invocation.id }
    : null;

  // 04 专项：网络前重建 Binding-frozen Context；required 缺失/被拒 → fail closed。
  let invocationContext: Array<{ context_kind: string; value: unknown }> | null = null;
  if (params.resolveInvocationContext) {
    try {
      invocationContext = await params.resolveInvocationContext({
        invocation: loaded.invocation,
        binding: loaded.binding,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await markCommandFailed(loaded.command.id, "RESUME_CONTEXT_UNAVAILABLE", errorMessage);
      return {
        commandId: loaded.command.id,
        commandState: "failed",
        failedAt: new Date(),
        errorCode: "RESUME_CONTEXT_UNAVAILABLE",
        errorMessage,
        events: [],
      };
    }
  }

  const request: ResumeInvocationRequest = {
    runtimeEndpoint,
    auth,
    invocationId: loaded.invocation.id,
    idempotencyKey: runtimeIdempotencyKey,
    requestBody: {
      resume_payload: resumePayload,
      trace_context: traceContext,
      gateway_access: gatewayAccess,
      ...(invocationContext && invocationContext.length > 0
        ? { invocation_context: invocationContext }
        : {}),
    },
  };

  // 4. 调用 Runtime
  let response: ResumeInvocationResponse;
  try {
    response = await params.runtimeClient.resumeInvocation(request);
  } catch (err) {
    return handleRuntimeError(err, loaded, params);
  }

  // 5. 检查 requires_redispatch 分支
  if (response.requires_redispatch === true) {
    if (isPostAuthorityResume) {
      // post-authority 分支 fail closed：不套用旧 waiting_user redispatch 路径，
      // 不伪造成功；命令标记 failed（无状态回退，Invocation/Turn 保持 sink 已落状态）。
      await markCommandFailed(
        loaded.command.id,
        "RESUME_POST_AUTHORITY_REDISPATCH_UNSUPPORTED",
        "post-authority Resume 不支持 requires_redispatch=true",
      );
      return {
        commandId: loaded.command.id,
        commandState: "failed",
        failedAt: new Date(),
        errorCode: "RESUME_POST_AUTHORITY_REDISPATCH_UNSUPPORTED",
        errorMessage: "post-authority Resume 不支持 requires_redispatch=true",
        events: [],
      };
    }
    return await handleResumeRequiresRedispatch(params, loaded, endpointResolution, actorType);
  }

  // 6a. post-authority 成功：只 CAS dispatched → acknowledged。transport 的
  // eventBatchSink 可能已把 Invocation/Turn 推进到 completed/failed/waiting_user 等
  // 状态；本分支绝不回写 running、绝不补 turn.resumed/invocation.resumed 事件。
  if (isPostAuthorityResume) {
    await db.transaction(async (tx) => {
      await transitionCommandToAcknowledged(tx, loaded.command.id);
    });
    return {
      commandId: loaded.command.id,
      commandState: "acknowledged",
      runtimeExecutionRef: undefined,
      acknowledgedAt: new Date(),
      events: [],
    };
  }

  // 6. 成功（requires_redispatch=false/undefined）：事务内 CAS dispatched → acknowledged
  // + Invocation waiting_user → running
  // + CAS Turn waiting_user → running
  // + 写 turn.resumed + invocation.resumed Event
  const threadId = loaded.invocation.threadId;
  const turnId = loaded.command.turnId ?? loaded.invocation.turnId;

  const events = await db.transaction(async (tx) => {
    if (!threadId) {
      throw new CommandInvocationNotFoundError(loaded.invocation.id);
    }

    // 锁定 Thread 行
    const [thread] = await tx
      .select({ id: threadTable.id })
      .from(threadTable)
      .where(eq(threadTable.id, threadId))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new CommandInvocationNotFoundError(loaded.invocation.id);
    }

    // CAS dispatched → acknowledged
    await transitionCommandToAcknowledged(tx, loaded.command.id);

    // Invocation waiting_user → running（仅当仍处于 waiting_user；transport 的
    // eventBatchSink 可能已在网络调用期间把 Invocation 推进到终态，不得回退）
    const [invRowForResume] = await tx
      .select({ state: invocationTable.executionState })
      .from(invocationTable)
      .where(eq(invocationTable.id, loaded.invocation.id))
      .for("update")
      .limit(1);
    if (invRowForResume?.state === "waiting_user") {
      await updateInvocationState(tx, params.tenantId, loaded.invocation.id, "running");
    }

    // CAS Turn waiting_user → running（仅在 turnId 存在且 Turn 处于 waiting_user 时）
    if (turnId) {
      const [turnRow] = await tx
        .select()
        .from(turnTable)
        .where(eq(turnTable.id, turnId))
        .for("update")
        .limit(1);
      if (turnRow && turnRow.turnState === "waiting_user") {
        await tx
          .update(turnTable)
          .set({
            turnState: "running",
            versionNo: turnRow.versionNo + 1,
          })
          .where(eq(turnTable.id, turnId));
      }
    }

    // 写 turn.resumed + invocation.resumed Event（2 个事件，原子分配 sequence）
    // ack 事件使用派生唯一 key（不复用命令的 idempotencyKey，避免与 turn.steer_queued 等队列事件冲突）
    const writtenEvents: ThreadEvent[] = [];
    const startSeq = await allocateEventSequences(tx, threadId, 2);

    if (turnId) {
      const turnResumedEvent = await insertThreadEvent(tx, threadId, startSeq, {
        eventType: "turn.resumed",
        turnId,
        invocationId: loaded.invocation.id,
        actorType,
        actorId: params.actorId ?? undefined,
        payload: {
          command_id: loaded.command.id,
          invocation_id: loaded.invocation.id,
          runtime_acknowledged: true,
        },
        correlationId: params.correlationId ?? undefined,
        idempotencyKey: `resume-ack-turn-${loaded.command.id}`,
      });
      writtenEvents.push(turnResumedEvent);
    }

    const invocationResumedEvent = await insertThreadEvent(tx, threadId, startSeq + 1, {
      eventType: "invocation.resumed",
      turnId: turnId ?? undefined,
      invocationId: loaded.invocation.id,
      actorType,
      actorId: params.actorId ?? undefined,
      payload: {
        command_id: loaded.command.id,
        resume_payload_present: resumePayload !== null && resumePayload !== undefined,
        runtime_acknowledged: true,
      },
      correlationId: params.correlationId ?? undefined,
      idempotencyKey: `resume-ack-inv-${loaded.command.id}`,
    });
    writtenEvents.push(invocationResumedEvent);

    return writtenEvents;
  });

  return {
    commandId: loaded.command.id,
    commandState: "acknowledged",
    runtimeExecutionRef: undefined,
    acknowledgedAt: new Date(),
    events,
  };
}

/**
 * 处理 Runtime 返回 requires_redispatch=true 的 Resume 响应。
 *
 * 事实源：docs/architecture/api-and-events.md L924-928、
 * docs/architecture/persistence.md §13（Worker 失联恢复）。
 *
 * 流程：
 * 1. 解析 AgentRevision（在任何 Command/Invocation/Turn/Event/Attempt 写入之前）：
 * 冻结架构下 ExecutionBinding 不再绑定 Agent，直接采用调用方已加载的
 * params.agentRevision（可选，Agent 层合法字段；未提供 → null）。
 * 2. 事务内：CAS dispatched → acknowledged + CAS Turn waiting_user → running +
 * 写 turn.resumed Event（带 redispatched=true 标记）。不写 invocation.resumed Event
 * （因为不是简单恢复，而是重新调度）。
 * 3. 调用 redispatchInvocation（组合函数：创建 queued Attempt + dispatchQueuedInvocationAttempt）。
 * 4. 返回组合事件（turn.resumed + invocation.started）。
 */
async function handleResumeRequiresRedispatch(
  params: {
    tenantId: string;
    runtimeClient: RuntimeHttpClient;
    agentRevision?: AgentRevision | null;
    actorType?: ThreadEventActorType;
    actorId?: string | null;
    correlationId?: string | null;
  },
  loaded: LoadedCommand,
  endpointResolution: CommandRuntimeEndpointResolution,
  actorType: ThreadEventActorType,
): Promise<CommandDispatchResult> {
  const threadId = loaded.invocation.threadId;
  const turnId = loaded.command.turnId ?? loaded.invocation.turnId;

  // 校验 gatewayEndpoints 可用（redispatch 需要）
  if (!endpointResolution.gatewayEndpoints) {
    // gatewayEndpoints 缺失：标记命令 failed（不能处理 redispatch）
    await markCommandFailed(
      loaded.command.id,
      "REDISPATCH_GATEWAY_ENDPOINTS_MISSING",
      "Runtime 返回 requires_redispatch=true 但未提供 gatewayEndpoints 解析器",
    );
    return {
      commandId: loaded.command.id,
      commandState: "failed",
      failedAt: new Date(),
      errorCode: "REDISPATCH_GATEWAY_ENDPOINTS_MISSING",
      errorMessage: "Runtime 返回 requires_redispatch=true 但未提供 gatewayEndpoints 解析器",
      events: [],
    };
  }
  const gatewayEndpoints = endpointResolution.gatewayEndpoints;

  // 1. 解析 AgentRevision：冻结架构下 ExecutionBinding 不再绑定 Agent，
  // 无 binding 侧权威可校验；直接采用调用方已加载的 AgentRevision（可选，Agent 层合法字段）。
  // 必须在任何 Command/Invocation/Turn/Event/Attempt 写入之前完成。
  const agentRevision = params.agentRevision ?? null;

  // 2. 事务内：CAS dispatched → acknowledged + CAS Turn waiting_user → running + 写 turn.resumed Event
  const turnResumedEvent = await db.transaction(async (tx) => {
    if (!threadId) {
      throw new CommandInvocationNotFoundError(loaded.invocation.id);
    }

    // 锁定 Thread 行
    const [thread] = await tx
      .select({ id: threadTable.id })
      .from(threadTable)
      .where(eq(threadTable.id, threadId))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new CommandInvocationNotFoundError(loaded.invocation.id);
    }

    // CAS dispatched → acknowledged
    await transitionCommandToAcknowledged(tx, loaded.command.id);

    // CAS Turn waiting_user → running（不更新 Invocation 状态，由 redispatchInvocation 处理）
    if (turnId) {
      const [turnRow] = await tx
        .select()
        .from(turnTable)
        .where(eq(turnTable.id, turnId))
        .for("update")
        .limit(1);
      if (turnRow && turnRow.turnState === "waiting_user") {
        await tx
          .update(turnTable)
          .set({
            turnState: "running",
            versionNo: turnRow.versionNo + 1,
          })
          .where(eq(turnTable.id, turnId));
      }
    }

    // 写 turn.resumed Event（带 redispatched=true 标记，仅 1 个事件；invocation.started 由 redispatch 写入）
    const seq = await allocateEventSequences(tx, threadId, 1);
    if (!turnId) {
      return null;
    }
    return insertThreadEvent(tx, threadId, seq, {
      eventType: "turn.resumed",
      turnId,
      invocationId: loaded.invocation.id,
      actorType,
      actorId: params.actorId ?? undefined,
      payload: {
        command_id: loaded.command.id,
        invocation_id: loaded.invocation.id,
        runtime_acknowledged: true,
        redispatched: true,
        requires_redispatch: true,
      },
      correlationId: params.correlationId ?? undefined,
      idempotencyKey: `resume-ack-turn-redispatch-${loaded.command.id}`,
    });
  });

  // 3. 调用 redispatchInvocation（创建 queued Attempt + 调用 Runtime startInvocation + 写 invocation.started Event）
  const redispatchResult = await redispatchInvocation({
    tenantId: params.tenantId,
    invocationId: loaded.invocation.id,
    retryReasonCode: "requires_redispatch",
    checkpointRef: null,
    runtimeClient: params.runtimeClient,
    runtimeEndpointResolver: async () => {
      const governanceConfig = endpointResolution.governanceConfig;
      const gatewayAccess = endpointResolution.gatewayAccess;
      if (!governanceConfig || !gatewayAccess) {
        throw new Error(
          "handleResumeRequiresRedispatch: 缺少 governanceConfig/gatewayAccess 无法重调度",
        );
      }
      return {
        runtimeEndpoint: endpointResolution.runtimeEndpoint,
        auth: endpointResolution.auth,
        gatewayEndpoints,
        governanceConfig,
        gatewayAccess,
      };
    },
    runtimeRevisionId: loaded.binding.runtimeRevisionId,
    agentRevision,
    actorType,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
  });

  // 4. 返回组合事件
  const events: ThreadEvent[] = [];
  if (turnResumedEvent) {
    events.push(turnResumedEvent);
  }
  if (redispatchResult.invocationStartedEvent) {
    events.push(redispatchResult.invocationStartedEvent);
  }

  return {
    commandId: loaded.command.id,
    commandState: "acknowledged",
    runtimeExecutionRef: redispatchResult.invocation?.runtimeExecutionRef ?? undefined,
    acknowledgedAt: new Date(),
    events,
    redispatched: redispatchResult.redispatched,
  };
}

// ─── Runtime 错误处理（公共） ─────────────────────────────

/**
 * 处理 Runtime HTTP 调用错误。
 *
 * 错误分类（与 dispatcher.ts dispatchToRuntime 一致）：
 * - kind=network / HTTP 503（含 A2A stream_interrupted）→ 保持 dispatched + 排定 durable
 *   retry（nextDispatchAt = now + backoff；耗尽 → failed(retry_exhausted)，
 *   Resume 命令由唯一 Recovery Authority（markInvocationLost）收口）。
 * - kind=http + 409 IDEMPOTENCY_CONFLICT → 标记 acknowledged（幂等复用）。
 * - 其他 → 标记 failed（Runtime 拒绝，不伪造成功）。
 */
async function handleRuntimeError(
  err: unknown,
  loaded: LoadedCommand,
  params: {
    tenantId: string;
    actorType?: ThreadEventActorType;
    actorId?: string | null;
    correlationId?: string | null;
  },
): Promise<CommandDispatchResult> {
  const commandId = loaded.command.id;
  const now = new Date();

  /** transient 分支：排定 durable retry 或耗尽收口。 */
  const handleTransient = async (
    skipReason: "runtime_network_unavailable" | "runtime_unavailable",
  ): Promise<CommandDispatchResult> => {
    const outcome = await scheduleCommandTransientRetry({
      commandId,
      errorCode: skipReason,
      now,
    });
    if (outcome.outcome === "exhausted") {
      // 耗尽：Resume → 唯一 Recovery Authority 收口（Turn failed）；
      // Steer → 原 Invocation 继续；Cancel → 由现有 cancel 状态机决定，不伪造 cancelled。
      if (
        loaded.command.commandType === "resume" &&
        !INVOCATION_TERMINAL_STATES_SET.has(loaded.invocation.executionState) &&
        loaded.invocation.executionState !== "cancelled"
      ) {
        await markInvocationLost({
          tenantId: params.tenantId,
          invocationId: loaded.invocation.id,
          reasonCode: "resume_retry_exhausted",
          errorSummary: `Resume command retry exhausted（lastTransient=${skipReason}）`,
          actorType: params.actorType,
          actorId: params.actorId ?? null,
          correlationId: params.correlationId ?? null,
        });
      }
      return {
        commandId,
        commandState: "failed",
        skipped: true,
        skipReason,
        retryExhausted: true,
        failedAt: now,
        errorCode: "retry_exhausted",
        errorMessage: `Dispatch retry exhausted（lastTransient=${skipReason}）`,
        events: [],
      };
    }
    return {
      commandId,
      commandState: "dispatched",
      skipped: true,
      skipReason,
      pendingRetry: {
        nextDispatchAt: outcome.nextDispatchAt,
        dispatchAttemptCount: outcome.dispatchAttemptCount,
      },
      events: [],
    };
  };

  // 03 专项：A2A Transport 网络不可达/503（stream_interrupted，jsonRpc 出口）→
  // 保持 dispatched + durable retry，与 RuntimeHttpClientError network 分支同语义，
  // 不判终态 failed。resume/cancel 的同步 jsonRpc 只在不可达/503 抛该 kind。
  if (err instanceof RuntimeTransportError && err.kind === "stream_interrupted") {
    return handleTransient("runtime_network_unavailable");
  }
  if (err instanceof RuntimeHttpClientError) {
    // 网络不可达 → durable retry
    if (err.kind === "network") {
      return handleTransient("runtime_network_unavailable");
    }
    // 503 RUNTIME_UNAVAILABLE → durable retry
    if (err.kind === "http" && err.httpStatus === 503) {
      return handleTransient("runtime_unavailable");
    }
    // 409 IDEMPOTENCY_CONFLICT → 幂等复用，标记 acknowledged
    if (
      err.kind === "http" &&
      err.httpStatus === 409 &&
      err.runtimeErrorCode === "IDEMPOTENCY_CONFLICT"
    ) {
      await markCommandAcknowledged(commandId);
      return {
        commandId,
        commandState: "acknowledged",
        acknowledgedAt: new Date(),
        events: [],
      };
    }
    // 其他 HTTP 错误 → 标记 failed（Runtime 拒绝，不伪造成功）
    const errorCode = err.runtimeErrorCode ?? `HTTP_${err.httpStatus ?? 0}`;
    await markCommandFailed(commandId, errorCode, err.message);
    return {
      commandId,
      commandState: "failed",
      failedAt: new Date(),
      errorCode,
      errorMessage: err.message,
      events: [],
    };
  }
  // 非 RuntimeHttpClientError → 标记 failed
  const errorMessage = err instanceof Error ? err.message : String(err);
  await markCommandFailed(commandId, "UNKNOWN", errorMessage);
  return {
    commandId,
    commandState: "failed",
    failedAt: new Date(),
    errorCode: "UNKNOWN",
    errorMessage,
    events: [],
  };
}

/** Invocation 终态集合（resume 耗尽收口前的非终态判断）。 */
const INVOCATION_TERMINAL_STATES_SET = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "lost",
]);
